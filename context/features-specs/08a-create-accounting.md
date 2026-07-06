# 08a - Accounting Skeleton & Full IAccounting Interface

## Overview

Establish the foundation for protocol accounting: the full
`IAccounting` interface that downstream specs (08b/c/d) will
implement piece-by-piece, plus an `Accounting.sol` skeleton that
inherits `CDOComponent` and stubs every interface method with
`NotImplemented()`.

This spec introduces:

- An expanded `IAccounting` interface covering yield allocation,
  TVL calculation, the loss waterfall, APR-feed integration, and
  reserve management.
- A `TrancheKind` enum lifted out of `PrimeCDO` (spec 07b) into
  `IAccounting.sol` so both `PrimeCDO` and `Accounting` share the
  same vocabulary.
- An `IAPRFeed` interface stub for the APR Pair Feed contract,
  pulled in `updateAccounting(...)`.
- A concrete `Accounting.sol` contract with full storage layout,
  initializer, role-gated configuration setters with empty stubs,
  and `NotImplemented()` bodies for every state-changing or
  computation-bearing method.
- A breaking amendment to `PrimeCDO`: `updateAccounting()` now
  forwards `strategy.totalAssets()` to
  `accounting.updateAccounting(totalStrategyAssets)`.

This task does **not** implement any of the actual math. Every body
either returns a zero default (for storage getters) or reverts
`NotImplemented()`. Specs 08b, 08c, 08d fill the bodies in.

---

## Architecture Decisions Recap

| #   | Decision                     | Value                                                                                                                                                                                       |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope                        | Skeleton + full interface signatures. All non-trivial bodies revert `NotImplemented()`                                                                                                      |
| 2   | Impl pattern                 | `Accounting.sol` inherits `CDOComponent` (existing back-ref pattern)                                                                                                                        |
| 3   | Dispatch param               | `address tranche`. Accounting resolves to kind via `cdo.jrVault() / mezzVault() / srVault()` lookups — no duplicated `_kindOf` logic                                                        |
| 4   | `TrancheKind` location       | `IAccounting.sol`. `PrimeCDO` imports it; amends spec 07b which had it locally declared                                                                                                     |
| 5   | `updateAccounting` signature | Breaking change: now `updateAccounting(uint256 totalStrategyAssets)`. `PrimeCDO`'s own `updateAccounting()` (still `NotImplemented` stub) is amended to forward `strategy.totalAssets()`    |
| 6   | APR Feed model               | Pull-primary + admin push override. `Accounting.feed` (`IAPRFeed`) is pulled inside `updateAccounting(...)` whenever set; `setAPYs(base, bench)` lets admin overwrite for the current cycle |
| 7   | Reserve                      | Both auto-allocate from `netGain` and `accrueFee` paths. `reserveRate` configurable via `setReserveRate(...)` gated `RESERVE_MANAGER_ROLE`. Default 0 (no auto-allocation)                  |
| 8   | `IAPRFeed`                   | Separate file, interface only; no impl                                                                                                                                                      |
| 9   | File path                    | `contracts/core/Accounting.sol`; matches `PrimeCDO` location                                                                                                                                |

---

## Goals

- Create `IAccounting.sol` with the full interface required by the
  math model in `project-overview.md`.
- Create `IAPRFeed.sol` minimal interface.
- Create `contracts/core/Accounting.sol` skeleton implementing
  `IAccounting`, inheriting `CDOComponent`, with proper `__gap`,
  `initializer`, and stub bodies.
- Amend `PrimeCDO.updateAccounting()` (stub) to forward
  `strategy.totalAssets()` to `accounting.updateAccounting(...)`.
- Amend `PrimeCDO` (spec 07b) to import `TrancheKind` from
  `IAccounting.sol` instead of declaring it locally.
- Update progress tracker.

---

## File Structure

```text
contracts/
├── core/
│   ├── PrimeCDO.sol            # amend
│   └── Accounting.sol          # NEW
│
└── interfaces/
    ├── IAccounting.sol         # amend (full expansion)
    └── IAPRFeed.sol            # NEW
```

No changes to `ICDO`, `ICDOComponent`, `ITranche`, `IStrategy`,
`AccessControlled.sol`, `CDOComponent.sol`, `Tranche.sol`.

---

## Requirements

