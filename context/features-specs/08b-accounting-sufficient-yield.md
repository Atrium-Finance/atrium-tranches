# 08b - Accounting: `updateAccounting` Case 1 (Sufficient Yield)

## Overview

Implement the math body of `Accounting.updateAccounting(navT1)` for
the **sufficient-yield case** defined in `project-overview.md` (Case 1),
plus the full APR infrastructure that drives Senior's target rate.

This spec ships:

- **Case 1 yield split**: reserve cut → Senior target via index →
  Mz/Jr base entitlements → residual (RP_delivered + excess) split by
  `share_jr/mz`.
- **APR Feed integration on the Accounting side**: feed reference,
  pull helper, oracle callback (`onAprChanged`), owner-set wiring.
- **Risk premium pipeline**: `_calculateRiskPremium`, `_updateAprSrt`,
  Senior index compounding via `_calculateTargetIndex`.

What this spec does NOT do:

- **Loss waterfall** (`gain_signed < 0` OR `gain_after_reserve <
target_sum`) — only detected and routed to `_applyLossWaterfall()`
  which reverts `NotImplemented()`. Spec 08c fills the body.
- **`AprPairFeed` contract implementation** — only the consumer side
  (Accounting) is wired here. Spec 08b' implements the concrete feed
  contract.
- **`maxDeposit` / `maxWithdraw`** — spec 08d.
- **`accrueFee` / `reduceReserve` / `updateBalanceFlow` bodies** —
  CDO-driven hooks, future specs.

---

## Architecture Decisions Recap

| #   | Decision              | Value                                                                               |
| --- | --------------------- | ----------------------------------------------------------------------------------- |
| 1   | netGain mode          | Actual: `gain = int(navT1) - int(navT0)`                                            |
| 2   | Senior target         | Index pattern. `srtTargetIndex` compounds via `aprSrt`                              |
| 3   | `aprSrt` formula      | `max(aprTarget, aprBase × (1 - RP_nominal))`                                        |
| 4   | RP exponent `k`       | PRBMath `pow` (UD60x18 fixed-point), configurable                                   |
| 5   | `tvlRatioSr`          | `TVL_sr / pool` where `pool = TVL_jr + TVL_mz + TVL_sr`                             |
| 6   | Reserve cut           | First. `gain_after_reserve = gain × (1 - reserveRate)`                              |
| 7   | Case 1 condition      | `gain_after_reserve ≥ srTargetGain + BaseAPY × sub × Δt / YEAR`                     |
| 8   | Mz/Jr split           | Base = `BaseAPY × TVL × Δt / YEAR`; residual split by `share_jr/mz`                 |
| 9   | Residual = RP+excess  | Both unified in one split (no separate excess handling)                             |
| 10  | `share_jr / share_mz` | `α × TVL_jr / (α × TVL_jr + TVL_mz)` and `TVL_mz / denom`                           |
| 11  | YEAR                  | `SECONDS_PER_YEAR = 31_536_000`                                                     |
| 12  | Junior absorbs dust   | Floor division remainder routes to Junior                                           |
| 13  | APR Feed integration  | Full pipeline (pull helper, callback, owner setter). Feed contract is spec 08b'     |
| 14  | Init APR source       | `initialize(cdo, aprPairFeed)`. First fetch happens via `onAprChanged` after deploy |
| 15  | Case 2 routing        | Stub `_applyLossWaterfall` reverts `NotImplemented()`                               |

---

## Goals

- Expand `IAPRFeed` to the production-ready surface (Round struct,
  `latestRoundData`, `decimals`).
- Implement `Accounting.updateAccounting(navT1)` body for Case 1.
- Implement full APR infrastructure on Accounting:
  `_fetchAprs`, `_normalizeAprFromFeed`, `_updateAprSrt`,
  `onAprChanged`, `setAprPairFeed`.
