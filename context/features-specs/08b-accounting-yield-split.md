# 08b - Accounting Yield Split (Case 1 + Case 2)

## Overview

Implement the positive-delta path of `calculateNAVSplit` in
`Accounting.sol`. Strategy reports new TVL; Accounting splits the
gain into Reserve, Senior (per target APR), Mezzanine, Junior.

Ships:

- `calculateNAVSplit` body — split logic for `delta >= 0`.
- Sr target index machinery — `srTargetIndex`, `indexTimestamp`,
  `calculateTargetIndex`, `getSrtTargetIndexT1`.
- Reserve cut from positive delta (`reserveBps`, default 5%).
- Sr APR computation — `aprSrt = max(aprTarget, aprBase × (1 - riskPremium))`.
- Risk premium formula — `x + y × srRatio^k`.
- Residual split between Jr/Mz weighted by `α × TVL`.
- Storage additions: APR fields, target index, risk params, alpha
  weights, reserve bps.
- Setters: `setRiskParameters`, `setReserveBps`, `setAlphaWeights`,
  `setAprPairFeed`.

Out of scope:

- Negative-delta case (loss waterfall) — spec 08c.
- AprPairFeed concrete contract — spec 08b'. This spec consumes the
  interface, falls back to manual APR when feed unset.
- Max-limits edge cases (zero TVL, integer overflow) — spec 08d.
- Fee accrual logic — already shipped in 08a skeleton, body to extend.

---

## Architecture Decisions Recap

| #      | Decision                | Value                                                                                         |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------- |
| D-core | Mz role                 | Jr-light: one target tier (Sr only), two residual claimants (Jr + Mz)                         |
| D1     | Sr APR source           | `IAprPairFeed` oracle (base + target). Fallback to manual when feed = 0                       |
| D2     | Residual split          | `α × TVL` weighted between Jr and Mz                                                          |
| D2.1   | Default α               | `αJr = 2.5e18`, `αMz = 1e18`                                                                  |
| D3     | Accrual method          | Target-index compound                                                                         |
| D4     | Sr APR formula          | `max(aprTarget, aprBase × (1 - riskPremium))`                                                 |
| D4.1   | Risk params             | `riskX = 0.2e18`, `riskY = 0.2e18`, `riskK = 0.3e18` defaults                                 |
| D5     | Reserve cut             | 5% default, owner-tunable, capped at 20%                                                      |
| D6     | srRatio basis           | `srTVL / (jrTVL + mzTVL + srTVL)` — Senior share of total                                     |
| D7     | Negative-Sr-gain safety | Loss path is 08c; this spec asserts `delta >= 0` only                                         |
| D8     | Reserve growth          | Only from delta cut. Fees accrue separately via `accrueFee`                                   |
| D9     | Drain protection        | `srGainTarget` capped at `(jrNav + mzNav) - 2e18` to prevent draining subordinate below 2 wei |

---

## Goals

- Real body for `calculateNAVSplit` covering `delta >= 0` cases.
- Index ratchet that tracks Sr's accumulated target over time.
- Risk premium discounts base APR when Sr ratio is high (less buffer).
- Per-tranche alpha tunable by governance.
- Reserve cut governed by `reserveBps`.
- Consistent state: `navT1 == jrNavT1 + mzNavT1 + srNavT1 + reserveNavT1`.

---

## File Structure

```text
contracts/
├── core/
│   └── Accounting.sol          # amend — add bodies + storage tail
│
└── interfaces/
    └── IAccounting.sol         # amend — public sigs (setters + views)
```

No new files. Spec 08b' creates `AprPairFeed.sol`.

---

## Requirements

### 1. Storage additions

Append to the existing storage tail (after 08a skeleton fields):

```solidity
// --- APR oracle + index ---
IAprPairFeed public aprPairFeed;        // 1 slot
UD60x18 public aprTarget;                // 1 slot — minimum Sr APR (floor)
UD60x18 public aprBase;                  // 1 slot — base APR from feed
UD60x18 public aprSrt;                   // 1 slot — computed Sr APR
uint256 public indexTimestamp;           // 1 slot — last index update
uint256 public srtTargetIndex;           // 1 slot — Sr cumulative index (starts at 1e18)

// --- Risk premium tuning ---
UD60x18 public riskX;                    // 1 slot — base risk
UD60x18 public riskY;                    // 1 slot — scaling
UD60x18 public riskK;                    // 1 slot — exponent

// --- Residual split tuning ---
uint256 public alphaJr;                  // 1 slot — Jr leverage (default 2.5e18)
uint256 public alphaMz;                  // 1 slot — Mz leverage (default 1e18)

// --- Reserve cut ---
uint256 public reserveBps;               // 1 slot — share of positive delta to reserve

// --- Gap reduction ---
__gap[28]                                // reduce from existing 40 by 12 net additions
```

