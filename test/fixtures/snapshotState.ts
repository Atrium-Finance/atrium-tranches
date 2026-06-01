/**
 * Integration-test helper: snapshot full Atrium state for diff-based
 * assertions across transitions. The NAV invariant
 * `nav == jr + mz + sr + reserve` must hold after every state-mutating
 * operation.
 */
import { expect } from "../helpers/chai-setup.js";

export interface Snapshot {
  jr: bigint;
  mz: bigint;
  sr: bigint;
  reserve: bigint;
  nav: bigint;
  srIndex: bigint;
  jrSupply: bigint;
  mzSupply: bigint;
  srSupply: bigint;
}

export interface SnapshotCtx {
  accounting: any;
  jr: any;
  mz: any;
  sr: any;
}

export async function snapshot(ctx: SnapshotCtx): Promise<Snapshot> {
  const [jrTvl, mzTvl, srTvl, reserveTvl] =
    (await ctx.accounting.read.totalAssetsT0()) as [
      bigint,
      bigint,
      bigint,
      bigint
    ];
  const nav = (await ctx.accounting.read.nav()) as bigint;
  const srIndex = (await ctx.accounting.read.srtTargetIndex()) as bigint;

  const jrSupply = (await ctx.jr.read.totalSupply()) as bigint;
  const mzSupply = (await ctx.mz.read.totalSupply()) as bigint;
  const srSupply = (await ctx.sr.read.totalSupply()) as bigint;

  return {
    jr: jrTvl,
    mz: mzTvl,
    sr: srTvl,
    reserve: reserveTvl,
    nav,
    srIndex,
    jrSupply,
    mzSupply,
    srSupply,
  };
}

/** NAV conservation: `nav == jr + mz + sr + reserve`. */
export function assertInvariant(s: Snapshot) {
  expect(s.nav).to.equal(
    s.jr + s.mz + s.sr + s.reserve,
    "NAV invariant broken"
  );
}

/** Pretty-print snapshot for debugging. */
export function logSnapshot(label: string, s: Snapshot) {
  // eslint-disable-next-line no-console
  console.log(`\n=== ${label} ===`);
  console.log(`  Jr:      ${s.jr.toString()}`);
  console.log(`  Mz:      ${s.mz.toString()}`);
  console.log(`  Sr:      ${s.sr.toString()}`);
  console.log(`  Reserve: ${s.reserve.toString()}`);
  console.log(`  NAV:     ${s.nav.toString()}`);
  console.log(`  srIndex: ${s.srIndex.toString()}`);
}
