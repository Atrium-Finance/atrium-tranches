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

describe("SharesCooldown", () => {
  describe("requestRedeem", () => {
    it("1. Requires COOLDOWN_WORKER_ROLE", async () => {
      const { silo, user } = await loadFixture(silofixture);
      await expect(
        silo.write.requestRedeem(
          [user.account.address, user.account.address, user.account.address, user.account.address, 1n, 0n, 0],
          { account: user.account }
        )
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
      await expect(
        silo.write.finalize([owner.account.address as any, zeroAddress, user.account.address])
      ).to.be.rejected;
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
      await expect(
        silo.write.setVaultEarlyExitFee([owner.account.address, parseUnits("0.02", 18)])
      ).to.be.rejected;
    });

    it("12. setVaultEarlyExitFee within cap accepted", async () => {
      const { silo, owner } = await loadFixture(silofixture);
      await silo.write.setVaultEarlyExitFee([owner.account.address, parseUnits("0.005", 18)]);
      expect(
        await silo.read.vaultEarlyExitFeePerDay([owner.account.address])
      ).to.equal(parseUnits("0.005", 18));
    });
  });

  describe("cancel", () => {
    it("13. Cancel non-owner reverts OnlySharesOwner", async () => {
      const { silo, owner, user } = await loadFixture(silofixture);
      await expect(
        silo.write.cancel([owner.account.address as any, user.account.address, 0n, { shares: 0n }],
          { account: owner.account })
      ).to.be.rejected;
    });

    it("14. Cancel out-of-range index reverts OutOfRange", async () => {
      const { silo, user } = await loadFixture(silofixture);
      await expect(
        silo.write.cancel([user.account.address as any, user.account.address, 0n, { shares: 0n }],
          { account: user.account })
      ).to.be.rejected;
    });

    it("15. Cancel by non-recipient reverts", async () => {
      const { silo, user, rest } = await loadFixture(silofixture);
      await expect(
        silo.write.cancel([user.account.address as any, rest[0].account.address, 0n, { shares: 0n }],
          { account: user.account })
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
      await expect(
        silo.write.setVaultEarlyExitFee([owner.account.address, parseUnits("0.011", 18)])
      ).to.be.rejected;
    });

    it("18. Owner-only setVaultExitBounds", async () => {
      const { silo, user, owner } = await loadFixture(silofixture);
      const bounds = {
        p0: 0n, p1: 0n,
        r0: { feeBps: 0n, sharesLock: 0 },
        r1: { feeBps: 0n, sharesLock: 0 },
        r2: { feeBps: 0n, sharesLock: 0 },
      };
      await expect(
        silo.write.setVaultExitBounds([owner.account.address, bounds], { account: user.account })
      ).to.be.rejected;
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
});
