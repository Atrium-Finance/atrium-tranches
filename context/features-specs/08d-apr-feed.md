# 08d - AprPairFeed (APR Oracle)

## Overview

Concrete oracle feeding Senior's base APR to Accounting. Supports
two data sources: PUSH (an authorized observer writes APR rounds)
and PULL (the Strategy computes its own spot APR). Feed prefers
fresh PUSH data; when stale, it falls back to PULL.

Atrium-specific: the feed reports only `aprBase` (market yield from
USD.AI). The Senior `aprTarget` (Atrium's guaranteed-floor policy)
is NOT in the feed — Accounting holds it as an owner-set value.

Ships:

- `AprPairFeed.sol` — concrete oracle, PUSH + PULL.
- `IAprPairFeed.sol` — interface with `TRound` struct,
  `latestRoundData`, `updateRoundData` overloads.
- `IStrategyAprProvider.sol` — interface UsdaiStrategy implements
  for the PULL path.
- UsdaiStrategy amendment — implement `getApr()` from sUSDai
  exchange-rate history.

Out of scope:

- `aprTarget` management — lives in Accounting (spec 08b setter).
- The risk-premium math that turns base into Sr APR — Accounting
  (spec 08b).
- Multi-asset feed aggregation.

---

## Architecture Decisions Recap

| #   | Decision      | Value                                                                                        |
| --- | ------------- | -------------------------------------------------------------------------------------------- |
| Q1  | Source modes  | PUSH (observer writes) + PULL (Strategy computes). Prefer PUSH, fall back to PULL when stale |
| Q2  | Feed scope    | Feed reports **only `aprBase`**. `aprTarget` is Accounting-owned (Atrium policy, owner-set)  |
| Q3  | Staleness     | Stale PUSH → automatic PULL fallback in `latestRoundData`                                    |
| Q4  | APR encoding  | `int64`, 12 decimals (e.g. `0.12e12` = 12%). Matches common feed conventions                 |
| Q5  | Bounds        | APR clamped to `[-50%, +200%]` — sanity guard against feed errors                            |
| Q6  | Round storage | Ring buffer of last 20 rounds for historical queries                                         |
| Q7  | PULL source   | UsdaiStrategy computes spot APR from sUSDai `convertToAssets` delta over time                |

---

## Goals

- A feed Accounting can read via `latestRoundData()`.
- PUSH path for an off-chain observer that watches USD.AI's
  published yield.
- PULL fallback so a stale feed doesn't freeze APR updates.
- Single-value scope (`aprBase`) keeping target policy out of
  market data.

---

## File Structure

```text
contracts/
├── oracles/
│   └── AprPairFeed.sol             # NEW
│
├── strategies/usdai/
│   └── UsdaiStrategy.sol           # amend — implement IStrategyAprProvider
│
└── interfaces/
    ├── oracles/
    │   ├── IAprPairFeed.sol        # NEW
    │   └── IStrategyAprProvider.sol # NEW
    └── ...
```

---

## Requirements

### 1. `IAprPairFeed.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IAprPairFeed {
    /// @notice One APR observation. `aprBase` only — target is
    ///         Accounting-owned. `aprTarget` retained in the struct
    ///         as a reserved field (always 0 from this feed) to keep
    ///         the round shape stable for future use.
    struct TRound {
        int64  aprBase;
        int64  aprTargetReserved;   // always 0 — reserved
        uint64 updatedAt;
        uint64 answeredInRound;
    }

    function latestRoundData() external view returns (TRound memory);
    function getRoundData(uint64 roundId) external view returns (TRound memory);

    function updateRoundData(int64 aprBase, uint64 timestamp) external;
    function updateRoundData() external;     // PULL variant

    function decimals() external view returns (uint8);
}
```

### 2. `IStrategyAprProvider.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IStrategyAprProvider {
    /// @notice Strategy's spot base APR, 12-decimal int64.
    /// @return aprBase Annualized yield estimate.
    /// @return updatedAt Timestamp of the observation.
    function getApr() external view returns (int64 aprBase, uint64 updatedAt);
}
```

Single-value provider — no target. UsdaiStrategy implements this.

---

### 3. `AprPairFeed.sol`

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { AccessControlled } from "../governance/AccessControlled.sol";
import { IAprPairFeed } from "../interfaces/oracles/IAprPairFeed.sol";
import { IStrategyAprProvider } from "../interfaces/oracles/IStrategyAprProvider.sol";

/// @title  AprPairFeed
/// @notice Base-APR oracle for Atrium Senior pricing. PUSH + PULL.
contract AprPairFeed is IAprPairFeed, AccessControlled {
    int64 private constant APR_MAX =  2e12;     // +200%
    int64 private constant APR_MIN = -0.5e12;   // -50%
    uint64 private constant MAX_FUTURE_DRIFT = 60;   // clock skew tolerance

    uint8 public constant override decimals = 12;
    uint8 public constant roundsCap = 20;

    string public description;
    uint64 public latestRoundId;
    TRound public latestRound;
    mapping(uint64 => TRound) public rounds;

    uint256 public roundStaleAfter;
    IStrategyAprProvider public provider;

    enum ESourcePref { Feed, Strategy }
    ESourcePref public sourcePref;

    event AnswerUpdated(int64 aprBase, uint64 roundId, uint64 updatedAt);
    event ProviderSet(address provider);
    event StalePeriodSet(uint256 period);
    event SourcePrefChanged(ESourcePref pref);

    error StaleUpdate(int64 aprBase, uint64 timestamp);
    error OutOfOrderUpdate(int64 aprBase, uint64 timestamp);
    error InvalidApr(int64 apr);
    error NoDataPresent();
    error OldRound();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address acm_,
        IStrategyAprProvider provider_,
        uint256 roundStaleAfter_,
        string memory description_
    ) external initializer {
        AccessControlled_init(owner_, acm_);
        provider = provider_;
        roundStaleAfter = roundStaleAfter_;
        description = description_;
    }

    // -------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------

    function latestRoundData() external view override returns (TRound memory) {
        TRound memory round = latestRound;

        if (sourcePref == ESourcePref.Feed && round.updatedAt != 0) {
            // Guard against future-dated rounds (clock skew) to avoid
            // underflow. A future round is by definition fresh.
            uint256 dt = block.timestamp > round.updatedAt
                ? block.timestamp - uint256(round.updatedAt)
                : 0;
            if (dt < roundStaleAfter) {
                return round;
            }
            // fall through to PULL
        }

        (int64 aprBase, uint64 t1) = provider.getApr();
        _ensureValid(aprBase);
        return TRound({
            aprBase: aprBase,
            aprTargetReserved: 0,
            updatedAt: t1,
            answeredInRound: latestRoundId + 1
        });
    }

    function getRoundData(uint64 roundId) external view override returns (TRound memory) {
        uint64 idx = roundId % roundsCap;
        TRound memory round = rounds[idx];
        if (round.updatedAt == 0) revert NoDataPresent();
        if (round.answeredInRound != roundId) revert OldRound();
        return round;
    }

    // -------------------------------------------------------------
    // PUSH
    // -------------------------------------------------------------

    function updateRoundData(int64 aprBase, uint64 timestamp)
        external override onlyRole(UPDATER_FEED_ROLE)
    {
        _updateRoundDataInner(aprBase, timestamp);
        _setSourcePref(ESourcePref.Feed);
    }

    // -------------------------------------------------------------
    // PULL
    // -------------------------------------------------------------

    function updateRoundData() external override onlyRole(UPDATER_FEED_ROLE) {
        (int64 aprBase, uint64 t) = provider.getApr();
        _updateRoundDataInner(aprBase, t);
        _setSourcePref(ESourcePref.Strategy);
    }

    // -------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------

    function _updateRoundDataInner(int64 aprBase, uint64 t) internal {
        if (block.timestamp > roundStaleAfter && uint256(t) < block.timestamp - roundStaleAfter) {
            revert StaleUpdate(aprBase, t);
        }
        if (t <= latestRound.updatedAt || uint256(t) > block.timestamp + MAX_FUTURE_DRIFT) {
            revert OutOfOrderUpdate(aprBase, t);
        }
        _ensureValid(aprBase);

        uint64 roundId = latestRoundId + 1;
        uint64 idx = roundId % roundsCap;

        latestRoundId = roundId;
        latestRound = TRound({
            aprBase: aprBase,
            aprTargetReserved: 0,
            updatedAt: t,
            answeredInRound: roundId
        });
        rounds[idx] = latestRound;

        emit AnswerUpdated(aprBase, roundId, t);
    }

    function _setSourcePref(ESourcePref pref) internal {
        if (sourcePref != pref) {
            sourcePref = pref;
            emit SourcePrefChanged(pref);
        }
    }

    function _ensureValid(int64 apr) internal pure {
        if (apr < APR_MIN || apr > APR_MAX) revert InvalidApr(apr);
    }

    // -------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------

    function setProvider(IStrategyAprProvider provider_) external onlyOwner {
        (int64 aprBase, ) = provider_.getApr();
        _ensureValid(aprBase);
        provider = provider_;
        emit ProviderSet(address(provider_));
    }

    function setRoundStaleAfter(uint256 period) external onlyOwner {
        roundStaleAfter = period;
        emit StalePeriodSet(period);
    }
}
```

