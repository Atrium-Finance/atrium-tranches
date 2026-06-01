/**
 * Fork analog of `test/fixtures/seedTvl.ts`. Same bootstrap-avoidance
 * pattern (impersonate CDO + call `updateBalanceFlow` between deposits)
 * but routes through `forkImpersonate` / `forkSetBalance` so the
 * impersonation lands on the fork EDR instance.
 *
 * Funds the user from a whale rather than minting against a mock, since
 * USDai on Arbitrum has no permissionless mint.
 */
import { parseEther } from "viem";
import { forkImpersonate, forkSetBalance } from "../helpers/forkClients.js";
import { fundFromWhale } from "../helpers/whaleFunding.js";
import { addr } from "../helpers/addr.js";
import type { ForkAtriumCtx } from "./deployForkAtrium.js";

const MAX_U256 = (1n << 256n) - 1n;

export interface SeedAmounts {
  jr: bigint;
  mz: bigint;
  sr: bigint;
}

/**
 * Enable tranches, fund user from sUSDai whale, deposit per-tranche
 * with a CDO-impersonated `accounting.updateBalanceFlow(...)` between
 * each so subsequent deposits see a non-bootstrap NAV state.
 */
export async function seedForkTvl(ctx: ForkAtriumCtx, amounts: SeedAmounts): Promise<void> {
  await ctx.cdo.write.setActionStates([ctx.jr.address, true, true]);
  await ctx.cdo.write.setActionStates([ctx.mz.address, true, true]);
  await ctx.cdo.write.setActionStates([ctx.sr.address, true, true]);

  const total = amounts.jr + amounts.mz + amounts.sr;
  if (total === 0n) return;

  await fundFromWhale(addr("whaleUSDai"), ctx.user.account.address, ctx.USDai, total);

  await forkImpersonate(ctx.cdo.address);
  await forkSetBalance(ctx.cdo.address, parseEther("10"));

  const depositAndSeed = async (
    tranche: any,
    amount: bigint,
    flow: [bigint, bigint, bigint, bigint, bigint, bigint],
  ) => {
    if (amount === 0n) return;
    await ctx.USDai.write.approve([tranche.address, MAX_U256], {
      account: ctx.user.account,
    });
    await tranche.write.deposit([amount, ctx.user.account.address], {
      account: ctx.user.account,
    });
    await ctx.accounting.write.updateBalanceFlow(flow, {
      account: ctx.cdo.address as `0x${string}`,
    });
  };

  await depositAndSeed(ctx.jr, amounts.jr, [amounts.jr, 0n, 0n, 0n, 0n, 0n]);
  await depositAndSeed(ctx.mz, amounts.mz, [0n, 0n, amounts.mz, 0n, 0n, 0n]);
  await depositAndSeed(ctx.sr, amounts.sr, [0n, 0n, 0n, 0n, amounts.sr, 0n]);
}
