import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { forkLoadFixture, forkTime } from "../helpers/forkClients.js";
import { forkAtriumFixture } from "../fixtures/deployForkAtrium.js";
import { isConfigured } from "../helpers/addresses.js";
import { shouldSkipFork } from "../helpers/forkConfig.js";

const SKIP = shouldSkipFork() || !isConfigured("sUSDai");
const suite: typeof describe = SKIP ? (describe.skip as any) : describe;

const SOURCE_FEED = 0;

suite("Fork · Yield cycle — real AprPairFeed + provider", () => {
  it("1. Fixture pre-seeded the feed → latestRoundData returns cached values", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    // The fork fixture PUSHes an initial round (0.12e12 base, 0.04e12
    // target) so accounting refreshes during deposit/withdraw don't
    // depend on provider PULL. Verify the cached read works.
    const round = (await ctx.feed.read.latestRoundData()) as any;

    expect(round.aprBase).to.equal(120_000_000_000n); // 0.12e12
    expect(round.aprTarget).to.equal(40_000_000_000n); // 0.04e12
    expect(round.updatedAt > 0n).to.equal(true);

    const pref = (await ctx.feed.read.sourcePref()) as number;
    expect(pref).to.equal(SOURCE_FEED);
  });

  it("2. After staleness window, latestRoundData falls back to provider PULL", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    // Stored round from the fixture (via the explicit getter — the
    // auto-generated `latestRound` getter returns a flat tuple).
    const storedBefore = (await ctx.feed.read.latestRoundData()) as any;
    expect(storedBefore.aprBase).to.equal(120_000_000_000n);

    // Advance past the 24h stale window — latestRoundData should fall
    // back to PULL, calling provider.getApr() at the current block.
    await forkTime.increase(25 * 60 * 60);

    const fallback = (await ctx.feed.read.latestRoundData()) as any;

    // PULL fetches current block timestamp + provider's live values.
    // Provider's aprBase is 0 (no sampleRate yet); aprTarget is the
    // Aave weighted average — within bounds [0, 0.4e12].
    expect(fallback.updatedAt > storedBefore.updatedAt).to.equal(true);
    expect(fallback.aprBase).to.equal(0n);
    expect(fallback.aprTarget >= 0n).to.equal(true);
    expect(fallback.aprTarget <= 400_000_000_000n).to.equal(true);
  });
});
