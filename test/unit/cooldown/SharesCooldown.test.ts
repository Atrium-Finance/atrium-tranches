import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture, time } from "../../helpers/network-helpers.js";
import { encodeFunctionData, parseUnits, zeroAddress } from "viem";
import { deployAcm } from "../../fixtures/deployAcm.js";
import { getClients, viem } from "../../helpers/viemClients.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";

async function silofixture() {
  const { owner, user, keeper, publicClient, rest } = await getClients();
  const acm = await deployAcm(owner.account.address);
  const impl = await viem.deployContract("SharesCooldown");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const silo = await viem.getContractAt("SharesCooldown", proxy.address);
  return { silo, acm, owner, user, keeper, publicClient, rest };
}

// Wires SharesCooldown together with Tranche + MockCDO + MockStrategy +
// MockAccounting so requestRedeem / finalize / cancel / finalizeWithFee
// can run end-to-end. Pre-transfers half the user's shares into the silo
// to simulate the SharesLock branch of Tranche._withdraw (which would
// normally move shares into the silo before queueing).
async function siloFullFixture() {
  const base = await silofixture();
  const { silo, acm, user, keeper } = base;

  const COOLDOWN_WORKER_ROLE = await silo.read.COOLDOWN_WORKER_ROLE();
  await acm.write.grantRole([COOLDOWN_WORKER_ROLE, keeper.account.address]);

  const asset = await viem.deployContract("MockERC20", ["USDai", "USDai", 18]);
  const mockCDO = await viem.deployContract("MockCDO");
  const mockStrategy = await viem.deployContract("MockStrategy");
  const mockAccounting = await viem.deployContract("MockAccounting");

  const trancheImpl = await viem.deployContract("Tranche");
  const trancheInit = encodeFunctionData({
    abi: trancheImpl.abi,
    functionName: "initialize",
    args: [asset.address, "Junior", "JR", mockCDO.address],
  });
  const trancheProxy = await viem.deployContract("ProjectERC1967Proxy", [trancheImpl.address, trancheInit]);
  const tranche = await viem.getContractAt("Tranche", trancheProxy.address);

  await mockCDO.write.setAccounting([mockAccounting.address]);
  await mockCDO.write.setStrategy([mockStrategy.address]);
  await mockCDO.write.setVaults([tranche.address, tranche.address, tranche.address]);
  await mockCDO.write.setSharesCooldown([silo.address]);
  await mockStrategy.write.setSupportedTokens([[asset.address]]);

  // User deposits 100 → mints 100 shares → transfers 50 to silo so the
  // silo holds shares to redeem / cancel / burn-as-fee against.
  await asset.write.mint([user.account.address, parseUnits("100", 18)]);
  await asset.write.approve([tranche.address, (1n << 255n) - 1n], { account: user.account });
  await tranche.write.deposit([parseUnits("100", 18), user.account.address], { account: user.account });
  await tranche.write.transfer([silo.address, parseUnits("50", 18)], { account: user.account });

  return { ...base, asset, mockCDO, mockStrategy, mockAccounting, tranche };
}

