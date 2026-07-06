import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { forkLoadFixture } from "../helpers/forkClients.js";
import { forkAtriumFixture } from "../fixtures/deployForkAtrium.js";
import { seedForkTvl } from "../fixtures/seedForkTvl.js";
import { snapshot, assertInvariant } from "../../fixtures/snapshotState.js";
import { isConfigured } from "../helpers/addresses.js";
import { addr } from "../helpers/addr.js";
import { shouldSkipFork } from "../helpers/forkConfig.js";
import { fundFromWhale } from "../helpers/whaleFunding.js";

const SKIP = shouldSkipFork() || !isConfigured("sUSDai", "whaleSUSDai");

const suite: typeof describe = SKIP ? (describe.skip as any) : describe;

suite("Fork · Deposit journey — real sUSDai", () => {
  it("1. Jr deposit via full chain — NAV invariant holds", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    // Seed Jr first to skip bootstrap branch, then verify a follow-up
    // Jr deposit lands in the Jr bucket (not reserve).
    await seedForkTvl(ctx, {
      jr: parseUnits("10", 18),
      mz: 0n,
      sr: 0n,
    });

    const before = await snapshot(ctx);

    const amount = parseUnits("50", 18);
    await fundFromWhale(addr("whaleUSDai"), ctx.user.account.address, ctx.USDai, amount);
    await ctx.USDai.write.approve([ctx.jr.address, amount], {
      account: ctx.user.account,
    });
    await ctx.jr.write.deposit([amount, ctx.user.account.address], {
      account: ctx.user.account,
    });

    const after = await snapshot(ctx);
    expect(after.jr > before.jr).to.equal(true);
    assertInvariant(after);
  });

  it("2. Jr / Mz / Sr deposits land in their respective buckets", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    await seedForkTvl(ctx, {
      jr: parseUnits("50", 18),
      mz: parseUnits("50", 18),
      sr: parseUnits("100", 18),
    });

    const s = await snapshot(ctx);
    expect(s.jr > 0n).to.equal(true);
    expect(s.mz > 0n).to.equal(true);
    expect(s.sr > 0n).to.equal(true);
    assertInvariant(s);
  });
});
