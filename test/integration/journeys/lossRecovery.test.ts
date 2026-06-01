import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";
import { seedDefault } from "../../fixtures/seedTvl.js";
import {
  advanceWithLoss,
  advanceWithYield,
  pushApr,
} from "../../fixtures/advanceTime.js";
import { snapshot, assertInvariant } from "../../fixtures/snapshotState.js";

describe("Integration · Loss recovery journey", () => {
  it("1. Mild loss within Jr buffer — Mz / Sr untouched", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx); // jr=50, mz=50, sr=100, nav=200

    // No APR push — keep Sr target accrual minimal so the loss path
    // dominates the next refresh.
    const before = await snapshot(ctx);

    // 5% drop on nav=200 ⇒ loss ≈ 10 USDai, well within Jr=50.
    await advanceWithLoss(ctx, 1 * 24 * 60 * 60, 500);

    const after = await snapshot(ctx);

    // Jr absorbed loss first per D11 cascade.
    expect(after.jr < before.jr).to.equal(true);

    // Mz untouched (loss did not reach it).
    expect(after.mz).to.equal(before.mz);

    // Sr NAV is at-least the pre-loss Sr (it may have grown a tiny
    // amount via index, but did not absorb).
    expect(after.sr >= before.sr).to.equal(true);

    // Reserve excluded from absorption per D6.
    expect(after.reserve).to.equal(before.reserve);

    assertInvariant(after);
  });

  it("2. Catastrophic loss exceeding Jr+Mz buffer impairs Sr", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx); // jr+mz=100 buffer, sr=100

    const before = await snapshot(ctx);

    // 60% drop on nav=200 ⇒ loss ≈ 120 USDai, exceeds Jr+Mz=100, hits
    // Sr by ~20 USDai.
    await advanceWithLoss(ctx, 1 * 24 * 60 * 60, 6000);

    const after = await snapshot(ctx);

    // Jr wiped.
    expect(after.jr).to.equal(0n);

    // Mz wiped (or very close — depends on exact loss split).
    expect(after.mz <= parseUnits("0.01", 18)).to.equal(true);

    // Sr impaired.
    expect(after.sr < before.sr).to.equal(true);

    // Reserve untouched per D6.
    expect(after.reserve).to.equal(before.reserve);

    assertInvariant(after);
  });

  it("3. Sr does not auto-recover impairment via index after a loss event", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    // Cause impairment.
    await advanceWithLoss(ctx, 1 * 24 * 60 * 60, 6000);
    const afterLoss = await snapshot(ctx);

    // Index keeps ratcheting per D8 — Sr accrues target APR on the
    // reduced NAV. Subsequent yield grows Sr but does NOT restore the
    // original principal.
    await advanceWithYield(ctx, 30 * 24 * 60 * 60, 200);
    const afterRecover = await snapshot(ctx);

    expect(afterRecover.srIndex > afterLoss.srIndex).to.equal(true);
    expect(afterRecover.sr >= afterLoss.sr).to.equal(true);

    assertInvariant(afterRecover);
  });
});
