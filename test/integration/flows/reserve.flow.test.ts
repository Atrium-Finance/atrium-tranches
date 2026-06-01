import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";
import { seedDefault } from "../../fixtures/seedTvl.js";
import { advanceWithYield, pushApr } from "../../fixtures/advanceTime.js";
import { snapshot, assertInvariant } from "../../fixtures/snapshotState.js";

describe("Integration · Reserve flow — accrual + drain", () => {
  it("1. Reserve cut on Case-1 yield matches the 5% reserveBps default", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    const before = await snapshot(ctx);

    // 1% rate inflation over 7 days — generous yield → Case 1 split.
    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 100);

    const after = await snapshot(ctx);

    // navGain = sum of (Δjr + Δmz + Δsr + Δreserve). reserveBps = 5%.
    const navGain = after.nav - before.nav;
    const expectedReserveCut = navGain / 20n; // 5% = /20.

    const actualReserveCut = after.reserve - before.reserve;
    // 1% absolute tolerance (Math.mulDiv Floor on the reserve carve).
    const tolerance = expectedReserveCut / 100n + 1n;
    const diff =
      actualReserveCut > expectedReserveCut
        ? actualReserveCut - expectedReserveCut
        : expectedReserveCut - actualReserveCut;
    expect(diff <= tolerance).to.equal(true);

    assertInvariant(after);
  });

  it("2. Multi-cycle yield monotonically accumulates reserve and srIndex", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    const initial = await snapshot(ctx);

    let lastReserve = initial.reserve;
    let lastIndex = initial.srIndex;
    for (let i = 0; i < 4; i++) {
      await advanceWithYield(ctx, 7 * 24 * 60 * 60, 50);
      const s = await snapshot(ctx);
      expect(s.reserve > lastReserve).to.equal(true);
      expect(s.srIndex > lastIndex).to.equal(true);
      lastReserve = s.reserve;
      lastIndex = s.srIndex;
      assertInvariant(s);
    }
  });

  it("3. reduceReserve transfers sUSDai to treasury and decrements tvlReserve / nav", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);
    await ctx.cdo.write.setReserveTreasury([ctx.treasury.account.address]);

    for (let i = 0; i < 4; i++) {
      await advanceWithYield(ctx, 7 * 24 * 60 * 60, 100);
    }

    const before = await snapshot(ctx);
    expect(before.reserve > 0n).to.equal(true);

    // Drain ~all the reserve. Floor-convert the reserve into sUSDai so
    // `convertToAssets(tokenAmount, Floor)` lands at or below the
    // current bucket (avoids ReserveInsufficient).
    const tokenAmount = (await ctx.strategy.read.convertToTokens([
      ctx.susdai.address,
      (before.reserve * 99n) / 100n, // leave a 1% buffer for Floor rounding.
      0, // Math.Rounding.Floor.
    ])) as bigint;

    const treasuryBefore = (await ctx.susdai.read.balanceOf([
      ctx.treasury.account.address,
    ])) as bigint;

    await ctx.cdo.write.reduceReserve([ctx.susdai.address, tokenAmount]);

    const treasuryAfter = (await ctx.susdai.read.balanceOf([
      ctx.treasury.account.address,
    ])) as bigint;
    const after = await snapshot(ctx);

    expect(treasuryAfter - treasuryBefore).to.equal(tokenAmount);
    expect(after.reserve < before.reserve).to.equal(true);
    // Tranche NAVs unchanged — drain only touches reserve.
    expect(after.jr).to.equal(before.jr);
    expect(after.mz).to.equal(before.mz);
    expect(after.sr).to.equal(before.sr);

    assertInvariant(after);
  });

  it("4. reduceReserve bypasses cooldown silo even when Sr cooldown is set", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);
    await ctx.cdo.write.setReserveTreasury([ctx.treasury.account.address]);

    // Enable 3-day Sr cooldown — should NOT affect reserve drain path.
    await ctx.strategy.write.setCooldowns([0, 0, 3 * 24 * 60 * 60]);

    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 100);

    const [, , , reserveBefore] =
      (await ctx.accounting.read.totalAssetsT0()) as [
        bigint,
        bigint,
        bigint,
        bigint
      ];

    const tokenAmount = (await ctx.strategy.read.convertToTokens([
      ctx.susdai.address,
      reserveBefore / 2n,
      0,
    ])) as bigint;

    const treasuryBefore = (await ctx.susdai.read.balanceOf([
      ctx.treasury.account.address,
    ])) as bigint;
    const siloBefore = (await ctx.susdai.read.balanceOf([
      ctx.erc20Cooldown.address,
    ])) as bigint;

    await ctx.cdo.write.reduceReserve([ctx.susdai.address, tokenAmount]);

    const treasuryAfter = (await ctx.susdai.read.balanceOf([
      ctx.treasury.account.address,
    ])) as bigint;
    const siloAfter = (await ctx.susdai.read.balanceOf([
      ctx.erc20Cooldown.address,
    ])) as bigint;

    // Treasury received tokens immediately — no silo delay.
    expect(treasuryAfter - treasuryBefore).to.equal(tokenAmount);
    // Silo balance untouched.
    expect(siloAfter).to.equal(siloBefore);
  });
});

// Reference to silence unused-import warnings if any helper goes unused later.
void parseUnits;