- Implement `_calculateRiskPremium`, `_calculateTargetIndex`,
  `_updateIndex`, `calculateNAVSplit`, `totalAssets(navT1)`,
  `totalAssets(address)`.
- Implement `setRiskParameters`, `setLeverageAlpha`, `setReserveRate`.
- Initializer takes the feed address; no raw APR values.
- Stub `_applyLossWaterfall` with `revert NotImplemented()`.

---

## File Structure

```text
contracts/
├── core/
│   └── Accounting.sol          # amend (body implementation)
│
└── interfaces/
    ├── IAccounting.sol         # amend (remove setAPYs/setAprTarget,
    │                           # adjust types to UD60x18, add aprPairFeed getter)
    └── IAPRFeed.sol            # amend (expand to Round struct)
```

---

## Dependency

```text
pnpm add @prb/math
```

Imports used:

```solidity
import { UD60x18, pow, mul, ud } from "@prb/math/src/ud60x18/Math.sol";
```

---

## Requirements

### 1. `IAPRFeed.sol` — Expanded

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IAPRFeed {
    struct Round {
        uint80 roundId;
        int64 aprTarget;   // SD7x12 compact format
        int64 aprBase;     // SD7x12 compact format
        uint256 updatedAt;
    }

    function latestRoundData() external view returns (Round memory);

    function decimals() external view returns (uint8);
}
```

SD7x12 = signed 12-decimal compact format. Packs `roundId + aprTarget +
aprBase` into a single slot, plus `updatedAt`. Accounting normalises
to UD60x18 via `_normalizeAprFromFeed`.

---

### 2. `IAccounting.sol` — Amendments

Remove:

- `setAPYs(uint256, uint256)` declaration and `APYsSet` event.
- `setAprTarget(UD60x18)` declaration and any associated event.
- `baseAPY()` and `benchmarkAPR()` uint256 getters.

Replace:

- `seniorXSr` / `seniorYSr` / `seniorKSr` (uint256) → `riskX` / `riskY` /
  `riskK` (UD60x18).
- `setSeniorParams` → `setRiskParameters(UD60x18, UD60x18, UD60x18)`.
- `seniorFloor` removed (covered by `aprTarget`).

Add:

- `aprTarget()`, `aprBase()`, `aprSrt()` UD60x18 getters
  (auto-generated from `public` storage).
- `aprPairFeed()` external view returning `IAPRFeed`.
- `setAprPairFeed(IAPRFeed)` declaration.
- `onAprChanged()` declaration.
- Events: `AprDataChangedViaPush(UD60x18, UD60x18)`,
  `AprPairFeedChanged(address)`, `RiskParametersChanged(UD60x18, UD60x18, UD60x18)`,
  `ReserveRateSet(uint256)`, `LeverageAlphaSet(uint256)`.

Keep:

- `setRiskParameters`, `setLeverageAlpha`, `setReserveRate`.
- All view functions (`totalAssets(navT1)`, `totalAssets(address)`,
  `totalAssetsT0()`).
- All state-changing CDO hooks (`updateAccounting`, `updateBalanceFlow`,
  `accrueFee`, `reduceReserve`).
- `seniorIndex()`, `lastUpdateTime()`, `leverageAlpha()`,
  `reserveRate()`, `aprFeed()` (deprecated by new `aprPairFeed()` —
  remove the old).

Import the UD60x18 type:

```solidity
import { UD60x18 } from "@prb/math/src/ud60x18/Math.sol";
```

---

### 3. `Accounting.sol` — Constants

Declared at the top.

```solidity
uint256 public constant SECONDS_PER_YEAR = 31_536_000;

uint256 public constant RESERVE_BPS_MAX = 0.2e18;   // 20% cap

