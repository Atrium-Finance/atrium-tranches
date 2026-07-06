/**
 * Integration-test helper: advance time and simulate strategy NAV change.
 *
 * Yield is simulated by inflating the sUSDai exchange rate via
 * `setTotalAssets(...)` on `MockSUSDai`, then triggering a fresh
 * `cdo.updateAccounting()` via a tranche impersonation (the entry is
 * `onlyTranche`). APR feed push is optional — when an APR pair is
 * provided we push it through `MockAprPairFeed.setLatestRound`.
 */
import { parseUnits } from "viem";
import { time, impersonateAccount, setBalance } from "../helpers/network-helpers.js";

export interface YieldCtx {
  cdo: any;
  accounting: any;
  strategy: any;
  susdai: any;
  mockFeed: any;
  jr: any;
}

/**
 * Grow sUSDai's `totalAssets()` by `yieldBps` basis points over
 * `seconds`, then trigger a fresh accounting refresh.
 *
 * yieldBps = 19 → +0.19% (≈ 10% APR weekly compounded once a week)
 */
export async function advanceWithYield(
  ctx: YieldCtx,
  seconds: number,
  yieldBps: number
) {
  // Read current sUSDai total assets, inflate by yieldBps.
  const currentTotal = await ctx.susdai.read.totalAssets();
  const newTotal =
    (currentTotal * (10000n + BigInt(yieldBps))) / 10000n;
  await ctx.susdai.write.setTotalAssets([newTotal]);

  await time.increase(seconds);

  await _refreshAccounting(ctx);
}

/**
 * Drop sUSDai's `totalAssets()` by `lossBps` basis points over
 * `seconds`, then trigger a fresh accounting refresh.
 */
export async function advanceWithLoss(
  ctx: YieldCtx,
  seconds: number,
  lossBps: number
) {
  const currentTotal = await ctx.susdai.read.totalAssets();
  const newTotal =
    (currentTotal * (10000n - BigInt(lossBps))) / 10000n;
  await ctx.susdai.write.setTotalAssets([newTotal]);

  await time.increase(seconds);

  await _refreshAccounting(ctx);
}

/**
 * Push an APR pair into the mock feed and call `onAprChanged`. APRs
 * encoded as SD7x12 (e.g. `0.04e12 = 4%`). Grants `UPDATER_FEED_ROLE`
 * to `owner` on the fly (idempotent — `grantRole` is a no-op when the
 * role is already held).
 */
export async function pushApr(
  ctx: {
    mockFeed: any;
    accounting: any;
    acm: any;
    owner: any;
  },
  aprTarget: bigint,
  aprBase: bigint,
  roundId: bigint = 1n
) {
  const UPDATER_FEED_ROLE =
    (await ctx.accounting.read.UPDATER_FEED_ROLE()) as `0x${string}`;
  await ctx.acm.write.grantRole([UPDATER_FEED_ROLE, ctx.owner.account.address]);

  const now = await time.latest();
  await ctx.mockFeed.write.setLatestRound([
    aprTarget,
    aprBase,
    roundId,
    BigInt(now),
  ]);
  await ctx.accounting.write.onAprChanged({ account: ctx.owner.account });
}

/**
 * Trigger a fresh accounting refresh by impersonating the Jr tranche
 * (cdo.updateAccounting is `onlyTranche`).
 */
async function _refreshAccounting(ctx: YieldCtx) {
  await impersonateAccount(ctx.jr.address);
  await setBalance(ctx.jr.address, parseUnits("10", 18));
  await ctx.cdo.write.updateAccounting({
    account: ctx.jr.address as `0x${string}`,
  });
}