### 1. Expand `IAccounting.sol`

#### File

```text
contracts/interfaces/IAccounting.sol
```

#### Full source

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/// @notice Identifies which of the three tranches a function refers to.
/// @dev    Declared here (not in PrimeCDO) so every contract that
///         touches per-tranche accounting shares the same vocabulary.
enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }

/// @title IAccounting
/// @notice Pure-calculation contract that owns the protocol's accounting
///         state: tranche TVLs, reserve, APY parameters, Senior target
///         index. Driven by the CDO; holds no funds.
/// @dev    Functions are grouped: state-changing (driven by CDO or admin),
///         views (consumed by CDO and Tranche), and configuration setters
///         (admin-gated).
interface IAccounting {
    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// @notice Emitted on every successful `updateAccounting` call.
    event AccountingUpdated(
        uint256 totalStrategyAssets,
        uint256 jrTvl,
        uint256 mzTvl,
        uint256 srTvl,
        uint256 reserveTvl
    );

    /// @notice Emitted when admin pushes APY values manually (override).
    event APYsSet(uint256 baseAPY, uint256 benchmarkAPR);

    /// @notice Emitted when admin updates the APR feed address.
    event APRFeedSet(address feed);

    /// @notice Emitted when admin updates Senior-target parameters.
    event SeniorParamsSet(uint256 floor, uint256 xSr, uint256 ySr, uint256 kSr);

    /// @notice Emitted when admin updates the Junior leverage factor.
    event LeverageAlphaSet(uint256 alpha);

    /// @notice Emitted when admin updates the reserve rate.
    event ReserveRateSet(uint256 rate);

    /// @notice Emitted on every reserve reduction.
    event ReserveReduced(
        uint256 totalAmount,
        uint256 jrDistributed,
        uint256 mzDistributed,
        uint256 srDistributed
    );

    /// @notice Emitted whenever a tranche balance flow is recorded.
    event BalanceFlowUpdated(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    );

    /// @notice Emitted on every fee accrual.
    event FeeAccrued(TrancheKind kind, uint256 assets);

    // ---------------------------------------------------------------
    // State-changing — driven by CDO
    // ---------------------------------------------------------------

    /// @notice Refresh accounting using the latest strategy TVL.
    /// @dev    Caller (CDO) MUST pass `strategy.totalAssets()` so the
    ///         accounting contract does not depend on Strategy directly.
    ///         Internally: pulls fresh APYs from the APR Feed if set,
    ///         allocates `netGain` per the protocol's yield-split or
    ///         loss-waterfall rules, updates each tranche TVL, recalcs
    ///         the Senior target index.
    function updateAccounting(uint256 totalStrategyAssets) external;

    /// @notice Record a deposit / withdraw flow per tranche.
    /// @dev    Called by CDO inside `deposit` / `withdraw` / `cooldownShares`.
    ///         The flow numbers are in base-asset units; accounting adjusts
    ///         tranche TVLs and may also re-derive APRs that depend on
    ///         current NAVs.
    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external;

    /// @notice Move accrued fee assets from a tranche's TVL into reserve.
    /// @param  tranche The tranche address. Accounting resolves to kind via CDO.
    /// @param  assets  Amount of fees, in base-asset units.
    function accrueFee(address tranche, uint256 assets) external;

    /// @notice Reduce the reserve, optionally distributing to tranches.
    /// @dev    Driven by CDO's RESERVE_MANAGER. `totalAmount` is removed
    ///         from `reserveTvl`. Of that, `jrDistribute + mzDistribute +
    ///         srDistribute` is added back to the respective tranche TVLs;
    ///         the remainder corresponds to assets transferred out of the
    ///         protocol (e.g. to the treasury).
    /// @param  totalAmount    Total reserve reduction, in base-asset units.
    /// @param  jrDistribute   Portion to redistribute to Junior TVL.
    /// @param  mzDistribute   Portion to redistribute to Mezzanine TVL.
    /// @param  srDistribute   Portion to redistribute to Senior TVL.
    function reduceReserve(
        uint256 totalAmount,
        uint256 jrDistribute,
        uint256 mzDistribute,
        uint256 srDistribute
    ) external;

    // ---------------------------------------------------------------
    // State-changing — APY parameters
    // ---------------------------------------------------------------