int64 private constant APR_FEED_BOUNDARY_MAX = 2e12;  // 200%
int64 private constant APR_FEED_BOUNDARY_MIN = 0;
uint256 private constant APR_FEED_DECIMALS = 12;
```

---

### 4. Storage Layout

Replaces 08a's APR-related fields. Other fields (`tvlJr`, `tvlMz`,
`tvlSr`, `tvlReserve`, `seniorIndex`, `lastUpdateTime`,
`leverageAlpha`, `reserveRate`) unchanged.

```solidity
// --- Last-recorded total NAV ---
uint256 public nav;

// --- APR Feed wiring ---
IAPRFeed public aprPairFeed;

// --- APR values (UD60x18) ---
UD60x18 public aprTarget;
UD60x18 public aprBase;
UD60x18 public aprSrt;

// --- Risk premium parameters (UD60x18) ---
UD60x18 public riskX;
UD60x18 public riskY;
UD60x18 public riskK;
```

Remove from 08a: `baseAPY`, `benchmarkAPR` (uint256 mirrors),
`seniorFloor`, `seniorXSr`, `seniorYSr`, `seniorKSr`, `_feed`.

Update the NatSpec storage-layout block at the top of the contract:

```text
[Accounting own — post-08b]
  tvlJr, tvlMz, tvlSr, tvlReserve              (4)
  nav                                          (1)
  aprPairFeed                                  (1)
  aprTarget, aprBase, aprSrt                   (3)
  riskX, riskY, riskK                          (3)
  leverageAlpha, reserveRate                   (2)
  seniorIndex, lastUpdateTime                  (2)
  -----
  Total: 16 standalone slots
  __gap[34]   (was __gap[40], reduced by 6 net additions)
```

Acceptable because no proxy is deployed.

---

### 5. Initializer

```solidity
function initialize(address cdo_, IAPRFeed aprPairFeed_)
    external initializer
{
    if (cdo_ == address(0)) revert InvalidCaller(address(0));
    cdo = ICDO(cdo_);
    aprPairFeed = aprPairFeed_;   // may be address(0) — pull simply no-ops

    seniorIndex = 1e18;
    lastUpdateTime = block.timestamp;

    riskX = ud(0.2e18);
    riskY = ud(0.2e18);
    riskK = ud(0.3e18);

    leverageAlpha = 1e18;
    // reserveRate, aprTarget, aprBase, aprSrt all default zero.
}
```

No fetch in init. Bootstrap pattern:

1. Deploy `Accounting`.
2. Owner calls `setAprPairFeed(...)` (or `aprPairFeed_` was supplied
   here).
3. Oracle triggers `onAprChanged()` → first `_fetchAprs()` →
   `aprTarget`, `aprBase` populated, `aprSrt` computed.

Until step 3, `aprSrt = 0` → Senior accrues no yield via the index.

---

### 6. APR Helpers

```solidity
function _fetchAprs() internal
    returns (bool modified, UD60x18 aprTargetT1, UD60x18 aprBaseT1)
{
    if (address(aprPairFeed) == address(0)) {
        return (false, aprTarget, aprBase);
    }
    IAPRFeed.Round memory round = aprPairFeed.latestRoundData();
    aprTargetT1 = _normalizeAprFromFeed(round.aprTarget);
    aprBaseT1   = _normalizeAprFromFeed(round.aprBase);

    if (UD60x18.unwrap(aprTargetT1) != UD60x18.unwrap(aprTarget) ||
        UD60x18.unwrap(aprBaseT1)   != UD60x18.unwrap(aprBase))
    {
        aprTarget = aprTargetT1;
        aprBase   = aprBaseT1;
        _updateAprSrt(aprTargetT1, aprBaseT1);
        return (true, aprTargetT1, aprBaseT1);
    }
    return (false, aprTargetT1, aprBaseT1);
}

function _normalizeAprFromFeed(int64 apr) internal pure returns (UD60x18) {
    if (apr < APR_FEED_BOUNDARY_MIN) apr = APR_FEED_BOUNDARY_MIN;
    if (apr > APR_FEED_BOUNDARY_MAX) apr = APR_FEED_BOUNDARY_MAX;
    // SD7x12 → UD60x18: multiply by 10^(18-12) = 10^6.
    return ud(uint256(int256(apr)) * (10 ** (18 - APR_FEED_DECIMALS)));
}

