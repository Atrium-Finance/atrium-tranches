/**
 * Integration-test helper: seed Atrium with real per-tranche TVL.
 *
 * `PrimeCDO.deposit` records the inflow via `updateBalanceFlow(...in...)`,
 * so each tranche deposit grows its own TVL bucket and `nav` in lockstep
 * with `strategy.totalAssets()`. That also sidesteps the 08b bootstrap
 * branch (all tranche NAVs zero, navT1 > 0 → NAV routed to reserve):
 * because Jr deposits first and its bucket is recorded immediately, the
 * later Mz/Sr deposits already see a non-bootstrap, delta-0 state.
 */
import { parseUnits } from "viem";

export interface SeedAmounts {
  jr: bigint;
  mz: bigint;
  sr: bigint;
}

export interface FixtureCtx {
  cdo: any;
  accounting: any;
  jr: any;
  mz: any;
  sr: any;
  usdai: any;
  user: any;
  owner: any;
}

const MAX_U256 = (1n << 256n) - 1n;

/**
 * Enable all three tranches, mint USDai to user, deposit each tranche
 * one at a time. The deposit path records the inflow itself, so no
 * manual TVL seeding is needed.
 */
export async function seedTvl(ctx: FixtureCtx, amounts: SeedAmounts) {
  await ctx.cdo.write.setActionStates([ctx.jr.address, true, true]);
  await ctx.cdo.write.setActionStates([ctx.mz.address, true, true]);
  await ctx.cdo.write.setActionStates([ctx.sr.address, true, true]);

  const total = amounts.jr + amounts.mz + amounts.sr;
  if (total === 0n) return;

  await ctx.usdai.write.mint([ctx.user.account.address, total]);

  const deposit = async (tranche: any, amount: bigint) => {
    if (amount === 0n) return;
    await ctx.usdai.write.approve([tranche.address, MAX_U256], {
      account: ctx.user.account,
    });
    await tranche.write.deposit([amount, ctx.user.account.address], {
      account: ctx.user.account,
    });
  };

  // Order: Jr → Mz → Sr. By the time Sr deposits, subordinate buffer
  // (jr + mz) is already seeded, so the coverage gate lets Sr through.
  await deposit(ctx.jr, amounts.jr);
  await deposit(ctx.mz, amounts.mz);
  await deposit(ctx.sr, amounts.sr);
}

/**
 * Convenience: default seeding 50 / 50 / 100 across Jr / Mz / Sr
 * (subordinate 100, Senior 100 — coverage starts at 2.0×).
 */
export async function seedDefault(ctx: FixtureCtx) {
  await seedTvl(ctx, {
    jr: parseUnits("50", 18),
    mz: parseUnits("50", 18),
    sr: parseUnits("100", 18),
  });
}

export interface WithdrawCtx extends FixtureCtx {
  susdai: any;
}

/**
 * Redeem `shares` from `tranche` via the sUSDai meta-token path.
 * USDAStrategy only honours `token == sUSDai` on withdraw, so the
 * standard 3-arg ERC4626 `redeem(shares, receiver, owner)` would
 * revert. Returns the sUSDai delta on the receiver's balance.
 */
export async function redeemFromTranche(
  ctx: WithdrawCtx,
  tranche: any,
  shares: bigint,
  user: any
): Promise<bigint> {
  const before = (await ctx.susdai.read.balanceOf([
    user.account.address,
  ])) as bigint;

  await tranche.write.redeem(
    [ctx.susdai.address, shares, user.account.address, user.account.address],
    { account: user.account }
  );

  const after = (await ctx.susdai.read.balanceOf([
    user.account.address,
  ])) as bigint;
  return after - before;
}