Constants:

```solidity
uint256 constant PERCENTAGE_100 = 1e18;
uint256 constant RESERVE_BPS_MAX = 0.2e18;          // 20% cap
uint256 constant SECONDS_PER_YEAR = 365 days;
uint256 constant MIN_SUBORDINATE_FLOOR = 2e18;      // 2 wei minimum for jr+mz combined
```

`UD60x18` from PRBMath is the fixed-point type used throughout
APR/risk math. 1e18 = 100%.

---

### 2. Initialize defaults

Append to existing `initialize`:

```solidity
function initialize(
    address owner_,
    address acm_,
    ICDO cdo_,
    IAprPairFeed aprPairFeed_,
    UD60x18 aprTarget_,
    UD60x18 aprBase_
) external initializer {
    // ... existing init ...

    aprPairFeed = aprPairFeed_;
    aprTarget = aprTarget_;
    aprBase = aprBase_;

    riskX = UD60x18.wrap(0.2e18);
    riskY = UD60x18.wrap(0.2e18);
    riskK = UD60x18.wrap(0.3e18);

    alphaJr = 2.5e18;
    alphaMz = 1e18;
    reserveBps = 0.05e18;        // 5%

    srtTargetIndex = 1e18;
    indexTimestamp = block.timestamp;

    // Compute initial aprSrt
    aprSrt = aprTarget_;          // safe initial since TVLs are 0
}
```

---

### 3. `calculateNAVSplit` body

```solidity
function calculateNAVSplit(
    uint256 navT0,
    uint256 jrtNavT0,
    uint256 mzNavT0,
    uint256 srtNavT0,
    uint256 reserveNavT0,
    uint256 navT1
) public view returns (
    uint256 jrtNavT1,
    uint256 mzNavT1,
    uint256 srtNavT1,
    uint256 reserveNavT1
) {
    // Bootstrap: no tranche deposits yet, send any gain to reserve.
    if (jrtNavT0 == 0 && mzNavT0 == 0 && srtNavT0 == 0 && navT1 > 0) {
        return (0, 0, 0, navT1);
    }

    int256 delta = int256(navT1) - int256(navT0);

    if (delta < 0) {
        // Loss waterfall lives in spec 08c. Until 08c lands, revert.
        revert NotImplemented();
    }

    uint256 deltaAbs = uint256(delta);

    // Step 1: reserve cut from positive delta
    uint256 reserveCut = 0;
    if (deltaAbs > 0 && reserveBps > 0) {
        reserveCut = deltaAbs * reserveBps / PERCENTAGE_100;
        deltaAbs -= reserveCut;
    }
    reserveNavT1 = reserveNavT0 + reserveCut;

    // Step 2: compute Sr's target gain via index ratchet
    uint256 srtTargetIndexT1 = getSrtTargetIndexT1();
    int256 srtGainTarget = calculateGain(srtNavT0, srtTargetIndexT1, srtTargetIndex);
    if (srtGainTarget < 0) srtGainTarget = 0;

    uint256 srtGainTargetAbs = uint256(srtGainTarget);

    // Step 3: branch on whether delta covers Sr's target.
    //
    // Case 1 (delta >= srTarget): yield is enough for Sr + residual for Jr/Mz.
    //   srNavT1 = srNavT0 + srTarget
    //   residual = delta - srTarget  (split between Jr and Mz)
    //   jrNavT1 = jrNavT0 + jrShare
    //   mzNavT1 = mzNavT0 + mzShare
    //
    // Case 2 (delta < srTarget): yield insufficient for Sr. Jr/Mz fund the gap.
    //   Sr still gets full target.
    //   Shortfall = srTarget - delta  (consumed from Jr/Mz pool)
    //   shortfall capped so that (jr + mz - shortfall) >= MIN_SUBORDINATE_FLOOR.

    if (deltaAbs >= srtGainTargetAbs) {
        // Case 1: meets target
        srtNavT1 = srtNavT0 + srtGainTargetAbs;
        uint256 residual = deltaAbs - srtGainTargetAbs;
        (uint256 jrGain, uint256 mzGain) = _splitResidual(jrtNavT0, mzNavT0, residual);
        jrtNavT1 = jrtNavT0 + jrGain;
        mzNavT1 = mzNavT0 + mzGain;
    } else {
        // Case 2: drag — subordinate funds Sr shortfall
        uint256 shortfall = srtGainTargetAbs - deltaAbs;
        uint256 subordinatePool = jrtNavT0 + mzNavT0;

        // Cap shortfall so subordinate stays above floor
        uint256 maxAbsorbable = Math.saturatingSub(subordinatePool, MIN_SUBORDINATE_FLOOR);
        if (shortfall > maxAbsorbable) {
            shortfall = maxAbsorbable;
        }

        srtNavT1 = srtNavT0 + deltaAbs + shortfall;

        // Distribute shortfall PROPORTIONALLY across Jr/Mz by α × TVL.
        // Jr (higher α) takes proportionally more of the loss too.
        (uint256 jrShortfall, uint256 mzShortfall) = _splitResidual(jrtNavT0, mzNavT0, shortfall);
        jrtNavT1 = jrtNavT0 - jrShortfall;
        mzNavT1 = mzNavT0 - mzShortfall;
    }

    // Step 4: invariant check
    if (navT1 != jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1) {
        revert InvalidNavSplit(navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
    }
}
```