---

### 4. UsdaiStrategy — implement `IStrategyAprProvider`

Add the PULL source. UsdaiStrategy computes spot APR from sUSDai's
exchange-rate change over a sampling window.

```solidity
// Storage additions to UsdaiStrategy
uint256 public lastRateSample;       // sUSDai.convertToAssets(1e18) at last sample
uint64  public lastRateSampleAt;     // timestamp of last sample

function getApr() external view override returns (int64 aprBase, uint64 updatedAt) {
    uint256 currentRate = sUSDai.convertToAssets(1e18);
    uint64 nowTs = uint64(block.timestamp);

    if (lastRateSampleAt == 0 || nowTs <= lastRateSampleAt) {
        return (0, nowTs);     // insufficient data
    }

    uint256 dt = nowTs - lastRateSampleAt;
    // rateGrowth = (currentRate - lastRate) / lastRate, annualized.
    if (currentRate <= lastRateSample) {
        return (0, nowTs);     // flat or negative — report 0 (floor handled by target)
    }
    uint256 growth = (currentRate - lastRateSample) * 1e18 / lastRateSample;
    uint256 annualized = growth * SECONDS_PER_YEAR / dt;   // 18-decimal fraction

    // Clamp at 200% (2e18) before the int64 cast. A tiny dt would
    // otherwise explode the linear annualization and overflow the
    // cast, potentially bypassing the feed's _ensureValid ceiling.
    if (annualized > 2e18) annualized = 2e18;

    // Convert 18-decimal fraction → 12-decimal int64.
    int64 apr = int64(int256(annualized / 1e6));
    return (apr, nowTs);
}

/// @notice Sample the current sUSDai rate. Called periodically by a
///         keeper to give getApr a baseline. UPDATER_STRAT_CONFIG_ROLE.
function sampleRate() external onlyRole(UPDATER_STRAT_CONFIG_ROLE) {
    lastRateSample = sUSDai.convertToAssets(1e18);
    lastRateSampleAt = uint64(block.timestamp);
}
```

