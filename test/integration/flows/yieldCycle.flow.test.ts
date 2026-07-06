import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";
import { seedDefault } from "../../fixtures/seedTvl.js";
import { advanceWithYield, pushApr } from "../../fixtures/advanceTime.js";
import { snapshot, assertInvariant } from "../../fixtures/snapshotState.js";

describe("Integration · Yield cycle flow", () => {
  it("1. Case 1 (sufficient yield): Sr meets target, Jr / Mz share residual", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    const before = await snapshot(ctx);

    // Generous yield: 200 bps over 1 week (≈ 100% APR).
    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 200);

    const after = await snapshot(ctx);

    // Sr received its target.
    expect(after.sr >= before.sr).to.equal(true);

    // Jr and Mz both got yield from residual split.
    expect(after.jr >= before.jr).to.equal(true);
    expect(after.mz >= before.mz).to.equal(true);

    // Reserve cut applied (5% default).
    expect(after.reserve >= before.reserve).to.equal(true);

    // αJr=2.5, αMz=1 with equal NAV ⇒ Jr gain ≥ Mz gain in residual.
    expect(after.jr - before.jr >= after.mz - before.mz).to.equal(true);

    assertInvariant(after);
  });

  it("2. srtTargetIndex monotonically ratchets across cycles", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    const before = await snapshot(ctx);

    let lastIndex = before.srIndex;
    for (let i = 0; i < 3; i++) {
      await advanceWithYield(ctx, 7 * 24 * 60 * 60, 19);
      const s = await snapshot(ctx);
      expect(s.srIndex > lastIndex).to.equal(true);
      lastIndex = s.srIndex;
      assertInvariant(s);
    }
  });
});