Notes:

- Bootstrap branch handles "no deposits yet, Strategy gained yield"
  by routing everything to reserve.
- Negative delta path reverts `NotImplemented` until 08c lands.
- Cases 1 and 2 are explicit branches now: Case 1 is the happy path
  (Sr target met, residual to Jr/Mz). Case 2 is the drag (Jr/Mz fund
  Sr shortfall, both lose proportionally by α × TVL weight).
- `_splitResidual` is reused for both gain distribution (Case 1) and
  loss distribution (Case 2) — same formula, different sign of net
  movement.

---

### 4. `_splitResidual` internal

```solidity
function _splitResidual(uint256 jrtNavT0, uint256 mzNavT0, uint256 residualTotal)
    internal view returns (uint256 jrtNavT1, uint256 mzNavT1)
{
    if (residualTotal == 0) return (0, 0);

    uint256 jrWeight = jrtNavT0 * alphaJr;
    uint256 mzWeight = mzNavT0 * alphaMz;
    uint256 total = jrWeight + mzWeight;

    if (total == 0) {
        // Both NAVs zero but residual > 0. Edge — split 50/50 by alpha only.
        uint256 alphaTotal = alphaJr + alphaMz;
        jrtNavT1 = residualTotal * alphaJr / alphaTotal;
        mzNavT1 = residualTotal - jrtNavT1;
        return (jrtNavT1, mzNavT1);
    }

    jrtNavT1 = residualTotal * jrWeight / total;
    mzNavT1 = residualTotal - jrtNavT1;     // subtract to avoid rounding mismatch
}
```

`mzNavT1 = residualTotal - jrtNavT1` is intentional — using
`residualTotal * mzWeight / total` would risk a 1-wei underflow vs
the `jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1 == navT1`
invariant. Computing one share via division and the other as
remainder guarantees the sum is exact.

The `total == 0` branch handles a corner: yield arrives while both
Jr/Mz NAVs are zero (e.g. after a wipeout in Case 4, recovery
phase). Split residual by alpha weights alone.

---

### 5. Target index helpers

```solidity
function getSrtTargetIndexT1() internal view returns (uint256) {
    return calculateTargetIndex(srtTargetIndex, indexTimestamp, block.timestamp, aprSrt);
}

function calculateTargetIndex(
    uint256 targetIndex,
    uint256 t0,
    uint256 t1,
    UD60x18 apr
) internal pure returns (uint256) {
    uint256 dt = t1 - t0;
    if (dt == 0) return targetIndex;
    uint256 interestFactor = apr.unwrap() * dt / SECONDS_PER_YEAR;
    return targetIndex * (1e18 + interestFactor) / 1e18;
}

function calculateGain(uint256 navT0, uint256 targetIndexT1, uint256 targetIndexT0)
    internal pure returns (int256)
{
    return int256(navT0 * targetIndexT1 / targetIndexT0) - int256(navT0);
}
```

Index ratchet: `srtTargetIndex` starts at `1e18` and grows
multiplicatively each `updateAccounting`. The growth factor for
period dt is `1 + APR × dt / YEAR`. Sr's entitled gain is
`navT0 × (index1 / index0 - 1)`.

