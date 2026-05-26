# 13 - Reserve Management & Treasury

## Overview

Wire the reserve-extraction path. Reserve sits as a logical bucket
inside Strategy's token holdings; Accounting tracks the amount.
Admin pulls realised profit from reserve to a treasury wallet via
`reduceReserve`.

Ships:

- `treasury` storage + `setReserveTreasury(addr)` owner setter.
- `reduceReserve(token, amount)` — RESERVE_MANAGER_ROLE entry point.
  Decrements Accounting's reserve bucket, then asks Strategy to
  physically transfer tokens to the treasury.
- Event `ReserveReduced` and `TreasurySet`.
- Surface in `ICDO`.

Out of scope:

- `distributeReserve` (returning reserve to tranche NAV) — pushed to
  spec 08c (loss waterfall) where it's semantically tied to recovery
  flow.
- `Accounting.reduceReserve(...)` body — Accounting stays at 08a
  skeleton; this spec forwards to a stub that reverts
  `NotImplemented()` until 08b lands.
- `Strategy.reduceReserve(...)` concrete body — Strategy is still an
  empty abstract (spec 10). The signature exists; the body lands
  with the concrete strategy in 10'.
- AccessControlManager concrete contract — spec 14.

---

## Architecture Decisions Recap

| #   | Decision             | Value                                                                                     |
| --- | -------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Reserve location     | Logical bucket inside Strategy's tokens. Accounting tracks the amount                     |
| 2   | Access control       | `RESERVE_MANAGER_ROLE` (granted via AccessControlled)                                     |
| 3   | Signature            | `reduceReserve(token, amount)` — one token per call                                       |
| 4   | Treasury             | Owner-set via `setReserveTreasury(addr)`. Mutable                                         |
| 5   | distributeReserve    | Deferred to 08c                                                                           |
| 6   | Conversion direction | Strategy converts `tokenAmount → baseAssets` via `Math.Rounding.Floor` (favours protocol) |

---

## Goals

- Add `treasury` storage and the setter.
- Add `reduceReserve(token, amount)` body wiring Accounting + Strategy.
- Surface new methods on `ICDO`.

---

## File Structure

```text
contracts/
├── core/
│   └── PrimeCDO.sol            # amend
│
└── interfaces/
    ├── ICDO.sol                # amend — add sigs
    ├── IAccounting.sol         # amend — declare reduceReserve
    └── IStrategy.sol           # exists (spec 10), reduceReserve sig already there
```

---

## Requirements

### 1. `ICDO.sol` — Amendments

```solidity
function reduceReserve(address token, uint256 amount) external;
function setReserveTreasury(address treasury_) external;
function treasury() external view returns (address);
```

`IAccounting.sol` amend — declare the reserve mutation:

```solidity
/// @notice Decrement the reserve bucket by `baseAssets`.
/// @dev    `jrtAmount` and `srtAmount` reserved for the future
///         distribute flow (08c); current 13 call passes zero.
function reduceReserve(
    uint256 baseAssets,
    uint256 jrtAmount,
    uint256 srtAmount
) external;
```

(Atrium's 3-tranche version: parameters expand later in 08c to
`(baseAssets, jrAmount, mzAmount, srAmount)`. For spec 13, the
2-tranche-style signature with two zero tail args matches the
reference; spec 08c rewrites.)

**Alternative**: ship the 3-tranche-shape `reduceReserve(baseAssets,
jrAmount, mzAmount, srAmount)` now so 08c doesn't need a sig
rewrite. Open Question — defaulting to **the 4-arg version** to
avoid churn.

```solidity
/// @notice Decrement the reserve bucket by `baseAssets`. The
///         remaining args are reserved for the future distribute
///         flow (08c); current 13 caller passes zero.
function reduceReserve(
    uint256 baseAssets,
    uint256 jrAmount,
    uint256 mzAmount,
    uint256 srAmount
) external;
```

---

### 2. Storage Additions

```solidity
/// @notice Recipient wallet for reserve outflows.
address public treasury;
```

Adjacent to `exitFeeJr/Mz/Sr` (from spec 12). Adjust `__gap` count
(reduce by 1).

---

### 3. New Errors and Events

```solidity
error ZeroAddress();

event ReserveReduced(address token, uint256 amount);
event TreasurySet(address treasury);
```

`ZeroAddress` is a generic guard — likely already present from prior
specs. If so, reuse.

---

### 4. `setReserveTreasury(addr)` Setter

```solidity
function setReserveTreasury(address treasury_) external onlyOwner {
    if (treasury_ == address(0)) revert ZeroAddress();
    treasury = treasury_;
    emit TreasurySet(treasury_);
}
```