    /// @notice Admin override of the APY values fetched from the feed.
    /// @dev    Overwrites the values active for the next
    ///         `updateAccounting(...)` call. The next call may then
    ///         pull-overwrite these if the feed is set.
    function setAPYs(uint256 baseAPY, uint256 benchmarkAPR) external;

    /// @notice Admin set of the APR feed contract address. Pass zero to
    ///         disable pull-mode (push-only afterwards).
    function setAPRFeed(address feed) external;

    /// @notice Admin set of the Senior target-APY parameters.
    /// @param  floor Floor APY (Senior target cannot drop below this).
    /// @param  xSr   Base risk-premium term.
    /// @param  ySr   Tranche-ratio-weighted risk-premium term.
    /// @param  kSr   Exponent on the tranche-ratio term.
    function setSeniorParams(
        uint256 floor,
        uint256 xSr,
        uint256 ySr,
        uint256 kSr
    ) external;

    /// @notice Admin set of the Junior leverage factor (α).
    function setLeverageAlpha(uint256 alpha) external;

    /// @notice Admin set of the share of `netGain` routed to the reserve
    ///         on each `updateAccounting` call. Encoded in 1e18 precision.
    function setReserveRate(uint256 rate) external;

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @notice Compute split assets given a fresh strategy TVL.
    /// @return jrAssets   Assets attributable to Junior.
    /// @return mzAssets   Assets attributable to Mezzanine.
    /// @return srAssets   Assets attributable to Senior.
    /// @return reserveAssets Assets attributable to the reserve.
    function totalAssets(uint256 totalStrategyAssets)
        external view
        returns (
            uint256 jrAssets,
            uint256 mzAssets,
            uint256 srAssets,
            uint256 reserveAssets
        );

    /// @notice Snapshot of the last-recorded TVLs (no fresh calc).
    function totalAssetsT0()
        external view
        returns (
            uint256 jrTvl,
            uint256 mzTvl,
            uint256 srTvl,
            uint256 reserveTvl
        );

    /// @notice Per-tranche view, used by `CDO.totalAssets(tranche)`.
    /// @dev    Reverts if `tranche` is not one of the three CDO vaults.
    function totalAssets(address tranche) external view returns (uint256);

    /// @notice Maximum further deposit accepted by a tranche.
    function maxDeposit(address tranche) external view returns (uint256);

    /// @notice Maximum withdrawal a tranche can satisfy.
    /// @param  tranche       Target tranche address.
    /// @param  isSharesLockup True if the caller is the SharesCooldown
    ///                       silo (different liquidity assumptions).
    function maxWithdraw(address tranche, bool isSharesLockup)
        external view returns (uint256);

    // ---------------------------------------------------------------
    // Views — configuration getters
    // ---------------------------------------------------------------

    function baseAPY() external view returns (uint256);
    function benchmarkAPR() external view returns (uint256);
    function aprFeed() external view returns (address);

    function seniorFloor() external view returns (uint256);
    function seniorXSr() external view returns (uint256);
    function seniorYSr() external view returns (uint256);
    function seniorKSr() external view returns (uint256);

    function leverageAlpha() external view returns (uint256);
    function reserveRate() external view returns (uint256);

    function seniorIndex() external view returns (uint256);
    function lastUpdateTime() external view returns (uint256);
}
```

Notes on signatures:

- All assets and APY values use the protocol's 1e18 precision (same
  as base-asset units / standard fixed-point). Documented per-function
  via `@param` in implementation.
- The `updateAccounting`, `updateBalanceFlow`, `accrueFee`,
  `reduceReserve` functions are all expected to be `onlyCDO` in the
  implementation — interface does not declare access, that's per-impl.
- View functions return zero defaults from a fresh skeleton, not
  reverts. Distinguishing "no body yet" from "view returned default"
  is handled at the test layer (specs 08b/c/d come with tests).

---

### 2. Create `IAPRFeed.sol`

#### File

```text
contracts/interfaces/IAPRFeed.sol
```

#### Full source

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/// @title IAPRFeed
/// @notice Minimal interface the Accounting contract uses to pull base
///         and benchmark APY values from an external feed contract.
/// @dev    Implementation is deferred to a future spec. Accounting
///         tolerates `address(0)` as "feed disabled" (push-only mode).
interface IAPRFeed {
    /// @notice Returns the latest base APY and benchmark APR.
    /// @return baseAPY      Base APY in 1e18 precision.
    /// @return benchmarkAPR Benchmark APR in 1e18 precision.
    function fetchAPYs() external view returns (uint256 baseAPY, uint256 benchmarkAPR);
}
```