This is **linear-per-period compound** — the APR doesn't compound
inside a single period, but compounding kicks in across periods
since each period's growth multiplies the previous index. Sufficient
for sub-day update cadence; converges to true compound as period → 0.

---

### 6. Sr APR risk premium

```solidity
function calculateRiskPremium() internal view returns (UD60x18) {
    uint256 totalSubordinate = jrtNav + mzNav;
    uint256 totalTvl = totalSubordinate + srtNav;
    UD60x18 srRatio = UD60x18.wrap(totalTvl == 0 ? 0 : (srtNav * 1e18 / totalTvl));
    return calculateRiskPremiumInner(riskX, riskY, riskK, srRatio);
}

function calculateRiskPremiumInner(
    UD60x18 x,
    UD60x18 y,
    UD60x18 k,
    UD60x18 srRatio
) internal pure returns (UD60x18) {
    // riskPremium = x + y × srRatio^k
    return x + y * pow(srRatio, k);
}

function updateAprSrt(UD60x18 aprTarget_, UD60x18 aprBase_) internal {
    UD60x18 risk = calculateRiskPremium();
    UD60x18 aprDiscounted = mul(aprBase_, UD60x18.wrap(1e18) - risk);
    aprSrt = UD60x18Ext.max(aprTarget_, aprDiscounted);
}
```

Interpretation: when Sr is a large share of TVL (less subordinate
buffer), `srRatio` is high, `risk` is high, the discounted base APR
shrinks. But the target floor protects Sr from earning below
`aprTarget`. The floor ensures Atrium's Sr product has a marketable
guaranteed yield.

Atrium's 3-tranche extension: `totalSubordinate = jrtNav + mzNav`.
The risk premium scales identically — Sr
position is still measured against everything below it.

---

### 7. `updateAccounting` flow integration

The 08a skeleton has `updateAccounting(uint256 navT1)` calling an
internal `updateAccountingInner`. Extend that internal:

```solidity
function updateAccountingInner(uint256 navT1) internal {
    // 1. Refresh APRs from feed (if wired).
    (bool aprChanged, , ) = fetchAprs();

    // 2. Update Sr's APR using current state — captures any risk-premium
    //    change since last refresh.
    if (aprChanged) {
        // updateAprSrt already called inside fetchAprs on change
    } else {
        updateAprSrt(aprTarget, aprBase);
    }

    // 3. Split delta into the four buckets.
    (uint256 jrtNavT1, uint256 mzNavT1, uint256 srtNavT1, uint256 reserveNavT1)
        = calculateNAVSplit(nav, jrtNav, mzNav, srtNav, reserveNav, navT1);

    // 4. Roll the index forward (captures elapsed time at current aprSrt).
    updateIndex();

    // 5. Commit state.
    nav = navT1;
    jrtNav = jrtNavT1;
    mzNav = mzNavT1;
    srtNav = srtNavT1;
    reserveNav = reserveNavT1;
}

function updateIndex() internal {
    srtTargetIndex = getSrtTargetIndexT1();
    indexTimestamp = block.timestamp;
}

function fetchAprs() internal returns (bool modified, UD60x18 aprTargetT1, UD60x18 aprBaseT1) {
    if (address(aprPairFeed) == address(0)) {
        return (false, aprTarget, aprBase);
    }
    IAprPairFeed.TRound memory round = aprPairFeed.latestRoundData();
    aprTargetT1 = normalizeAprFromFeed(round.aprTarget);
    aprBaseT1 = normalizeAprFromFeed(round.aprBase);
    if (aprTargetT1 != aprTarget || aprBaseT1 != aprBase) {
        aprTarget = aprTargetT1;
        aprBase = aprBaseT1;
        updateAprSrt(aprTargetT1, aprBaseT1);
        return (true, aprTargetT1, aprBaseT1);
    }
    return (false, aprTargetT1, aprBaseT1);
}

function normalizeAprFromFeed(int64 apr) internal pure returns (UD60x18) {
    if (apr < 0) return UD60x18.wrap(0);
    // Feed stores APR as int64 with 12 decimals. Convert to UD60x18 (18 decimals).
    return UD60x18.wrap(uint256(int256(apr)) * 1e6);
}
```

The order matters: refresh APRs BEFORE split, then split, THEN roll
index. The index covers the period from last `indexTimestamp` to
now, so it must roll forward AFTER the split has captured the
gain.