function _calculateRiskPremium() internal view returns (UD60x18) {
    uint256 pool = tvlJr + tvlMz + tvlSr;
    if (pool == 0 || tvlSr == 0) return ud(0);
    UD60x18 tvlRatio = ud(tvlSr * 1e18 / pool);
    return _calculateRiskPremiumInner(riskX, riskY, riskK, tvlRatio);
}

function _calculateRiskPremiumInner(
    UD60x18 x, UD60x18 y, UD60x18 k, UD60x18 tvlRatio
) internal pure returns (UD60x18) {
    return x + mul(y, pow(tvlRatio, k));
}

function _updateAprSrt(UD60x18 aprTarget_, UD60x18 aprBase_) internal {
    UD60x18 risk = _calculateRiskPremium();
    UD60x18 one = ud(1e18);
    UD60x18 net = (UD60x18.unwrap(risk) < UD60x18.unwrap(one))
        ? mul(aprBase_, one - risk)
        : ud(0);
    aprSrt = (UD60x18.unwrap(aprTarget_) > UD60x18.unwrap(net))
        ? aprTarget_
        : net;
}
```

Notes:

- `_fetchAprs` returns early when feed unset (zero-address).
- Equality check on UD60x18 via `unwrap`.
- `_updateAprSrt` takes args explicit; callers pass either current
  storage or freshly-fetched values.

---

### 7. Senior Index Helpers

```solidity
function _updateIndex() internal {
    srtTargetIndex = _calculateTargetIndexAt(block.timestamp);
    lastUpdateTime = block.timestamp;
}

function _calculateTargetIndexAt(uint256 t1) internal view returns (uint256) {
    return _calculateTargetIndex(srtTargetIndex, lastUpdateTime, t1, aprSrt);
}

