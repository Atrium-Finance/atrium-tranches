/**
 * Integration-test helper: seed Atrium with real per-tranche TVL.
 *
 * Bootstrap problem: the very first `updateAccounting(navT1)` call
 * after a non-zero strategy deposit hits the 08b bootstrap branch
 * (all tranche NAVs zero, navT1 > 0 → entire NAV routed to reserve).
 * This would leave `tvlJr/Mz/Sr = 0`, which makes the Sr coverage
 * gate's `maxDeposit` return 0 and blocks subsequent Sr deposits.
 *
 * Pattern: interleave each tranche deposit with a CDO-impersonated
 * `accounting.updateBalanceFlow(...)` so the next deposit's
 * `cdo.updateAccounting()` sees a non-bootstrap state where
 * `accounting.nav` already equals `strategy.totalAssets()` (delta=0,
 * no-op).
 */
import { parseUnits } from "viem";
import { impersonateAccount, setBalance } from "../helpers/network-helpers.js";

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
 * one at a time and immediately seed its TVL bucket via CDO
 * impersonation so the next deposit sees an aligned NAV.
 */
export async function seedTvl(ctx: FixtureCtx, amounts: SeedAmounts) {
  await ctx.cdo.write.setActionStates([ctx.jr.address, true, true]);
  await ctx.cdo.write.setActionStates([ctx.mz.address, true, true]);
  await ctx.cdo.write.setActionStates([ctx.sr.address, true, true]);

  const total = amounts.jr + amounts.mz + amounts.sr;
  if (total === 0n) return;

  await ctx.usdai.write.mint([ctx.user.account.address, total]);

  // One-time CDO impersonation for all seeding calls.
  await impersonateAccount(ctx.cdo.address);
  await setBalance(ctx.cdo.address, parseUnits("10", 18));

  const depositAndSeed = async (
    tranche: any,
    amount: bigint,
    flow: [bigint, bigint, bigint, bigint, bigint, bigint]
  ) => {
    if (amount === 0n) return;
    await ctx.usdai.write.approve([tranche.address, MAX_U256], {
      account: ctx.user.account,
    });
    await tranche.write.deposit([amount, ctx.user.account.address], {
      account: ctx.user.account,
    });
    await ctx.accounting.write.updateBalanceFlow(flow, {
      account: ctx.cdo.address as `0x${string}`,
    });
  };

  // Order: Jr → Mz → Sr. By the time Sr deposits, subordinate buffer
  // (jr + mz) is already seeded, so the coverage gate lets Sr through.
  await depositAndSeed(ctx.jr, amounts.jr, [amounts.jr, 0n, 0n, 0n, 0n, 0n]);
  await depositAndSeed(ctx.mz, amounts.mz, [0n, 0n, amounts.mz, 0n, 0n, 0n]);
  await depositAndSeed(ctx.sr, amounts.sr, [0n, 0n, 0n, 0n, amounts.sr, 0n]);
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