The PULL path is a best-effort spot estimate. The PUSH path (an
off-chain observer reading USD.AI's official published APR) is the
preferred, more-accurate source. PULL exists only so a stale feed
doesn't block `updateAccounting`.

---

### 5. Wiring (deployment, spec 15)

- Deploy `AprPairFeed` with `provider = UsdaiStrategy`,
  `roundStaleAfter = e.g. 1 days`.
- `Accounting.setAprPairFeed(feed)`.
- Grant `UPDATER_FEED_ROLE` to the off-chain observer address.
- Keeper periodically calls `feed.updateRoundData(aprBase, now)`
  (PUSH) and `strategy.sampleRate()` (to keep PULL warm).

---

## Notes

### Why target is excluded from the feed (Q2)

`aprTarget` is Atrium's guaranteed Senior floor — a business policy
decision (e.g. "Senior always earns at least 4%"). It's not market
data and shouldn't change because USD.AI's yield moved. Keeping it
in Accounting (owner-set) cleanly separates "what the market pays"
(feed) from "what we promise Senior" (policy).

The `TRound` struct keeps an `aprTargetReserved` field (always 0)
so the round shape stays stable if a future version wants to feed
target too.

### PUSH vs PULL preference (Q1/Q3)

- **PUSH** is authoritative: an off-chain observer reads USD.AI's
  published APR (their docs/API/subgraph) and writes it on-chain.
  Most accurate, but depends on the observer being live.
- **PULL** is the safety net: if the observer goes dark and the
  feed staleness window passes, `latestRoundData` computes a spot
  APR from sUSDai's on-chain exchange rate. Less accurate (spot vs
  published) but always available.