---

### 8. Setters (admin)

```solidity
function setRiskParameters(UD60x18 x, UD60x18 y, UD60x18 k)
    external onlyRole(UPDATER_CDO_APR_ROLE)
{
    // Sanity bounds — risk premium must stay in [0, 1).
    // x + y × 1^k = x + y must be < 1e18.
    if (x.unwrap() + y.unwrap() >= 1e18) revert InvalidRiskParams();
    riskX = x;
    riskY = y;
    riskK = k;
    emit RiskParametersChanged(x, y, k);
}

function setReserveBps(uint256 bps) external onlyRole(UPDATER_CDO_APR_ROLE) {
    if (bps > RESERVE_BPS_MAX) revert InvalidReserveBps(bps);
    reserveBps = bps;
    emit ReservePercentageChanged(bps);
}

function setAlphaWeights(uint256 jr, uint256 mz)
    external onlyRole(UPDATER_CDO_APR_ROLE)
{
    if (jr == 0 || mz == 0) revert InvalidAlphaWeights();
    if (jr > 10e18 || mz > 10e18) revert InvalidAlphaWeights();
    alphaJr = jr;
    alphaMz = mz;
    emit AlphaWeightsChanged(jr, mz);
}

function setAprPairFeed(IAprPairFeed feed) external onlyOwner {
    aprPairFeed = feed;
    emit AprPairFeedChanged(address(feed));
}

function onAprChanged() external onlyRole(UPDATER_FEED_ROLE) {
    // Permissionless-ish entry: trusted feed pusher signals an APR change.
    // Forces a refresh — useful when the feed updates between user actions.
    fetchAprs();
}
```

Errors:

```solidity
error InvalidNavSplit(uint256 navT1, uint256 jrt, uint256 mz, uint256 srt, uint256 reserve);
error InvalidRiskParams();
error InvalidReserveBps(uint256 bps);
error InvalidAlphaWeights();
error NotImplemented();
```

Events:

```solidity
event AprPairFeedChanged(address aprPairFeed);
event ReservePercentageChanged(uint256 reserveBps);
event RiskParametersChanged(UD60x18 x, UD60x18 y, UD60x18 k);
event AlphaWeightsChanged(uint256 alphaJr, uint256 alphaMz);
```

---

## Notes

### Why Case 1 and Case 2 are explicit branches

Initial draft attempted to collapse both cases into a single
`subordinatePool = jr + mz + delta` formula. This is mathematically
elegant but produces wrong results in the **Case 1 happy path**:
when `delta < (jr + mz)` and Sr's target is small, the formula
re-distributes the existing Jr/Mz NAV via α-weighted split, which
shifts capital between tranches regardless of where the gain
actually flowed.

Correct semantics:

| Case                     | Sr                 | Jr                         | Mz                         |
| ------------------------ | ------------------ | -------------------------- | -------------------------- |
| Case 1: delta ≥ srTarget | +srTarget          | jr0 + α-share of residual  | mz0 + α-share of residual  |
| Case 2: delta < srTarget | +delta + shortfall | jr0 - α-share of shortfall | mz0 - α-share of shortfall |

Each tranche's NAV deltas come **only from the period's net flow**
(gain or shortfall), never from a redistribution of existing
balances. `_splitResidual` is called with the residual _amount_
(gain or shortfall) to determine each tranche's share — but always
added to or subtracted from the existing NAV, not replacing it.

### Why subordinate floor (2 wei minimum)

`MIN_SUBORDINATE_FLOOR = 2e18` (2 wei combined Jr+Mz) prevents Sr's
target from completely draining the subordinate pool. Without it, a
prolonged Case 2 could push Jr+Mz to zero, breaking ERC4626 share
math on those tranches.

`MIN_SUBORDINATE_FLOOR = 2e18` because the combined pool absorbs in two halves — one wei reserved
per tranche.

### Risk premium semantics

`riskPremium = x + y × srRatio^k`:

- `x = 0.2`: baseline 20% discount of base APR regardless of ratio.
- `y = 0.2`: scaling coefficient.
- `k = 0.3`: exponent — convex when k < 1, concave when k > 1.

At srRatio = 1 (Sr is everything), riskPremium = x + y = 40%. Sr
earns at most 60% of base APR but never less than aprTarget.

At srRatio = 0 (Sr is nothing), riskPremium = x = 20%. Floor case.

The `< 1` constraint on `x + y` ensures `(1 - risk) > 0` always —
preventing negative APR.