Owner-only. No "unchanged" check — treasury rotation is rare and a
no-op write is harmless. Zero is rejected to keep the
`treasury == address(0)` precondition in `reduceReserve` meaningful.

---

### 5. `reduceReserve(token, amount)` Entry Point

```solidity
function reduceReserve(address token, uint256 amount)
    external
    onlyRole(RESERVE_MANAGER_ROLE)
{
    if (treasury == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();

    // Reverts UnsupportedToken if Strategy doesn't accept token.
    uint256 baseAssets = _strategy.convertToAssets(token, amount, Math.Rounding.Floor);

    // Reverts in Accounting if reserve insufficient.
    _accounting.reduceReserve(baseAssets, 0, 0, 0);

    // Strategy physically transfers tokens to treasury.
    _strategy.reduceReserve(token, amount, treasury);

    emit ReserveReduced(token, amount);
}
```

Order: precondition checks → conversion → accounting decrement →
physical transfer.

Why `Rounding.Floor`: when converting `tokenAmount → baseAssets`,
floor favours protocol — admin can't accidentally drain more
base-asset equivalent than the actual token movement justifies.

`_accounting.reduceReserve(...)` reverts `NotImplemented()` until
08b. Runtime gap is expected.

`_strategy.reduceReserve(...)` reverts `NotImplemented()` until 10'.
Runtime gap is expected.

---

## Notes

### Why Strategy holds tokens, Accounting tracks the bucket

Reserve isn't a separate vault — it's an abstract slice of the same
token pool the tranches share. Keeping all tokens in one contract
(Strategy) keeps the integration with the underlying yield protocol
simple: Strategy stakes, harvests, and unstakes one balance.
Accounting carves that balance into Jr/Mz/Sr/Reserve buckets for
share-price math.

### Why RESERVE_MANAGER_ROLE, not onlyOwner

Owner is governance — typically a multisig with high-friction key
rotation. Reserve extraction is an ops task: monthly skim, quarterly
profit-take, occasional treasury rebalance. Giving ops a focused
role lets them do their job without holding the multisig key.

### Floor rounding on conversion

`convertToAssets` translates from a particular token (sUSDai or
USDai) into base-asset units. Floor means: if 100 sUSDai equals
102.7 base assets, we credit 102 against the reserve bucket. The
0.7 stays parked in Strategy — effectively a tiny reserve top-up.
The alternative (Ceil) would over-debit the bucket and could push
it negative on rounding alone.

### `ZeroAddress` precondition on every reduceReserve

Cheap defensive check. Without it, an admin could create a window
where treasury was nulled (perhaps mid-migration) and a reserve
manager fires a transfer to the zero address, burning the tokens.

---

## Non-Goals

- distributeReserve (08c).
- Per-token rate limits or daily caps on reserve extraction.
- Multi-token batched extraction in one call.
- Sweep-all helper.
- Reserve-amount view (read via `Accounting.totalAssetsT0()` once
  08b lands).

---

## Acceptance Criteria

- `ICDO.sol` declares `reduceReserve`, `setReserveTreasury`, and
  `treasury()`.
- `IAccounting.sol` declares the 4-arg `reduceReserve(baseAssets,
jrAmount, mzAmount, srAmount)`. 08a body stays `NotImplemented()`.
- `PrimeCDO.sol`:
  - `treasury` storage added; `__gap` adjusted.
  - `setReserveTreasury(addr)` per §4.
  - `reduceReserve(token, amount)` per §5.
  - Uses `RESERVE_MANAGER_ROLE` (declared in `AccessControlled` or a
    shared constants file from 07a).
- All errors are custom.
- `pnpm build` clean under solc 0.8.35.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 13 to Completed. Files: `PrimeCDO.sol`, `ICDO.sol`,
    `IAccounting.sol`.
  - Architecture decisions:
    - Reserve is a logical bucket inside Strategy's token pool.
    - `RESERVE_MANAGER_ROLE` for reduceReserve.
    - Treasury is owner-mutable.
    - `Accounting.reduceReserve` uses the 4-arg shape to
      future-proof for 08c distribute.
  - Open Questions:
    - Whether ops team should have a separate
      `setReserveTreasury` role rather than owner-only.
    - Whether a daily/weekly cap belongs on the extraction path.
    - Runtime gap on both Accounting and Strategy until 10' and 08b.
- Spec 14 (AccessControlManager) gains one more role to register
  (RESERVE_MANAGER_ROLE).
- Spec 08c (loss waterfall) gains the distribute counterpart.
