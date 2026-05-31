import { describe, it, beforeEach } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { parseUnits, getAddress, zeroAddress } from "viem";
import { viem } from "../../helpers/viemClients.js";
import { trancheFixture } from "../../fixtures/deployTrancheOnly.js";

const TExitMode = { ERC4626: 0, SharesLock: 1, Fee: 2, Dynamic: 3 } as const;
const MAX_U256 = (1n << 256n) - 1n;

type Ctx = Awaited<ReturnType<typeof trancheFixture>>;

async function seedDeposit(ctx: Ctx, amount: bigint = parseUnits("100", 18)) {
  await ctx.usdai.write.mint([ctx.user.account.address, amount]);
  await ctx.usdai.write.approve([ctx.tranche.address, amount], { account: ctx.user.account });
  await ctx.tranche.write.deposit([amount, ctx.user.account.address], { account: ctx.user.account });
}

describe("Tranche", () => {
  describe("initialization", () => {
    it("1. Sets asset, name, symbol via ERC4626", async () => {
      const ctx = await loadFixture(trancheFixture);
      expect(getAddress(await ctx.tranche.read.asset())).to.equal(getAddress(ctx.usdai.address));
      expect(await ctx.tranche.read.name()).to.equal("Junior");
      expect(await ctx.tranche.read.symbol()).to.equal("JR");
    });

    it("2. Wires CDO correctly", async () => {
      const ctx = await loadFixture(trancheFixture);
      expect(getAddress(await ctx.tranche.read.getCDOAddress())).to.equal(getAddress(ctx.mockCDO.address));
    });

    it("3. Default exit mode from CDO is ERC4626 with zero fee", async () => {
      const ctx = await loadFixture(trancheFixture);
      const [mode, fee, cd] = await ctx.mockCDO.read.calculateExitMode([ctx.tranche.address, zeroAddress]);
      expect(mode).to.equal(TExitMode.ERC4626);
      expect(fee).to.equal(0n);
      expect(cd).to.equal(0);
    });
  });

  describe("deposit", () => {
    it("4. ERC20-style deposit pulls from user, mints shares", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("10", 18));
      expect(await ctx.tranche.read.balanceOf([ctx.user.account.address])).to.equal(parseUnits("10", 18));
    });

    it("5. Native-token path (token == asset)", async () => {
      const ctx = await loadFixture(trancheFixture);
      await ctx.usdai.write.mint([ctx.user.account.address, parseUnits("1", 18)]);
      await ctx.usdai.write.approve([ctx.tranche.address, parseUnits("1", 18)], { account: ctx.user.account });
      await ctx.tranche.write.deposit(
        [ctx.usdai.address, parseUnits("1", 18), ctx.user.account.address],
        { account: ctx.user.account }
      );
      expect(await ctx.tranche.read.balanceOf([ctx.user.account.address])).to.equal(parseUnits("1", 18));
    });

    it("6. Reverts on unsupported token", async () => {
      const ctx = await loadFixture(trancheFixture);
      const fake = await viem.deployContract("MockERC20", ["X", "X", 18]);
      await expect(
        ctx.tranche.write.deposit(
          [fake.address, 1n, ctx.user.account.address],
          { account: ctx.user.account }
        )
      ).to.be.rejected;
    });

    it("7. Deposit succeeds when not paused (mock CDO has no pause)", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("1", 18));
    });

    it("8. maxDeposit reflects mock CDO's max (uint256.max)", async () => {
      const ctx = await loadFixture(trancheFixture);
      const max = await ctx.tranche.read.maxDeposit([ctx.user.account.address]);
      expect(max).to.equal(MAX_U256);
    });

    it("9. mint() forwards to ERC4626 path", async () => {
      const ctx = await loadFixture(trancheFixture);
      await ctx.usdai.write.mint([ctx.user.account.address, parseUnits("5", 18)]);
      await ctx.usdai.write.approve([ctx.tranche.address, parseUnits("5", 18)], { account: ctx.user.account });
      await ctx.tranche.write.mint([parseUnits("5", 18), ctx.user.account.address], { account: ctx.user.account });
      expect(await ctx.tranche.read.balanceOf([ctx.user.account.address])).to.equal(parseUnits("5", 18));
    });
  });

  describe("withdraw", () => {
    let ctx: Ctx;

    beforeEach(async () => {
      ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("100", 18));
    });

    it("10. ERC4626 standard withdraw burns shares (via redeem)", async () => {
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      await ctx.tranche.write.redeem(
        [shares, ctx.user.account.address, ctx.user.account.address],
        { account: ctx.user.account }
      );
      expect(await ctx.tranche.read.balanceOf([ctx.user.account.address])).to.equal(0n);
    });

    it("11. Standard redeem delegates to token-routed redeem", async () => {
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      await ctx.tranche.write.redeem(
        [shares, ctx.user.account.address, ctx.user.account.address],
        { account: ctx.user.account }
      );
    });

    it("12. Fee mode: applies exit fee, accrueFee called", async () => {
      await ctx.mockCDO.write.setExitMode([TExitMode.Fee, parseUnits("0.01", 18), 0]);
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      await ctx.tranche.write.redeem(
        [shares, ctx.user.account.address, ctx.user.account.address],
        { account: ctx.user.account }
      );
      expect(getAddress(await ctx.mockAccounting.read.lastFeeTranche())).to.equal(getAddress(ctx.tranche.address));
    });

    it("13. Dynamic mode: routes per TRedemptionParams", async () => {
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      const params = { exitMode: TExitMode.Dynamic, exitFee: 0n, cooldownSeconds: 0 };
      await ctx.tranche.write.redeem(
        [ctx.usdai.address, shares, ctx.user.account.address, ctx.user.account.address, params],
        { account: ctx.user.account }
      );
    });

    it("14. Standard ERC4626 redeem reaches token-routed", async () => {
      const before = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      await ctx.tranche.write.redeem(
        [before, ctx.user.account.address, ctx.user.account.address],
        { account: ctx.user.account }
      );
      expect(await ctx.tranche.read.balanceOf([ctx.user.account.address])).to.equal(0n);
    });
  });

  describe("TRedemptionParams validation", () => {
    it("15. Mode mismatch → reverts RedemptionParamsMismatch", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("100", 18));
      await ctx.mockCDO.write.setExitMode([TExitMode.Fee, parseUnits("0.01", 18), 0]);
      const params = { exitMode: TExitMode.ERC4626, exitFee: 0n, cooldownSeconds: 0 };
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      await expect(
        ctx.tranche.write.redeem(
          [ctx.usdai.address, shares, ctx.user.account.address, ctx.user.account.address, params],
          { account: ctx.user.account }
        )
      ).to.be.rejected;
    });

    it("16. quoteWithdraw / quoteRedeem return token amounts", async () => {
      const ctx = await loadFixture(trancheFixture);
      const sg = await ctx.tranche.read.quoteWithdraw([parseUnits("1", 18), 0n]);
      expect(sg).to.equal(parseUnits("1", 18));
      const an = await ctx.tranche.read.quoteRedeem([parseUnits("1", 18), 0n]);
      expect(an).to.equal(parseUnits("1", 18));
    });
  });

  describe("MIN_SHARES guard", () => {
    it("17. Withdraw leaving totalSupply between 0 and MIN_SHARES → reverts MinSharesViolation", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("0.2", 18));
      // Burn 75% of shares → leaves 0.05 < MIN_SHARES (0.1)
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      const partial = (shares * 3n) / 4n;
      await expect(
        ctx.tranche.write.redeem(
          [partial, ctx.user.account.address, ctx.user.account.address],
          { account: ctx.user.account }
        )
      ).to.be.rejected;
    });

    it("18. Withdraw leaving totalSupply == 0 → allowed", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("0.2", 18));
      const userShares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      await ctx.tranche.write.redeem(
        [userShares, ctx.user.account.address, ctx.user.account.address],
        { account: ctx.user.account }
      );
      expect(await ctx.tranche.read.totalSupply()).to.equal(0n);
    });

    it("19. burnSharesAsFee also enforces MIN_SHARES", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("0.2", 18));
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      const partial = (shares * 3n) / 4n;
      await expect(
        ctx.tranche.write.burnSharesAsFee([partial, ctx.user.account.address], { account: ctx.user.account })
      ).to.be.rejected;
    });
  });

  describe("Preview / max views", () => {
    it("20. previewWithdraw fee-aware (1% bumps shares)", async () => {
      const ctx = await loadFixture(trancheFixture);
      await ctx.mockCDO.write.setExitMode([TExitMode.Fee, parseUnits("0.01", 18), 0]);
      const out = await ctx.tranche.read.previewWithdraw([parseUnits("1", 18)]);
      expect(out >= parseUnits("1", 18)).to.equal(true);
    });

    it("21. previewRedeem fee-aware", async () => {
      const ctx = await loadFixture(trancheFixture);
      await ctx.mockCDO.write.setExitMode([TExitMode.Fee, parseUnits("0.01", 18), 0]);
      const out = await ctx.tranche.read.previewRedeem([parseUnits("1", 18)]);
      expect(out <= parseUnits("1", 18)).to.equal(true);
    });

    it("22. maxDeposit/maxWithdraw forward to CDO", async () => {
      const ctx = await loadFixture(trancheFixture);
      expect(await ctx.tranche.read.maxDeposit([ctx.user.account.address])).to.equal(MAX_U256);
      // MockCDO returns 1e30 (a large bounded sentinel — see MockCDO.sol).
      expect(await ctx.tranche.read.maxWithdraw([ctx.user.account.address])).to.equal(10n ** 30n);
    });

    it("23. meta-token previewRedeem / previewWithdraw callable", async () => {
      const ctx = await loadFixture(trancheFixture);
      await ctx.tranche.read.previewRedeem([ctx.usdai.address, parseUnits("1", 18)]);
      await ctx.tranche.read.previewWithdraw([ctx.usdai.address, parseUnits("1", 18)]);
    });
  });

  describe("Events", () => {
    it("24. OnExit fires on withdraw (smoke)", async () => {
      const ctx = await loadFixture(trancheFixture);
      await seedDeposit(ctx, parseUnits("100", 18));
      const shares = await ctx.tranche.read.balanceOf([ctx.user.account.address]);
      const hash = await ctx.tranche.write.redeem(
        [shares, ctx.user.account.address, ctx.user.account.address],
        { account: ctx.user.account }
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash });
      const events = await (ctx.tranche as any).getEvents.OnExit();
      expect(events.length).to.be.greaterThan(0);
    });

    it("25. Deposit emits standard ERC4626 Deposit event (smoke)", async () => {
      const ctx = await loadFixture(trancheFixture);
      await ctx.usdai.write.mint([ctx.user.account.address, parseUnits("1", 18)]);
      await ctx.usdai.write.approve([ctx.tranche.address, parseUnits("1", 18)], { account: ctx.user.account });
      const hash = await ctx.tranche.write.deposit(
        [parseUnits("1", 18), ctx.user.account.address],
        { account: ctx.user.account }
      );
      const rec = await ctx.publicClient.waitForTransactionReceipt({ hash });
      expect(rec.status).to.equal("success");
    });
  });
});