No state, no events, no errors in this spec. The contract that
implements `IAPRFeed` is out of scope.

---

### 3. Create `Accounting.sol`

#### File

```text
contracts/core/Accounting.sol
```

#### Full source

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { Initializable } from
    "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { CDOComponent } from "../base/CDOComponent.sol";
import { ICDO } from "../interfaces/ICDO.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";
import { IAPRFeed } from "../interfaces/IAPRFeed.sol";

/// @title  Accounting
/// @notice Pure-calculation accounting contract. Holds tranche TVLs,
///         reserve, APY parameters, and the Senior target index.
///         Holds no funds. Driven exclusively by the CDO (`onlyCDO`)
///         for state-changing accounting hooks; admin-gated setters
///         go through the standard `onlyOwner` / role modifiers
///         inherited from `CDOComponent`.
/// @dev    This skeleton declares the full storage layout and stubs
///         every `IAccounting` method with `NotImplemented()`. Math
///         implementation lands in specs 08b / 08c / 08d.
contract Accounting is Initializable, CDOComponent, IAccounting {
    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error NotImplemented();
    error InvalidTranche(address tranche);

    // ---------------------------------------------------------------
    // Storage — tranche TVLs (post-last-accounting)
    // ---------------------------------------------------------------

    uint256 public tvlJr;
    uint256 public tvlMz;
    uint256 public tvlSr;
    uint256 public tvlReserve;

    // ---------------------------------------------------------------
    // Storage — APY state (pull from feed + admin push)
    // ---------------------------------------------------------------

    uint256 public override baseAPY;
    uint256 public override benchmarkAPR;
    IAPRFeed internal _feed;

    // ---------------------------------------------------------------
    // Storage — Senior-target parameters
    // ---------------------------------------------------------------

    uint256 public override seniorFloor;
    uint256 public override seniorXSr;
    uint256 public override seniorYSr;
    uint256 public override seniorKSr;

    // ---------------------------------------------------------------
    // Storage — yield-split parameters
    // ---------------------------------------------------------------

    uint256 public override leverageAlpha;
    uint256 public override reserveRate;

    // ---------------------------------------------------------------
    // Storage — Senior target index (compounding)
    // ---------------------------------------------------------------

    uint256 public override seniorIndex;
    uint256 public override lastUpdateTime;

    // ---------------------------------------------------------------
    // Storage gap
    // ---------------------------------------------------------------

    /// @dev Reserved for additional fields in future versions.
    uint256[40] private __gap;

    // ---------------------------------------------------------------
    // Initialiser
    // ---------------------------------------------------------------

    /// @notice Initialise the Accounting proxy.
    /// @param  cdo_ The CDO that drives this accounting. Must be non-zero.
    /// @dev    `CDOComponent.cdo` is set here; downstream methods
    ///         enforce `onlyCDO` against this address.
    function initialize(address cdo_) external initializer {
        if (cdo_ == address(0)) revert InvalidCaller(address(0));
        cdo = ICDO(cdo_);

        // Defaults: APYs zero, params zero, indices zero, reserveRate 0.
        // Explicit assignments omitted — storage default is correct.
        seniorIndex = 1e18;            // start index at 1.0 in 1e18 precision
        lastUpdateTime = block.timestamp;
    }

    // ---------------------------------------------------------------
    // State-changing — driven by CDO
    // ---------------------------------------------------------------

    /// @inheritdoc IAccounting
    function updateAccounting(uint256 /*totalStrategyAssets*/)
        external onlyCDO
    {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function updateBalanceFlow(
        uint256 /*jrIn*/, uint256 /*jrOut*/,
        uint256 /*mzIn*/, uint256 /*mzOut*/,
        uint256 /*srIn*/, uint256 /*srOut*/
    ) external onlyCDO {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function accrueFee(address /*tranche*/, uint256 /*assets*/)
        external onlyCDO
    {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function reduceReserve(
        uint256 /*totalAmount*/,
        uint256 /*jrDistribute*/,
        uint256 /*mzDistribute*/,
        uint256 /*srDistribute*/
    ) external onlyCDO {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // State-changing — admin setters
    // ---------------------------------------------------------------
    //
    // Access control on setters is intentionally `NotImplemented()`
    // in this spec. The next spec that adds bodies must pick the
    // correct role for each (likely UPDATER_FEED_ROLE for `setAPYs`
    // and `setAPRFeed`; UPDATER_STRAT_CONFIG_ROLE for Senior /
    // leverage / reserve params). Documented as Open Question.

    /// @inheritdoc IAccounting
    function setAPYs(uint256 /*baseAPY_*/, uint256 /*benchmarkAPR_*/) external {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function setAPRFeed(address /*feed_*/) external {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function setSeniorParams(
        uint256 /*floor*/,
        uint256 /*xSr*/,
        uint256 /*ySr*/,
        uint256 /*kSr*/
    ) external {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function setLeverageAlpha(uint256 /*alpha*/) external {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function setReserveRate(uint256 /*rate*/) external {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @inheritdoc IAccounting
    function totalAssets(uint256 /*totalStrategyAssets*/)
        external view
        returns (
            uint256 jrAssets,
            uint256 mzAssets,
            uint256 srAssets,
            uint256 reserveAssets
        )
    {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function totalAssetsT0()
        external view
        returns (
            uint256 jrTvl_,
            uint256 mzTvl_,
            uint256 srTvl_,
            uint256 reserveTvl_
        )
    {
        // Trivial read: this view is safe to expose even in the
        // skeleton because it returns last-recorded state with no
        // calculation. Implementations of `updateAccounting` must
        // keep these fields fresh.
        return (tvlJr, tvlMz, tvlSr, tvlReserve);
    }

    /// @inheritdoc IAccounting
    function totalAssets(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function maxDeposit(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /// @inheritdoc IAccounting
    function maxWithdraw(address /*tranche*/, bool /*isSharesLockup*/)
        external view returns (uint256)
    {
        revert NotImplemented();
    }

    function aprFeed() external view override returns (address) {
        return address(_feed);
    }

    // ---------------------------------------------------------------
    // Internal helpers — dispatch by address
    // ---------------------------------------------------------------

    /// @dev Resolve `tranche` to its `TrancheKind`. Reads the CDO's
    ///      three vault addresses; reverts `InvalidTranche` otherwise.
    ///      Bodies in specs 08b/c/d will use this when they need to
    ///      route address-keyed methods to per-kind logic.
    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(cdo.jrVault()))   return TrancheKind.JUNIOR;
        if (tranche == address(cdo.mezzVault())) return TrancheKind.MEZZANINE;
        if (tranche == address(cdo.srVault()))   return TrancheKind.SENIOR;
        revert InvalidTranche(tranche);
    }
}
```

#### Storage-layout notes

```text
[Initializable]                  – 1 packed slot
[CDOComponent]                   – cdo (1 slot) + __gap[49]
[Accounting own]                 – 11 slots:
                                   tvlJr, tvlMz, tvlSr, tvlReserve,
                                   baseAPY, benchmarkAPR, _feed,
                                   seniorFloor, seniorXSr, seniorYSr, seniorKSr,
                                   leverageAlpha, reserveRate,
                                   seniorIndex, lastUpdateTime
                                   (15 fields. Some MAY pack — see below.)
                                 + __gap[40]
```

The 15 fields are listed as 15 to be safe; `_feed` packs with nothing
useful next to it (160 bits + 96 of any uint256 would only save a
single slot, and storage clarity > 1 SSTORE savings). Treat the
storage count as 15 standalone slots. `__gap[40]` is generous; future
specs (waterfall state, per-tranche cooldown indices, etc.) can
draw from it append-only.

Document this layout in NatSpec on the contract — auditors run
`forge inspect Accounting storage` to verify.

---

### 4. Amend `PrimeCDO.updateAccounting()`

Spec 06 left this as a bare `revert NotImplemented()`. Now that
`IAccounting.updateAccounting(uint256)` exists, the stub is amended
to forward the strategy TVL:

```diff
- function updateAccounting() external {
-     revert NotImplemented();
- }
+ /// @inheritdoc ICDO
+ function updateAccounting() external onlyTranche {
+     _accounting.updateAccounting(_strategy.totalAssets());
+ }
```

Two changes:

1. Add `onlyTranche` — only the three vaults need to drive
   accounting refresh; admin or arbitrary callers should not be able
   to trigger TVL recalculation.
2. Replace `revert NotImplemented()` with the forwarding call.

Caveat:

- `IStrategy.totalAssets()` does **not** exist yet — `IStrategy` only
  declares `convertToAssets`, `convertToTokens`, `deposit`,
  `getSupportedTokens`. Adding `totalAssets()` to `IStrategy` is a
  prerequisite. This spec adds it.

#### `IStrategy` — Add `totalAssets()`

```diff
  interface IStrategy {
      function convertToAssets(address token, uint256 amount, Math.Rounding rounding) external view returns (uint256);
      function convertToTokens(address token, uint256 amount, Math.Rounding rounding) external view returns (uint256);
      function deposit(address from, address token, uint256 amount) external;
      function getSupportedTokens() external view returns (IERC20[] memory);
+
+     /// @notice Total assets currently held by the strategy, denominated
+     ///         in base-asset units. Used by Accounting to compute
+     ///         `netGain` since the previous update.
+     function totalAssets() external view returns (uint256);
  }
```

`Strategy` contract impl is not yet written — this declaration just
keeps `PrimeCDO` compiling.

---

### 5. Amend `PrimeCDO` — Import `TrancheKind` from `IAccounting`

Spec 07b declared `enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }`
locally in `PrimeCDO`. With this spec, `TrancheKind` moves to
`IAccounting.sol`. `PrimeCDO` imports it.

```diff
+ import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";

  contract PrimeCDO is AccessControlled, ICDO {
-     enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }
-
      ...
  }
```

`PrimeCDO`'s `_kindOf` helper (spec 07b) and the `actionsJr` etc.
fields keep working — they referenced `TrancheKind` by unqualified
name, which now resolves to the imported symbol.

No behavioural change. No selector change. Pure symbol relocation.

---

## Notes

### Why no math in this spec

Per Q1 decision (Interpretation A). The math is large enough that
trying to implement and review it in one spec risks Open Questions
piling up at every formula. Splitting the body across 08b/c/d lets
each spec carry its own justification for rounding direction,
overflow checks, divide-by-zero handling, and edge cases —
unblocking incremental review.

### Why `Accounting` inherits `CDOComponent`

Matches the existing back-ref pattern. `CDOComponent` provides:

- `cdo` reference (used by `_kindOf` to look up vault addresses).
- `onlyCDO` modifier (gates state-changing accounting hooks).
- `getCDOAddress()` (used by `PrimeCDO.config(...)`'s back-reference
  check from spec 05).

`Accounting` therefore plugs into `PrimeCDO.config(...)` without
any new wiring — `config(... address(accounting_)...)` already
calls `getCDOAddress()` on each component and verifies the match.

### `seniorIndex` initialised to `1e18`

The Senior target index compounds over time. Starting at `1e18`
(representing 1.0 in 1e18 precision) is the natural "no growth
yet" baseline. Specs 08b will use this index when calculating
`Sr_yield_target` over the elapsed `block.timestamp -
lastUpdateTime` interval.

### Why setters are `NotImplemented()` and not gated yet

The access role for each setter is itself an Open Question:

- `setAPYs` and `setAPRFeed` likely belong to `UPDATER_FEED_ROLE`
  (matches the role's name).
- `setSeniorParams`, `setLeverageAlpha`, `setReserveRate` likely
  belong to `UPDATER_STRAT_CONFIG_ROLE` or
  `onlyTwoStepConfigManager` (timelock).
- Reserve actions on `reduceReserve` are gated `onlyCDO` because
  CDO is the entry point — CDO's own `reduceReserve` is the
  RESERVE_MANAGER-gated function.

The body-and-role decision is one transaction in code but two
decisions in policy. Leaving both for the next spec keeps this
one clean.

### Forwarding pattern for `updateAccounting`

`PrimeCDO.updateAccounting()` is `onlyTranche` — only the three
vaults can trigger an accounting refresh. The Tranche entrypoints
already call `cdo.updateAccounting()` at the start of every
deposit/mint/withdraw/redeem (spec 03). After this spec, that call
forwards to `accounting.updateAccounting(strategy.totalAssets())`.

The CDO is a thin orchestrator here — it adds no logic on top of
forwarding.

---

## Non-Goals

- Implementing any of the math in `updateAccounting` (08b/c).
- Implementing `maxDeposit` / `maxWithdraw` bodies (08d).
- Implementing `IAPRFeed` (separate spec).
- Implementing `Strategy.totalAssets()` body (Strategy spec).
- Granting access-control roles for the new setters.
- Wiring `PrimeCDO.reduceReserve(...)` to call
  `accounting.reduceReserve(...)` (CDO-side reserve methods).
- Updating tests to cover the skeleton.

---

## Acceptance Criteria

- `contracts/interfaces/IAccounting.sol` matches the source in §1.
- `contracts/interfaces/IAPRFeed.sol` matches the source in §2.
- `contracts/core/Accounting.sol` matches the source in §3,
  compiles under solc 0.8.35, inherits `CDOComponent` and
  `IAccounting`.
- `Accounting.initialize(cdo_)` is `initializer`-guarded, reverts
  `InvalidCaller(address(0))` on zero CDO, sets `cdo`, sets
  `seniorIndex = 1e18`, sets `lastUpdateTime = block.timestamp`.
- All state-changing CDO-driven methods carry `onlyCDO` and revert
  `NotImplemented()`.
- All admin setters revert `NotImplemented()` (no access gate yet).
- All computation views revert `NotImplemented()` except
  `totalAssetsT0()` and `aprFeed()` which return storage trivially.
- Configuration getters (`baseAPY`, `benchmarkAPR`, etc.) return
  the underlying storage default (zero) on a fresh contract.
- `_kindOf` returns the correct enum for each wired vault and
  reverts `InvalidTranche(tranche)` for any other address.
- `IStrategy.sol` declares `totalAssets()` view function.
- `PrimeCDO.sol` imports `TrancheKind` from `IAccounting.sol` and
  no longer declares it locally.
- `PrimeCDO.updateAccounting()` is `onlyTranche` and forwards
  `_strategy.totalAssets()` to `_accounting.updateAccounting(...)`.
- `pnpm build` compiles cleanly under solc 0.8.35.
- No string-based reverts anywhere in the changed files.
- No changes to `Tranche.sol`, `CDOComponent.sol`,
  `AccessControlled.sol`, `IAccessControlManager.sol`, `ICDO.sol`,
  `ICDOComponent.sol`, `ITranche.sol`, or `lib/`.

---

## Check When Done

- Build passes.
- `forge inspect Accounting storage` matches the layout in §3
  storage-layout-notes.
- `progress-tracker.md` updated:
  - Move 08a to **Completed** with files added (`Accounting.sol`,
    `IAPRFeed.sol`) and changed (`IAccounting.sol` expanded,
    `IStrategy.sol` expanded with `totalAssets`, `PrimeCDO.sol`
    amended).
  - Add to **Architecture Decisions**:
    - "`TrancheKind` enum lives in `IAccounting.sol` as the shared
      vocabulary."
    - "Accounting dispatches address-keyed methods via three SLOADs
      against `cdo.jrVault() / mezzVault() / srVault()` — no
      duplicated `_kindOf` table on Accounting."
    - "APR Feed is pull-primary; `setAPYs` exists for admin override."
    - "Reserve receives auto-allocation from `netGain` (configurable
      `reserveRate`) and fee accrual via `accrueFee`."
  - Add to **Open Questions**:
    - Access-control roles for each Accounting setter are TBD.
    - `Strategy.totalAssets()` body — to be implemented when
      Strategy contract is written.
    - `IAPRFeed` implementation — separate spec.
    - `Accounting.reduceReserve` ↔ `CDO.reduceReserve` wiring
      (CDO side currently has no `reduceReserve` function;
      depends on `RESERVE_MANAGER_ROLE` operational policy).
    - Storage layout for `Accounting` — `__gap[40]` chosen
      generously; revisit if specs 08b/c/d need more state.
  - Add session note: full interface expansion, TrancheKind move,
    PrimeCDO ↔ Accounting wiring complete via the skeleton,
    `seniorIndex` baseline initialisation rationale.
- Specs 08b (Case 1 yield split), 08c (Case 2 loss waterfall),
  08d (max limits) are unblocked.