function _calculateTargetIndex(
    uint256 indexT0,
    uint256 t0,
    uint256 t1,
    UD60x18 apr
) internal pure returns (uint256) {
    if (t1 <= t0) return indexT0;
    uint256 dt = t1 - t0;
    uint256 interestFactor = (UD60x18.unwrap(apr) * dt) / SECONDS_PER_YEAR;
    return (indexT0 * (1e18 + interestFactor)) / 1e18;
}
```

Note: `srtTargetIndex` field already exists from 08a as `seniorIndex` —
rename to `srtTargetIndex` for consistency with the rest of the
codebase pattern (legacy `seniorIndex` was a placeholder name in 08a).

---

### 8. `calculateNAVSplit` — Case 1 Body

```solidity
function calculateNAVSplit(
    uint256 navT0,
    uint256 jrtNavT0,
    uint256 mzNavT0,
    uint256 srtNavT0,
    uint256 reserveNavT0,
    uint256 navT1
) public view returns (
    uint256 jrtNavT1, uint256 mzNavT1, uint256 srtNavT1, uint256 reserveNavT1
) {
    // Bootstrap: no deposits, strategy reports gain → all to reserve.
    if (jrtNavT0 == 0 && mzNavT0 == 0 && srtNavT0 == 0 && navT1 > 0) {
        return (0, 0, 0, navT1);
    }

    int256 gainSigned = int256(navT1) - int256(navT0);

    // Case 2 (a) — strategy loss.
    if (gainSigned < 0) {
        return _applyLossWaterfall(
            navT0, jrtNavT0, mzNavT0, srtNavT0, reserveNavT0, navT1
        );
    }

    uint256 gain = uint256(gainSigned);

    // Reserve cut FIRST.
    uint256 reserveCut = 0;
    if (gain > 0 && reserveRate > 0) {
        reserveCut = gain * reserveRate / 1e18;
        gain -= reserveCut;
    }
    reserveNavT1 = reserveNavT0 + reserveCut;

    // Senior target via index.
    uint256 srtTargetIndexT1 = _calculateTargetIndexAt(block.timestamp);
    uint256 srTargetGain = srtNavT0 == 0
        ? 0
        : (srtNavT0 * srtTargetIndexT1) / srtTargetIndex - srtNavT0;

    // Mz/Jr base entitlements (BaseAPY × TVL × dt / YEAR).
    uint256 dt = block.timestamp - lastUpdateTime;
    uint256 base = UD60x18.unwrap(aprBase);
    uint256 mzBase = (mzNavT0 * base * dt) / (1e18 * SECONDS_PER_YEAR);
    uint256 jrBase = (jrtNavT0 * base * dt) / (1e18 * SECONDS_PER_YEAR);

    uint256 targetSum = srTargetGain + mzBase + jrBase;

    // Case 2 (b) — insufficient yield.
    if (gain < targetSum) {
        return _applyLossWaterfall(
            navT0, jrtNavT0, mzNavT0, srtNavT0, reserveNavT0, navT1
        );
    }

    // ============================================================
    // Case 1 — sufficient yield
    // ============================================================

    srtNavT1 = srtNavT0 + srTargetGain;
    mzNavT1 = mzNavT0 + mzBase;
    jrtNavT1 = jrtNavT0 + jrBase;

    uint256 residual = gain - targetSum;
    // residual = RP_delivered + excess. Both split by share_jr/mz.

    if (residual > 0) {
        uint256 denom = (leverageAlpha * jrtNavT0) / 1e18 + mzNavT0;
        if (denom == 0) {
            // No Mz, no Jr → residual → reserve.
            reserveNavT1 += residual;
        } else {
            uint256 jrShare = (leverageAlpha * jrtNavT0 * residual)
                            / (denom * 1e18);
            uint256 mzShare = (mzNavT0 * residual) / denom;
            // Dust → Junior.
            jrShare += residual - jrShare - mzShare;
            jrtNavT1 += jrShare;
            mzNavT1 += mzShare;
        }
    }

    // Invariant.
    if (navT1 != jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1) {
        revert InvalidNavSplit(
            navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1
        );
    }

    return (jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
}
```

---

### 9. `_applyLossWaterfall` — Stub

```solidity
function _applyLossWaterfall(
    uint256, uint256, uint256, uint256, uint256, uint256
) internal pure returns (uint256, uint256, uint256, uint256) {
    revert NotImplemented();
}
```

---

### 10. `updateAccounting` Body

```solidity
function updateAccounting(uint256 navT1) external onlyCDO {
    _updateAccountingInner(navT1);
}

function _updateAccountingInner(uint256 navT1) internal {
    (uint256 jrtT1, uint256 mzT1, uint256 srT1, uint256 resT1) =
        calculateNAVSplit(nav, tvlJr, tvlMz, tvlSr, tvlReserve, navT1);

    _updateIndex();  // advance after split (split used old index)

    nav = navT1;
    tvlJr = jrtT1;
    tvlMz = mzT1;
    tvlSr = srT1;
    tvlReserve = resT1;

    emit AccountingUpdated(navT1, jrtT1, mzT1, srT1, resT1);
}

function _currentStrategyAssets() internal view returns (uint256) {
    return cdo.strategy().totalAssets();
}
```

NOTE: `updateAccounting` does NOT call `_fetchAprs()`. APR refresh is
handled separately via `onAprChanged` / `setRiskParameters` / future
`updateBalanceFlow` / `reduceReserve`. This keeps the hot path cheap;
the index already compounds correctly between updates.

---

### 11. Public View Wrappers

```solidity
function totalAssets(uint256 navT1) external view returns (
    uint256 jr, uint256 mz, uint256 sr, uint256 reserveAssets
) {
    return calculateNAVSplit(nav, tvlJr, tvlMz, tvlSr, tvlReserve, navT1);
}

function totalAssets(address tranche) external view returns (uint256) {
    uint256 navT1 = _currentStrategyAssets();
    (uint256 jr, uint256 mz, uint256 sr, ) =
        calculateNAVSplit(nav, tvlJr, tvlMz, tvlSr, tvlReserve, navT1);
    TrancheKind kind = _kindOf(tranche);
    if (kind == TrancheKind.JUNIOR)    return jr;
    if (kind == TrancheKind.MEZZANINE) return mz;
    return sr;
}

function totalAssetsT0() external view returns (
    uint256, uint256, uint256, uint256
) {
    return (tvlJr, tvlMz, tvlSr, tvlReserve);
}
```

`maxDeposit` and `maxWithdraw` stay as `NotImplemented()` stubs from
08a (spec 08d).

---

### 12. External Functions

```solidity
function onAprChanged() external onlyRole(UPDATER_FEED_ROLE) {
    _updateAccountingInner(_currentStrategyAssets());
    (bool modified, UD60x18 t, UD60x18 b) = _fetchAprs();
    if (modified) emit AprDataChangedViaPush(t, b);
}

function setAprPairFeed(IAPRFeed aprPairFeed_) external onlyOwner {
    if (aprPairFeed_.decimals() != APR_FEED_DECIMALS) {
        revert InvalidFeedDecimals(aprPairFeed_.decimals(), APR_FEED_DECIMALS);
    }
    aprPairFeed = aprPairFeed_;
    emit AprPairFeedChanged(address(aprPairFeed_));
}

function setRiskParameters(UD60x18 riskX_, UD60x18 riskY_, UD60x18 riskK_)
    external onlyRole(UPDATER_STRAT_CONFIG_ROLE)
{
    _updateAccountingInner(_currentStrategyAssets());
    riskX = riskX_;
    riskY = riskY_;
    riskK = riskK_;
    // Sanity: at tvlRatio = 1.0, risk premium must stay below 100%.
    UD60x18 maxRisk = _calculateRiskPremiumInner(riskX_, riskY_, riskK_, ud(1e18));
    if (UD60x18.unwrap(maxRisk) >= 1e18) revert RiskPremiumTooHigh();
    _updateAprSrt(aprTarget, aprBase);
    emit RiskParametersChanged(riskX_, riskY_, riskK_);
}

function setReserveRate(uint256 rate) external onlyOwner {
    if (rate > RESERVE_BPS_MAX || rate == reserveRate) {
        revert InvalidReserveRate(rate);
    }
    _updateAccountingInner(_currentStrategyAssets());
    reserveRate = rate;
    emit ReserveRateSet(rate);
}

function setLeverageAlpha(uint256 alpha) external onlyOwner {
    _updateAccountingInner(_currentStrategyAssets());
    leverageAlpha = alpha;
    emit LeverageAlphaSet(alpha);
}
```

---

### 13. New Errors

```solidity
error InvalidFeedDecimals(uint8 actual, uint256 expected);
error InvalidReserveRate(uint256 rate);
error RiskPremiumTooHigh();
error InvalidNavSplit(uint256 navT1, uint256 jr, uint256 mz, uint256 sr, uint256 reserve);
```

Existing: `NotImplemented`, `InvalidCaller`, `InvalidTranche`.

---

## Notes

### Why APR refresh is decoupled from `updateAccounting`

`updateAccounting` runs on every deposit/withdraw via Tranche →
CDO → Accounting. Fetching APRs every call would add an external
SLOAD-heavy call to the hot path. The Senior index already
compounds correctly using the cached `aprSrt` between updates;
fresh APRs only matter when the feed publishes new values, which is
explicitly signalled via `onAprChanged`. `setRiskParameters` and
future `updateBalanceFlow` also trigger a refresh because changing
risk params or TVL ratios alters `aprSrt`.

### Why residual unifies RP_delivered + excess

In actual mode, `gain - srTargetGain - mzBase - jrBase` equals
`RP_delivered + excess` algebraically — there's no need to compute
them separately. Both flow through the same `share_jr/mz` split.

### Junior absorbs dust

Two floor divisions on shares leave 0–1 wei. Sending dust to the
volatile leverage holder keeps Senior strict (matches index) and
Mezz strict (matches its share). Cumulative dust over many updates
is negligible.

### Linear vs continuous compounding

`(1 + r × dt)` is used. Atrium expects frequent updates; the error
vs `e^(r × dt)` is negligible at short intervals and always
under-pays Senior. Auditors can swap in `exp` later.

### Storage rename `seniorIndex` → `srtTargetIndex`

08a used `seniorIndex`; 08b renames to `srtTargetIndex` for
naming consistency with the rest of the pipeline (`aprSrt`,
`srtNavT0`, etc.). Pure rename, same slot, no behavioural change.

---

## Non-Goals

- `_applyLossWaterfall` body (08c).
- Negative-gain handling (08c).
- `AprPairFeed` contract implementation (08b').
- `maxDeposit` / `maxWithdraw` bodies (08d).
- `accrueFee`, `reduceReserve`, `updateBalanceFlow` bodies.
- Continuous compounding upgrade.
- Tests covering the math (paired with 08c).
- Deployment script.

---

## Acceptance Criteria

- `@prb/math` installed.
- `IAPRFeed.sol` matches §1.
- `IAccounting.sol` updated per §2; no `setAPYs`, `setAprTarget`,
  `baseAPY()`, `benchmarkAPR()`.
- `Accounting.sol` storage matches §4.
- `initialize(cdo, feed)` runs without external calls; `aprSrt = 0`
  until first `onAprChanged`.
- `setAprPairFeed` validates `decimals()` and reverts
  `InvalidFeedDecimals` on mismatch.
- `onAprChanged` is `onlyRole(UPDATER_FEED_ROLE)`, refreshes
  accounting and APRs, emits on actual change only.
- `setRiskParameters` is `onlyRole(UPDATER_STRAT_CONFIG_ROLE)`,
  reverts `RiskPremiumTooHigh` if `riskPremium(tvlRatio=1.0) ≥ 100%`.
- `setReserveRate` is `onlyOwner`, reverts `InvalidReserveRate` for
  `rate > 20%` or `rate == reserveRate`.
- `updateAccounting(navT1)` in Case 1 produces splits where
  `navT1 == jr + mz + sr + reserve`.
- `updateAccounting(navT1)` reverts `NotImplemented()` (from
  `_applyLossWaterfall`) when `navT1 < navT0` OR
  `gain_after_reserve < srTargetGain + mzBase + jrBase`.
- Bootstrap: with all tranche NAVs = 0 and `navT1 > 0`, full gain
  routes to `tvlReserve`.
- `pnpm build` clean under solc 0.8.35. No string reverts.

---

## Check When Done

- Build passes.
- `forge inspect Accounting storage` matches §4.
- `progress-tracker.md` updated:
  - 08b moved to Completed.
  - Architecture decisions: index pattern, residual = RP+excess
    unified, reserve-first cut, APR refresh decoupled, linear
    compounding.
  - Open Questions:
    - Setter roles partially wired (`UPDATER_FEED_ROLE`,
      `UPDATER_STRAT_CONFIG_ROLE`, `onlyOwner`); confirm policy.
    - `leverageAlpha = 1e18`, `risk = (0.2, 0.2, 0.3)` defaults —
      Atrium-specific tuning.
    - Linear vs continuous compounding — acceptable error?
    - `_applyLossWaterfall` stub — 08c.
    - `AprPairFeed` contract — 08b'.
- 08c (loss waterfall) and 08d (max limits) unblocked.
- 08b' (AprPairFeed contract) is the natural next step.