### Alpha values and economic interpretation

`αJr = 2.5e18, αMz = 1e18`:

- Per dollar deposited, Jr earns 2.5× the residual yield per dollar
  Mz earns.
- E.g. equal NAV: Jr gets 71% of residual, Mz gets 29%.
- E.g. Jr = $100, Mz = $300: Jr weight = 250, Mz weight = 300.
  Jr gets 45% of residual, Mz gets 55%.

Higher `αJr` makes Jr more aggressive (rewards risk takers more);
governance tunes based on observed loss rates and capital flow.

### Reserve cut as insurance

5% of every positive delta accumulates in `reserveNav`. This builds
a buffer used in Case 3 / 4 (loss absorption) — covered in spec
08c. Without the cut, Reserve grows only from explicit fees.

`RESERVE_BPS_MAX = 0.2e18` caps the cut at 20% — beyond that, the
protocol confiscates more yield than competitive products allow.

### Where 08b ends and 08c begins

08b draws a hard line: `delta < 0` reverts `NotImplemented`. This
keeps the deploy compileable and unit-testable for the gain path
without coupling to loss-waterfall decisions. 08c replaces that
single revert with the four-step loss absorption (Jr → Mz →
Reserve → Sr).

### Index ratchet behavior across updates

Each `updateAccounting` call:

1. Reads current `srtTargetIndex` and `indexTimestamp`.
2. Computes `index1 = index0 × (1 + APR × dt / YEAR)`.
3. Sr's gain for this period = `srNav × (index1 / index0 - 1)`.
4. After the split, sets `srtTargetIndex = index1`, `indexTimestamp = now`.

If `updateAccounting` is never called for a long stretch, the index
catches up in one big jump on the next call. This is mathematically
fine but can produce a surprising-looking Sr gain. Spec 08c may
introduce a per-call max delta guard.

### Why owner-only on `setAprPairFeed`

Feed contract is governance-critical infrastructure. Wiring the
wrong feed could mis-price Sr APR catastrophically. Only owner
multi-sig should change it.

`setRiskParameters` and `setReserveBps` are role-gated to
`UPDATER_CDO_APR_ROLE` — risk team multi-sig.

---

## Non-Goals

- Loss waterfall (spec 08c).
- AprPairFeed concrete (spec 08b').
- Tranche-specific fee retention bps (deferred — fees go fully to
  reserve in 08b).
- Per-call max gain guard.
- Migration tooling if alpha/risk params change mid-flight.

---

## Acceptance Criteria

- `calculateNAVSplit` returns valid 4-tuple satisfying
  `navT1 == jrt + mz + srt + reserve`.
- `delta >= 0` paths compute the split correctly.
- `delta < 0` reverts `NotImplemented` (defer to 08c).
- `srtTargetIndex` grows monotonically across `updateAccounting`
  calls.
- `aprSrt` updates when `aprPairFeed` reports new values.
- `aprSrt >= aprTarget` always — floor honoured.
- Sr's gain capped so `jr + mz >= MIN_SUBORDINATE_FLOOR` after split.
- Reserve cut respects `reserveBps`, capped at `RESERVE_BPS_MAX`.
- `_splitResidual` returns `jr + mz == residualTotal` exactly.
- Setters revert on out-of-range inputs.
- Setters emit corresponding events.
- Compiles under solc 0.8.35 with PRBMath UD60x18.
- Storage layout: 12 new slots, `__gap[28]` final.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 08b to Completed.
  - Architecture decisions:
    - Case 1+2 collapse in single arithmetic.
    - α × TVL residual split with default 2.5/1.
    - Sr APR via risk premium formula `x + y × srRatio^k`.
    - 5% default reserve cut from positive delta.
    - Sub-floor `MIN_SUBORDINATE_FLOOR = 2e18`.
  - Open questions:
    - Per-call max gain guard (handle long-uncalled periods).
    - Whether `feeJrtRetentionBps` / `feeMzRetentionBps` /
      `feeSrtRetentionBps` are needed.
    - Whether `aprBase` change should trigger Sr index recompute or
      defer until next `updateAccounting`.
    - Whether bootstrap branch (all NAVs zero, navT1 > 0) should
      revert instead of routing to reserve.
- Spec 08c (loss waterfall) unblocked.
- Spec 08b' (AprPairFeed) needed for full runtime — current spec
  works with `aprPairFeed = address(0)` and manual APR.
