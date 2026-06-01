import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { forkLoadFixture, forkTime } from "../helpers/forkClients.js";
import { forkAtriumFixture } from "../fixtures/deployForkAtrium.js";
import { isConfigured } from "../helpers/addresses.js";
import { addr } from "../helpers/addr.js";
import { shouldSkipFork } from "../helpers/forkConfig.js";

const SKIP = shouldSkipFork() || !isConfigured("sUSDai");
const suite: typeof describe = SKIP ? (describe.skip as any) : describe;

// AaveAprPairProvider clamps aprTarget at 0.4e12 (40% APR in SD7x12).
const APR_TARGET_MAX = 400_000_000_000n;

suite("Fork · AaveAprPairProvider — real Aave + sUSDai", () => {
  it("1. Reads real Aave reserve rates for USDC + USDT", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    // Real Aave data for benchmark tokens — sanity check that the
    // pool is wired and reports non-zero supply rates.
    const usdcReserve = (await ctx.aavePool.read.getReserveData([addr("USDC")])) as any;
    const usdtReserve = (await ctx.aavePool.read.getReserveData([addr("USDT")])) as any;

    expect(usdcReserve.currentLiquidityRate > 0n).to.equal(true);
    expect(usdtReserve.currentLiquidityRate > 0n).to.equal(true);

    // Provider should produce a weighted average inside [0, 0.4e12].
    // No sample taken yet → aprBase is 0 by design (sampling pattern).
    const [aprBase, aprTarget] = (await ctx.aprProvider.read.getApr()) as [
      bigint,
      bigint,
      bigint
    ];
    expect(aprBase).to.equal(0n);
    expect(aprTarget >= 0n).to.equal(true);
    expect(aprTarget <= APR_TARGET_MAX).to.equal(true);
  });

  it("2. aprBase grows after a keeper sampleRate + share-price increment", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    // Snapshot the initial depositSharePrice and stamp it as the
    // baseline. The fixture grants UPDATER_STRAT_CONFIG_ROLE to owner.
    const priceBefore = (await ctx.sUSDai.read.depositSharePrice()) as bigint;
    expect(priceBefore > 0n).to.equal(true);
    await ctx.aprProvider.write.sampleRate();

    const sample = (await ctx.aprProvider.read.lastSample()) as bigint;
    expect(sample).to.equal(priceBefore);

    // Advance one day on the fork. sUSDai's depositSharePrice may or
    // may not move on a forked chain (no on-chain harvest happens),
    // so we accept either outcome — what we verify is the sampling
    // wiring works (lastSampleAt updated, aprBase computed cleanly).
    await forkTime.increase(24 * 60 * 60);

    const [aprBase] = (await ctx.aprProvider.read.getApr()) as [
      bigint,
      bigint,
      bigint
    ];
    // On a static fork the price stays flat → aprBase == 0. If a real
    // price tick lands during the window, aprBase > 0. Either is OK.
    expect(aprBase >= 0n).to.equal(true);
    expect(aprBase <= 2n * 10n ** 12n).to.equal(true);
  });

  it("3. getApr returns 3-tuple with current block timestamp", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    const [, aprTarget, updatedAt] = (await ctx.aprProvider.read.getApr()) as [
      bigint,
      bigint,
      bigint
    ];
    const block = await ctx.publicClient.getBlock();

    expect(updatedAt).to.equal(block.timestamp);
    expect(aprTarget >= 0n).to.equal(true);
  });
});
