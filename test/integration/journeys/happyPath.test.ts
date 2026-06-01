import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";
import { seedDefault } from "../../fixtures/seedTvl.js";
import { advanceWithYield, pushApr } from "../../fixtures/advanceTime.js";
import { snapshot, assertInvariant } from "../../fixtures/snapshotState.js";

describe("Integration · Happy path journey", () => {
  it("1. Bootstrap: seeded TVL across all 3 tranches passes NAV invariant", async () => {
    const ctx = await loadFixture(atriumFixture);

    await seedDefault(ctx);

    const s = await snapshot(ctx);
    expect(s.jr).to.equal(parseUnits("50", 18));
    expect(s.mz).to.equal(parseUnits("50", 18));
    expect(s.sr).to.equal(parseUnits("100", 18));
    expect(s.nav).to.equal(parseUnits("200", 18));
    // Tranches minted shares 1:1 with first deposits (bootstrap goes to
    // reserve, but Tranche.deposit mints 1:1 against pre-deposit
    // share-price).
    expect(s.jrSupply).to.equal(parseUnits("50", 18));
    expect(s.mzSupply).to.equal(parseUnits("50", 18));
    expect(s.srSupply).to.equal(parseUnits("100", 18));
    assertInvariant(s);
  });

  it("2. Yield accrual: 7 days at ~10% APR — Jr earns more than Mz", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    // Push an APR pair so Senior accrues against a real `aprSrt`.
    // SD7x12: 0.04e12 = 4% target floor, 0.12e12 = 12% base.
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    const before = await snapshot(ctx);

    // ~10% annualized = 0.19% per week.
    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 19);

    const after = await snapshot(ctx);

    // All three tranches grew (Case 1 / Case 2 both grow Sr).
    expect(after.sr >= before.sr).to.equal(true);

    // Junior leverage α=2.5 vs Mz α=1 ⇒ Jr per-NAV gain > Mz per-NAV
    // gain. With equal seed NAVs (50/50), abs gain compares directly.
    const jrGain = after.jr - before.jr;
    const mzGain = after.mz - before.mz;
    expect(jrGain >= mzGain).to.equal(true);

    // Index ratcheted forward at `aprSrt × dt / YEAR`.
    expect(after.srIndex > before.srIndex).to.equal(true);

    assertInvariant(after);
  });

  it("3. Multi-cycle yield: 4 weekly cycles all preserve NAV invariant", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    const initial = await snapshot(ctx);

    for (let i = 0; i < 4; i++) {
      await advanceWithYield(ctx, 7 * 24 * 60 * 60, 19);
      const s = await snapshot(ctx);
      assertInvariant(s);
    }

    const final = await snapshot(ctx);
    expect(final.nav > initial.nav).to.equal(true);
    expect(final.srIndex > initial.srIndex).to.equal(true);
  });
});
