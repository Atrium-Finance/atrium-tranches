import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture, time } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";
import {
  seedDefault,
  seedTvl,
  redeemFromTranche,
} from "../../fixtures/seedTvl.js";
import { advanceWithYield, pushApr } from "../../fixtures/advanceTime.js";
import { snapshot, assertInvariant } from "../../fixtures/snapshotState.js";

describe("Integration · Withdraw flow — exit modes & guards", () => {
  it("1. ERC4626 mode (zero cooldown): silo short-circuits, user receives sUSDai", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    const sharesBefore = (await ctx.sr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    const navBefore = await snapshot(ctx);

    const halfShares = sharesBefore / 2n;
    const sUSDaiDelta = await redeemFromTranche(ctx, ctx.sr, halfShares, ctx.user);

    // User received sUSDai (silo's zero-cooldown short-circuit fired —
    // strategy default cooldowns are all zero).
    expect(sUSDaiDelta > 0n).to.equal(true);

    // Sr shares burned.
    const sharesAfter = (await ctx.sr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(sharesAfter).to.equal(sharesBefore - halfShares);

    // Sr TVL decreased.
    const navAfter = await snapshot(ctx);
    expect(navAfter.sr < navBefore.sr).to.equal(true);

    assertInvariant(navAfter);
  });

  it("2. Sr cooldown (3 days): silo holds sUSDai, finalize after window releases", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    // Enable Sr 3-day cooldown via strategy (UPDATER_STRAT_CONFIG_ROLE
    // is granted to owner in atriumFixture).
    const threeDays = 3 * 24 * 60 * 60;
    await ctx.strategy.write.setCooldowns([0, 0, threeDays]);

    const userShares = (await ctx.sr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    const userSUSDaiBefore = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    const siloSUSDaiBefore = (await ctx.susdai.read.balanceOf([
      ctx.erc20Cooldown.address,
    ])) as bigint;

    // Meta-token redeem half — strategy routes via silo with 3-day lock.
    await ctx.sr.write.redeem(
      [
        ctx.susdai.address,
        userShares / 2n,
        ctx.user.account.address,
        ctx.user.account.address,
      ],
      { account: ctx.user.account }
    );

    // User did NOT receive sUSDai yet (silo holds it).
    const userSUSDaiMid = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(userSUSDaiMid).to.equal(userSUSDaiBefore);

    // Silo holds the sUSDai.
    const siloSUSDaiAfter = (await ctx.susdai.read.balanceOf([
      ctx.erc20Cooldown.address,
    ])) as bigint;
    expect(siloSUSDaiAfter > siloSUSDaiBefore).to.equal(true);

    // Slot recorded for user.
    const slotCount = (await ctx.erc20Cooldown.read.activeRequestsLength([
      ctx.susdai.address,
      ctx.user.account.address,
    ])) as bigint;
    expect(slotCount).to.equal(1n);

    // Advance past the cooldown window.
    await time.increase(threeDays + 1);

    // Permissionless finalize releases sUSDai to user.
    await ctx.erc20Cooldown.write.finalize([
      ctx.susdai.address,
      ctx.user.account.address,
    ]);

    const userSUSDaiFinal = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(userSUSDaiFinal > userSUSDaiBefore).to.equal(true);
  });

  it("3. Withdraw after yield: redeemer receives appreciated sUSDai", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    // Push APR so Sr ratchets at the configured target floor — without
    // it, `_fetchAprs` reads the mock feed's (0, 0) defaults and zeroes
    // `aprSrt`, leaving Sr to recover only its principal.
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    // Snapshot sUSDai price (USDai per sUSDai share) before yield.
    const susdaiBeforeYield = (await ctx.susdai.read.previewRedeem([
      parseUnits("1", 18),
    ])) as bigint;

    // 7 days at ~10% APR weekly cycle.
    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 19);

    const susdaiAfterYield = (await ctx.susdai.read.previewRedeem([
      parseUnits("1", 18),
    ])) as bigint;
    expect(susdaiAfterYield > susdaiBeforeYield).to.equal(true);

    // Redeem all Sr shares.
    const userShares = (await ctx.sr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    const sUSDaiDelta = await redeemFromTranche(ctx, ctx.sr, userShares, ctx.user);

    // sUSDai received, converted back to USDai equivalent, exceeds the
    // initial 100 USDai Sr deposit — Sr accrued at least target APR.
    const usdaiEquivalent = (await ctx.susdai.read.previewRedeem([
      sUSDaiDelta,
    ])) as bigint;
    expect(usdaiEquivalent > parseUnits("100", 18)).to.equal(true);
  });

  it("4. MIN_SHARES guard: leaving < 0.1 ether reverts; full drain allowed", async () => {
    const ctx = await loadFixture(atriumFixture);

    // Seed Jr with 0.2 ether — just above the 0.1 ether MIN_SHARES
    // floor so the violation can be triggered.
    await seedTvl(ctx, {
      jr: parseUnits("0.2", 18),
      mz: 0n,
      sr: 0n,
    });

    const userShares = (await ctx.jr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(userShares).to.equal(parseUnits("0.2", 18));

    // Redeem 0.19 → would leave 0.01 ether in supply, below MIN_SHARES.
    await expect(
      ctx.jr.write.redeem(
        [
          ctx.susdai.address,
          parseUnits("0.19", 18),
          ctx.user.account.address,
          ctx.user.account.address,
        ],
        { account: ctx.user.account }
      )
    ).to.be.rejected;

    // Full drain (supply → 0) is exempt — clean-drain branch.
    await ctx.jr.write.redeem(
      [
        ctx.susdai.address,
        userShares,
        ctx.user.account.address,
        ctx.user.account.address,
      ],
      { account: ctx.user.account }
    );

    const finalSupply = (await ctx.jr.read.totalSupply()) as bigint;
    expect(finalSupply).to.equal(0n);
  });

  it("5. Coverage gate: Jr redeem blocked when buffer = sr × 0.05 floor", async () => {
    const ctx = await loadFixture(atriumFixture);

    // Sr = 1100 ⇒ srFloor = 55. With Jr+Mz = 100, max Jr/Mz withdraw =
    // 45. User holds 50 Jr shares → redeem of 50 exceeds the cap.
    await seedTvl(ctx, {
      jr: parseUnits("50", 18),
      mz: parseUnits("50", 18),
      sr: parseUnits("1100", 18),
    });

    const userJrShares = (await ctx.jr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(userJrShares).to.equal(parseUnits("50", 18));

    const maxJrWithdraw = (await ctx.cdo.read.maxWithdraw([
      ctx.jr.address,
    ])) as bigint;
    expect(maxJrWithdraw < parseUnits("50", 18)).to.equal(true);

    // Redeem all 50 Jr → would withdraw ~50 base, > maxWithdraw=45 ⇒
    // CoverageBelowMinimum revert in CDO body.
    await expect(
      ctx.jr.write.redeem(
        [
          ctx.susdai.address,
          userJrShares,
          ctx.user.account.address,
          ctx.user.account.address,
        ],
        { account: ctx.user.account }
      )
    ).to.be.rejected;
  });
});