`sourcePref` tracks which mode last wrote, but `latestRoundData`
always falls back to PULL on staleness regardless of `sourcePref`.

### APR encoding (Q4)

`int64` with 12 decimals. `0.12e12 = 120000000000` = 12%. Signed
because APR can theoretically go negative (sUSDai loses value).
Accounting normalizes 12-dec int64 → 18-dec UD60x18 in
`normalizeAprFromFeed` (spec 08b §7), flooring negatives at 0.

### Bounds (Q5)

`[-50%, +200%]`. A feed reporting outside this range is almost
certainly an error (typo, decimals mistake, oracle manipulation).
Clamping via revert forces a correction rather than feeding
Accounting a wild value that would mis-price Senior.

### PULL spot-APR accuracy

`getApr` measures sUSDai rate growth between two samples and
annualizes linearly. This over- or under-estimates during volatile
periods (a single fast day annualizes to a huge number). The
`sampleRate` keeper call sets the baseline; the further apart
samples are, the smoother the estimate. Since PULL is fallback-only,
the imprecision is acceptable — the floor (`aprTarget`) and the
risk-premium discount (spec 08b) both moderate the final Sr APR.

### Why `sampleRate` is role-gated

A malicious frequent re-sampling could manipulate the spot APR
(sample right before/after a rate jump). Gating to
`UPDATER_STRAT_CONFIG_ROLE` (keeper multisig) prevents arbitrary
callers from gaming the PULL estimate.

### Ring buffer of 20 rounds

`rounds[roundId % 20]` keeps the last 20 observations for historical
queries (`getRoundData`). Old rounds overwrite — no unbounded
storage growth. 20 rounds at daily cadence ≈ 3 weeks of history,
enough for monitoring without bloating state.

---

## Non-Goals

- Feeding `aprTarget` (Accounting policy).
- Multi-asset / multi-strategy APR aggregation.
- TWAP or moving-average smoothing of PULL spot APR.
- Chainlink AggregatorV3 interface compatibility (can add later if
  needed for external integrations).
- Automatic `sampleRate` on every deposit (keeper-driven only).

---

## Acceptance Criteria

- `AprPairFeed.sol` implements `IAprPairFeed`.
- PUSH: `updateRoundData(aprBase, t)` writes a round, sets pref to
  Feed, emits `AnswerUpdated`.
- PULL: `updateRoundData()` reads `provider.getApr()`, writes a
  round, sets pref to Strategy.
- `latestRoundData()` returns fresh PUSH data when not stale; falls
  back to `provider.getApr()` when stale.
- APR outside `[-50%, +200%]` reverts `InvalidApr`.
- Out-of-order or future timestamps revert.
- Ring buffer stores last 20 rounds; `getRoundData` retrieves by id.
- UsdaiStrategy implements `getApr()` and `sampleRate()`.
- `getApr()` returns 0 (not revert) when insufficient sample data or
  flat/negative growth.
- `getApr()` clamps annualized APR at 2e18 (200%) before the int64
  cast — a tiny `dt` cannot overflow the cast.
- `latestRoundData()` guards against future-dated rounds (clock
  skew) without underflowing.
- `_updateRoundDataInner` skips the staleness check when
  `block.timestamp <= roundStaleAfter` (test-chain safety).
- `rounds` mapping keyed `uint64`, consistent with index domain.
- Compiles under solc 0.8.35.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 08b' to Completed. Files: `AprPairFeed.sol`,
    `IAprPairFeed.sol`, `IStrategyAprProvider.sol`, UsdaiStrategy
    amendment.
  - Architecture decisions:
    - Feed reports base only; target is Accounting policy.
    - PUSH preferred, PULL fallback on staleness.
    - 12-dec int64 encoding, ±bounds.
    - UsdaiStrategy PULL via sUSDai rate sampling.
  - Open questions:
    - Whether to add TWAP smoothing to the PULL estimate.
    - Whether `aprTarget` should ever be fed (currently policy-only).
    - Keeper cadence for `sampleRate` + PUSH updates.
- Track B nearly complete: only 08d (edge cases + max limits)
  remains.
- Runtime: with 08b + 08c + 08b' wired, Accounting prices Senior
  from live market APR with a policy floor. Full deposit/withdraw +
  yield/loss cycle operational.