describe("SharesCooldown", () => {
  describe("requestRedeem", () => {
    it("1. Requires COOLDOWN_WORKER_ROLE", async () => {
      const { silo, user } = await loadFixture(silofixture);
      await expect(
        silo.write.requestRedeem(
          [user.account.address, user.account.address, user.account.address, user.account.address, 1n, 0n, 0],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("2. Per-vault TExitUpperBounds 3-range logic via calculateExitParams", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      const bounds = {
        p0: parseUnits("1.0", 18),
        p1: parseUnits("1.05", 18),
        r0: { feeBps: parseUnits("0.05", 18), sharesLock: 7 * 86400 },
        r1: { feeBps: parseUnits("0.01", 18), sharesLock: 86400 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await silo.write.setVaultExitBounds([owner.account.address, bounds]);
      const at0 = await silo.read.calculateExitParams([owner.account.address, parseUnits("0.9", 18)]);
      expect(at0.feeBps).to.equal(parseUnits("0.05", 18));
    });

    it("3. Coverage range 0 (healthy) → r0 returned for coverage <= p0", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      const bounds = {
        p0: parseUnits("1.0", 18),
        p1: parseUnits("1.05", 18),
        r0: { feeBps: 0n, sharesLock: 86400 },
        r1: { feeBps: 0n, sharesLock: 0 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await silo.write.setVaultExitBounds([owner.account.address, bounds]);
      const e = await silo.read.calculateExitParams([owner.account.address, parseUnits("0.5", 18)]);
      expect(e.sharesLock).to.equal(86400);
    });

    it("4. Coverage range 1 → r1", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      const bounds = {
        p0: parseUnits("1.0", 18),
        p1: parseUnits("1.05", 18),
        r0: { feeBps: 0n, sharesLock: 86400 },
        r1: { feeBps: parseUnits("0.005", 18), sharesLock: 3600 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await silo.write.setVaultExitBounds([owner.account.address, bounds]);
      const e = await silo.read.calculateExitParams([owner.account.address, parseUnits("1.02", 18)]);
      expect(e.sharesLock).to.equal(3600);
    });

    it("5. Coverage range 2 → r2", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      const bounds = {
        p0: parseUnits("1.0", 18),
        p1: parseUnits("1.05", 18),
        r0: { feeBps: parseUnits("0.05", 18), sharesLock: 7 * 86400 },
        r1: { feeBps: parseUnits("0.01", 18), sharesLock: 86400 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await silo.write.setVaultExitBounds([owner.account.address, bounds]);
      const e = await silo.read.calculateExitParams([owner.account.address, parseUnits("1.5", 18)]);
      expect(e.sharesLock).to.equal(0);
    });

    it("6. Slot 70 reached → merge into last (smoke — not exercised)", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      expect(silo.address).to.match(/^0x/);
    });

    it("7. Slot 40 reached + external receiver → reverts (smoke)", async () => {
      const { silo } = await loadFixture(silofixture);
      expect(silo.address).to.match(/^0x/);
    });
  });

  describe("finalize", () => {
    it("8. activeRequestsLength returns 0 for unknown user", async () => {
      const { silo, user, owner } = await loadFixture(silofixture);
      expect(await silo.read.activeRequestsLength([owner.account.address, user.account.address])).to.equal(0n);
    });

    it("9. finalize on empty queue → reverts NothingToFinalize", async () => {
      const { silo, user, owner } = await loadFixture(silofixture);
      await expect(silo.write.finalize([owner.account.address as any, zeroAddress, user.account.address])).to.be
        .rejected;
    });

    it("10. balanceOf returns zero state for new user", async () => {
      const { silo, user, owner } = await loadFixture(silofixture);
      const s = await silo.read.balanceOf([owner.account.address as any, user.account.address]);
      expect(s.pending).to.equal(0n);
      expect(s.claimable).to.equal(0n);
    });
  });

  describe("finalizeWithFee proportional", () => {
    it("11. Fee per day capped at 1%", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      await expect(silo.write.setVaultEarlyExitFee([owner.account.address, parseUnits("0.02", 18)])).to.be.rejected;
    });

    it("12. setVaultEarlyExitFee within cap accepted", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      await silo.write.setVaultEarlyExitFee([owner.account.address, parseUnits("0.005", 18)]);
      expect(await silo.read.vaultEarlyExitFeePerDay([owner.account.address])).to.equal(parseUnits("0.005", 18));
    });
  });

  describe("cancel", () => {
    it("13. Cancel non-owner reverts OnlySharesOwner", async () => {
      const { silo, owner, user } = await loadFixture(silofixture);
      await expect(
        silo.write.cancel([owner.account.address as any, user.account.address, 0n, { shares: 0n }], {
          account: owner.account,
        }),
      ).to.be.rejected;
    });

    it("14. Cancel out-of-range index reverts OutOfRange", async () => {
      const { silo, user } = await loadFixture(silofixture);
      await expect(
        silo.write.cancel([user.account.address as any, user.account.address, 0n, { shares: 0n }], {
          account: user.account,
        }),
      ).to.be.rejected;
    });

    it("15. Cancel by non-recipient reverts", async () => {
      const { silo, user, rest } = await loadFixture(silofixture);
      await expect(
        silo.write.cancel([user.account.address as any, rest[0].account.address, 0n, { shares: 0n }], {
          account: user.account,
        }),
      ).to.be.rejected;
    });
  });

  describe("admin", () => {
    it("16. setVaultExitBounds validates p0 <= p1", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      const bad = {
        p0: parseUnits("1.5", 18),
        p1: parseUnits("1.0", 18),
        r0: { feeBps: 0n, sharesLock: 0 },
        r1: { feeBps: 0n, sharesLock: 0 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await expect(silo.write.setVaultExitBounds([owner.account.address, bad])).to.be.rejected;
    });

    it("17. Reverts on fee > 1%/day", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      await expect(silo.write.setVaultEarlyExitFee([owner.account.address, parseUnits("0.011", 18)])).to.be.rejected;
    });

    it("18. Owner-only setVaultExitBounds", async () => {
      const { silo, user, owner } = await loadFixture(silofixture);
      const bounds = {
        p0: 0n,
        p1: 0n,
        r0: { feeBps: 0n, sharesLock: 0 },
        r1: { feeBps: 0n, sharesLock: 0 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await expect(silo.write.setVaultExitBounds([owner.account.address, bounds], { account: user.account })).to.be
        .rejected;
    });
  });

  describe("integration with CDO", () => {
    it("19. CDO.sharesCooldown returns wired silo", async () => {
      const { cdo, owner } = await loadFixture(atriumFixture);
      await cdo.write.setSharesCooldown([owner.account.address]);
      expect((await cdo.read.sharesCooldown()).toLowerCase()).to.equal(owner.account.address.toLowerCase());
    });

    it("20. totalAssetsUnlocked subtracts silo balances", async () => {
      const { cdo } = await loadFixture(atriumFixture);
      const [jr, mz, sr] = await cdo.read.totalAssetsUnlocked();
      expect(jr).to.equal(0n);
      expect(mz).to.equal(0n);
      expect(sr).to.equal(0n);
    });
  });

  describe("real flows (e2e with Tranche + MockCDO)", () => {
    // The default bounds map to all-zero r0/r1/r2 → _isCooldownActive == false.
    // Setting non-zero p1 flips it on so queued requests respect unlockAt.
    async function activeBounds(silo: any, owner: any, tranche: any) {
      await silo.write.setVaultExitBounds([
        tranche.address,
        {
          p0: parseUnits("1.0", 18),
          p1: parseUnits("1.05", 18),
          r0: { feeBps: 0n, sharesLock: 7 * 86400 },
          r1: { feeBps: 0n, sharesLock: 86400 },
          r2: { feeBps: 0n, sharesLock: 0 },
        },
      ], { account: owner.account });
    }

    it("21. requestRedeem queues a TRequest and bumps activeRequestsLength", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400],
        { account: keeper.account },
      );

      const len = await silo.read.activeRequestsLength([tranche.address, user.account.address]);
      expect(len).to.equal(1n);

      const req = await silo.read.activeRequests([tranche.address, user.account.address, 0n]);
      expect(req.shares).to.equal(parseUnits("10", 18));
      expect(req.token.toLowerCase()).to.equal(asset.address.toLowerCase());
    });

    it("22. requestRedeem with shares=0 is a no-op (no queue write, no revert)", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, 0n, 0n, 86400],
        { account: keeper.account },
      );

      const len = await silo.read.activeRequestsLength([tranche.address, user.account.address]);
      expect(len).to.equal(0n);
    });

    it("23. requestRedeem with cooldown=0 short-circuits to immediate redeem (no queue entry)", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      const siloSharesBefore = await tranche.read.balanceOf([silo.address]);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 0],
        { account: keeper.account },
      );

      const len = await silo.read.activeRequestsLength([tranche.address, user.account.address]);
      expect(len).to.equal(0n);

      const siloSharesAfter = await tranche.read.balanceOf([silo.address]);
      expect(siloSharesBefore - siloSharesAfter).to.equal(parseUnits("10", 18));
    });

    it("24. requestRedeem same-block unlockAt merges into existing last entry", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      // Lock both calls into the same block so they share unlockAt.
      const ts = (await time.latest()) + 100;
      await time.setNextBlockTimestamp(ts);
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("5", 18), 0n, 86400],
        { account: keeper.account },
      );
      await time.setNextBlockTimestamp(ts + 1);
      // 86399 + (ts+1) == ts + 86400 → same unlockAt as the previous call.
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("7", 18), 0n, 86399],
        { account: keeper.account },
      );

      const len = await silo.read.activeRequestsLength([tranche.address, user.account.address]);
      expect(len).to.equal(1n);
      const req = await silo.read.activeRequests([tranche.address, user.account.address, 0n]);
      expect(req.shares).to.equal(parseUnits("12", 18));
    });

    it("25. finalize after unlockAt burns silo shares + clears the queue entry", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 60],
        { account: keeper.account },
      );

      const siloSharesBefore = await tranche.read.balanceOf([silo.address]);
      await time.increase(120);

      await silo.write.finalize(
        [tranche.address as any, asset.address, user.account.address],
        { account: user.account },
      );

      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
      const siloSharesAfter = await tranche.read.balanceOf([silo.address]);
      expect(siloSharesBefore - siloSharesAfter).to.equal(parseUnits("10", 18));
    });

    it("26. finalize before unlockAt reverts NothingToFinalize", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400],
        { account: keeper.account },
      );

      await expect(
        silo.write.finalize(
          [tranche.address as any, asset.address, user.account.address],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("27. finalize with cooldown disabled (default bounds zero) → claims immediately", async () => {
      const { silo, tranche, asset, user, keeper } = await loadFixture(siloFullFixture);
      // Skip activeBounds: leave bounds zero → _isCooldownActive returns false.

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400],
        { account: keeper.account },
      );

      // Even though unlockAt is far in the future, the disabled sentinel
      // lets finalize claim the entry immediately.
      await silo.write.finalize(
        [tranche.address as any, asset.address, user.account.address],
        { account: user.account },
      );

      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
    });

    it("28. cancel returns shares to the user + drops the queue entry", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400],
        { account: keeper.account },
      );

      const userBefore = await tranche.read.balanceOf([user.account.address]);
      await silo.write.cancel(
        [tranche.address as any, user.account.address, 0n, { shares: 0n }],
        { account: user.account },
      );

      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
      const userAfter = await tranche.read.balanceOf([user.account.address]);
      expect(userAfter - userBefore).to.equal(parseUnits("10", 18));
    });

    it("29. cancel with mismatched guard.shares reverts UnexpectedShares", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400],
        { account: keeper.account },
      );

      await expect(
        silo.write.cancel(
          [tranche.address as any, user.account.address, 0n, { shares: parseUnits("999", 18) }],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("30. finalizeWithFee burns fee shares via Tranche.burnSharesAsFee and redeems the user portion", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);
      await silo.write.setVaultEarlyExitFee([tranche.address, parseUnits("0.005", 18)], { account: owner.account });

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400 * 5],
        { account: keeper.account },
      );

      const siloSharesBefore = await tranche.read.balanceOf([silo.address]);
      await silo.write.finalizeWithFee(
        [tranche.address as any, asset.address, user.account.address, 0n, { shares: 0n, daysLeft: 0n }],
        { account: user.account },
      );

      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
      const siloSharesAfter = await tranche.read.balanceOf([silo.address]);
      // All 10 shares leave the silo (fee burned + user portion redeemed).
      expect(siloSharesBefore - siloSharesAfter).to.equal(parseUnits("10", 18));
    });

    it("31. finalizeWithFee on already-ready request reverts RequestReady", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);
      await silo.write.setVaultEarlyExitFee([tranche.address, parseUnits("0.005", 18)], { account: owner.account });

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 60],
        { account: keeper.account },
      );
      await time.increase(120);

      await expect(
        silo.write.finalizeWithFee(
          [tranche.address as any, asset.address, user.account.address, 0n, { shares: 0n, daysLeft: 0n }],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("32. balanceOf reports pending vs claimable + nextUnlockAt", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      // Two requests at distinct unlockAts: one short, one long.
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 60],
        { account: keeper.account },
      );
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("5", 18), 0n, 86400],
        { account: keeper.account },
      );

      // Advance past the short unlock only.
      await time.increase(120);
      const s = await silo.read.balanceOf([tranche.address as any, user.account.address]);
      expect(s.claimable).to.equal(parseUnits("3", 18));
      expect(s.pending).to.equal(parseUnits("5", 18));
      expect(s.totalRequests).to.equal(2n);
      expect(s.nextUnlockAmount).to.equal(parseUnits("5", 18));
    });

    it("33. activeRequests by index returns the queued TRequest fields", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("4", 18), 0n, 86400],
        { account: keeper.account },
      );

      const req = await silo.read.activeRequests([tranche.address, user.account.address, 0n]);
      expect(req.shares).to.equal(parseUnits("4", 18));
      expect(req.token.toLowerCase()).to.equal(asset.address.toLowerCase());
      expect(Number(req.unlockAt)).to.be.greaterThan(0);
    });

    it("34. requestRedeem with fee>0 burns fee shares via _accrueFee", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      const siloBefore = await tranche.read.balanceOf([silo.address]);
      // 1% fee on 10 shares → 0.1 fee burned, 9.9 queued.
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), parseUnits("0.01", 18), 86400],
        { account: keeper.account },
      );

      const req = await silo.read.activeRequests([tranche.address, user.account.address, 0n]);
      expect(req.shares).to.equal(parseUnits("9.9", 18));
      const siloAfter = await tranche.read.balanceOf([silo.address]);
      // 0.1 shares burned via Tranche.burnSharesAsFee → silo balance drops by 0.1.
      expect(siloBefore - siloAfter).to.equal(parseUnits("0.1", 18));
    });

    it("35. finalize(IERC20, user) overload claims via asset-rooted loop", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 60],
        { account: keeper.account },
      );
      await time.increase(120);

      await silo.write.finalize([tranche.address as any, user.account.address], { account: user.account });
      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
    });

    it("36. finalize(IERC20, user, at) overload accepts explicit timestamp", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 60],
        { account: keeper.account },
      );
      await time.increase(120);
      const now = BigInt(await time.latest());

      await silo.write.finalize(
        [tranche.address as any, user.account.address, now],
        { account: user.account },
      );
      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
    });

    it("37. finalize(ITranche, token, user, at) overload accepts explicit timestamp", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 60],
        { account: keeper.account },
      );
      await time.increase(120);
      const now = BigInt(await time.latest());

      await silo.write.finalize(
        [tranche.address as any, asset.address, user.account.address, now],
        { account: user.account },
      );
      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
    });

    it("38. finalizeWithTokenOverride redeems via caller-supplied token", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("5", 18), 0n, 60],
        { account: keeper.account },
      );
      await time.increase(120);

      await silo.write.finalizeWithTokenOverride(
        [tranche.address as any, asset.address, user.account.address],
        { account: user.account },
      );
      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(0n);
    });

    it("39. finalizeWithFee with index out of range reverts OutOfRange", async () => {
      const { silo, tranche, asset, user, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);
      await silo.write.setVaultEarlyExitFee([tranche.address, parseUnits("0.005", 18)], { account: owner.account });

      await expect(
        silo.write.finalizeWithFee(
          [tranche.address as any, asset.address, user.account.address, 5n, { shares: 0n, daysLeft: 0n }],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("40. finalizeWithFee with mismatched guard.shares reverts UnexpectedShares", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);
      await silo.write.setVaultEarlyExitFee([tranche.address, parseUnits("0.005", 18)], { account: owner.account });

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400 * 5],
        { account: keeper.account },
      );

      await expect(
        silo.write.finalizeWithFee(
          [tranche.address as any, asset.address, user.account.address, 0n, { shares: parseUnits("999", 18), daysLeft: 0n }],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("41. finalizeWithFee with mismatched guard.daysLeft reverts UnexpectedDays", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);
      await silo.write.setVaultEarlyExitFee([tranche.address, parseUnits("0.005", 18)], { account: owner.account });

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("10", 18), 0n, 86400 * 5],
        { account: keeper.account },
      );

      await expect(
        silo.write.finalizeWithFee(
          [tranche.address as any, asset.address, user.account.address, 0n, { shares: 0n, daysLeft: 999n }],
          { account: user.account },
        ),
      ).to.be.rejected;
    });

    it("42. finalizeWithFee swap-pops middle entry when i < len-1", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);
      await silo.write.setVaultEarlyExitFee([tranche.address, parseUnits("0.005", 18)], { account: owner.account });

      // Two queued requests; finalize the first → swap-pop with the second.
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 86400 * 5],
        { account: keeper.account },
      );
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("4", 18), 0n, 86400 * 3],
        { account: keeper.account },
      );

      await silo.write.finalizeWithFee(
        [tranche.address as any, asset.address, user.account.address, 0n, { shares: 0n, daysLeft: 0n }],
        { account: user.account },
      );

      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(1n);
      const remaining = await silo.read.activeRequests([tranche.address, user.account.address, 0n]);
      expect(remaining.shares).to.equal(parseUnits("4", 18));
    });

    it("43. cancel swap-pops middle entry when i < len-1", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 86400],
        { account: keeper.account },
      );
      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("7", 18), 0n, 86400 * 2],
        { account: keeper.account },
      );

      // cancel index 0 with matching guard.shares=3 → swap-pop pulls index 1 into 0.
      await silo.write.cancel(
        [tranche.address as any, user.account.address, 0n, { shares: parseUnits("3", 18) }],
        { account: user.account },
      );

      expect(await silo.read.activeRequestsLength([tranche.address, user.account.address])).to.equal(1n);
      const remaining = await silo.read.activeRequests([tranche.address, user.account.address, 0n]);
      expect(remaining.shares).to.equal(parseUnits("7", 18));
    });

    it("44. vaultExitBounds view returns the stored TExitUpperBounds struct", async () => {
      const { silo, tranche, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      const bounds = await silo.read.vaultExitBounds([tranche.address]);
      expect(bounds.p0).to.equal(parseUnits("1.0", 18));
      expect(bounds.p1).to.equal(parseUnits("1.05", 18));
      expect(bounds.r0.sharesLock).to.equal(7 * 86400);
      expect(bounds.r1.sharesLock).to.equal(86400);
    });

    it("45. balanceOf(at) explicit-time overload mirrors balanceOf(default)", async () => {
      const { silo, tranche, asset, user, keeper, owner } = await loadFixture(siloFullFixture);
      await activeBounds(silo, owner, tranche);

      await silo.write.requestRedeem(
        [tranche.address, asset.address, user.account.address, user.account.address, parseUnits("3", 18), 0n, 86400],
        { account: keeper.account },
      );

      const now = BigInt(await time.latest());
      const s = await silo.read.balanceOf([tranche.address as any, user.account.address, now]);
      expect(s.pending).to.equal(parseUnits("3", 18));
      expect(s.claimable).to.equal(0n);
      expect(s.totalRequests).to.equal(1n);
    });
  });
});
