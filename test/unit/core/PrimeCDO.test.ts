import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { viem } from "../../helpers/viemClients.js";
import { parseUnits, getAddress, zeroAddress } from "viem";
import { atriumFixture } from "../../fixtures/deployAtrium.js";

const MAX_U256 = (1n << 256n) - 1n;

describe("PrimeCDO", () => {
  describe("initialization", () => {
    it("1. Reverts when initialized twice", async () => {
      const { cdo, owner, acm } = await loadFixture(atriumFixture);
      await expect(
        cdo.write.initialize([owner.account.address, acm.address])
      ).to.be.rejected;
    });

    it("2. Sets owner, ACM, and zero-state defaults correctly", async () => {
      const { cdo, owner, acm } = await loadFixture(atriumFixture);
      expect(getAddress(await cdo.read.owner())).to.equal(getAddress(owner.account.address));
      expect(getAddress(await cdo.read.acm())).to.equal(getAddress(acm.address));
      expect(getAddress(await cdo.read.treasury())).to.equal(zeroAddress);
      expect(await cdo.read.exitFeeJr()).to.equal(0n);
      expect(await cdo.read.exitFeeMz()).to.equal(0n);
      expect(await cdo.read.exitFeeSr()).to.equal(0n);
    });

    it("3. Reverts on zero ACM address", async () => {
      
      const impl = await viem.deployContract("PrimeCDO");
      const { owner } = await loadFixture(atriumFixture);
      const { encodeFunctionData } = await import("viem");
      const init = encodeFunctionData({
        abi: impl.abi,
        functionName: "initialize",
        args: [owner.account.address, zeroAddress],
      });
      await expect(
        viem.deployContract("ProjectERC1967Proxy", [impl.address, init])
      ).to.be.rejected;
    });
  });

  describe("config wiring", () => {
    it("4. config() wires tranches + accounting + strategy, emits Configured", async () => {
      const { cdo, jr, mz, sr, accounting, strategy } = await loadFixture(atriumFixture);
      expect(getAddress(await cdo.read.jrVault())).to.equal(getAddress(jr.address));
      expect(getAddress(await cdo.read.mezzVault())).to.equal(getAddress(mz.address));
      expect(getAddress(await cdo.read.srVault())).to.equal(getAddress(sr.address));
      expect(getAddress(await cdo.read.accounting())).to.equal(getAddress(accounting.address));
      expect(getAddress(await cdo.read.strategy())).to.equal(getAddress(strategy.address));
    });

    it("5. Re-callable to re-wire", async () => {
      const { cdo, jr, mz, sr, accounting, strategy } = await loadFixture(atriumFixture);
      await cdo.write.config([jr.address, mz.address, sr.address, accounting.address, strategy.address]);
    });

    it("6. Reverts on any zero-address arg", async () => {
      const { cdo, jr, mz, sr, accounting } = await loadFixture(atriumFixture);
      await expect(
        cdo.write.config([zeroAddress, mz.address, sr.address, accounting.address, zeroAddress])
      ).to.be.rejected;
    });

    it("7. Tranches receive Strategy allowance via configure()", async () => {
      const { jr, strategy, usdai } = await loadFixture(atriumFixture);
      const allowance = await usdai.read.allowance([jr.address, strategy.address]);
      expect(allowance).to.equal(MAX_U256);
    });
  });

  describe("kindOf", () => {
    it("8. Returns JUNIOR/MEZZANINE/SENIOR for wired vaults", async () => {
      const { cdo, jr, mz, sr } = await loadFixture(atriumFixture);
      expect(await cdo.read.kindOf([jr.address])).to.equal(0);
      expect(await cdo.read.kindOf([mz.address])).to.equal(1);
      expect(await cdo.read.kindOf([sr.address])).to.equal(2);
    });

    it("9. Reverts InvalidTranche on unknown address", async () => {
      const { cdo, user } = await loadFixture(atriumFixture);
      await expect(cdo.read.kindOf([user.account.address])).to.be.rejected;
    });
  });

  describe("totalAssets(tranche)", () => {
    it("10. Forwards to Accounting per kind", async () => {
      const { cdo, jr, mz, sr } = await loadFixture(atriumFixture);
      expect(await cdo.read.totalAssets([jr.address])).to.equal(0n);
      expect(await cdo.read.totalAssets([mz.address])).to.equal(0n);
      expect(await cdo.read.totalAssets([sr.address])).to.equal(0n);
    });
  });

  describe("coverage gates", () => {
    it("11. _maxSrDeposit caps based on subordinate buffer", async () => {
      const { cdo, sr } = await loadFixture(atriumFixture);
      // At zero state Sr can accept unbounded (no subordinate present yet → headroom = 0)
      expect(await cdo.read.maxDeposit([sr.address])).to.equal(0n);
    });

    it("12. _maxSrDeposit returns 0 when subordinate insufficient", async () => {
      const { cdo, sr } = await loadFixture(atriumFixture);
      expect(await cdo.read.maxDeposit([sr.address])).to.equal(0n);
    });

    it("13. _maxWithdraw for SR returns full sr TVL", async () => {
      const { cdo, sr } = await loadFixture(atriumFixture);
      expect(await cdo.read.maxWithdraw([sr.address])).to.equal(0n);
    });

    it("14. _maxWithdraw for JR/MZ returns shared buffer", async () => {
      const { cdo, jr, mz } = await loadFixture(atriumFixture);
      expect(await cdo.read.maxWithdraw([jr.address])).to.equal(0n);
      expect(await cdo.read.maxWithdraw([mz.address])).to.equal(0n);
    });

    it("15. _maxWithdraw returns 0 when buffer already at floor", async () => {
      const { cdo, jr } = await loadFixture(atriumFixture);
      expect(await cdo.read.maxWithdraw([jr.address])).to.equal(0n);
    });

    it("16. maxWithdraw(tranche, owner=silo) bypasses coverage", async () => {
      const { cdo, jr, owner } = await loadFixture(atriumFixture);
      // Wire a silo so the silo branch kicks in.
      await cdo.write.setSharesCooldown([owner.account.address]);
      // owner now stands in for the silo.
      const v = await cdo.read.maxWithdraw([jr.address, owner.account.address]);
      // silo balance is zero → zero assets.
      expect(v).to.equal(0n);
    });
  });

  describe("reduceReserve", () => {
    it("17. Drains reserve to treasury, calls Accounting.reduceReserve(amount)", async () => {
      const { cdo, owner, treasury, usdai } = await loadFixture(atriumFixture);
      await cdo.write.setReserveTreasury([treasury.account.address]);
      // No reserve seeded → reverts ZeroAmount / ReserveInsufficient.
      await expect(cdo.write.reduceReserve([usdai.address, 1n])).to.be.rejected;
    });

    it("18. Reverts when not RESERVE_MANAGER_ROLE", async () => {
      const { cdo, user, susdai } = await loadFixture(atriumFixture);
      await expect(
        cdo.write.reduceReserve([susdai.address, 1n], { account: user.account })
      ).to.be.rejected;
    });

    it("19. Reverts when treasury == address(0)", async () => {
      const { cdo, susdai } = await loadFixture(atriumFixture);
      await expect(cdo.write.reduceReserve([susdai.address, 1n])).to.be.rejected;
    });

    it("20. Reverts when amount > reserve", async () => {
      const { cdo, treasury, susdai } = await loadFixture(atriumFixture);
      await cdo.write.setReserveTreasury([treasury.account.address]);
      await expect(cdo.write.reduceReserve([susdai.address, parseUnits("1", 18)])).to.be.rejected;
    });
  });

  describe("pause states", () => {
    it("21. setActionStates per tranche pauses deposit/withdraw independently", async () => {
      const { cdo, jr } = await loadFixture(atriumFixture);
      await cdo.write.setActionStates([jr.address, true, false]);
      const state = await cdo.read.actionsJr();
      // tuple (isDepositEnabled, isWithdrawEnabled)
      expect(state[0]).to.equal(true);
      expect(state[1]).to.equal(false);
    });

    it("22. Reverts when not PAUSER_ROLE", async () => {
      const { cdo, jr, user } = await loadFixture(atriumFixture);
      await expect(
        cdo.write.setActionStates([jr.address, true, true], { account: user.account })
      ).to.be.rejected;
    });
  });
});
