# 07b - Implement PrimeCDO Pause (TActionState per Tranche)

## Overview

Add per-tranche pause functionality to `PrimeCDO` using the
`TActionState` struct pattern. Each tranche (Junior, Mezzanine,
Senior) has independent deposit and withdraw flags. Both flags
default to **disabled** — after deploy, a `PAUSER_ROLE` holder must
explicitly enable each tranche/category combination before user
operations can flow through.

Pause state lives only on `PrimeCDO`. Pause checks live only on
`PrimeCDO` (not on `Tranche`). Setters are gated by
`onlyRole(PAUSER_ROLE)` via the `AccessControlled` foundation laid
down in spec 07a.

This task introduces:

- `TrancheKind` enum and `TActionState` struct on `PrimeCDO`.
- Three storage slots (one struct per tranche).
- `_kindOf(address)` helper — generalises StrataCDO's binary `isJrt`
  to three tranches.
- `setActionStates(tranche, depositEnabled, withdrawEnabled)`
  gated by `onlyRole(PAUSER_ROLE)`. `tranche == address(0)` applies
  to all three.
- `_setActionStatesInner(tranche, ...)` — idempotent helper that only
  writes (and emits) when the flag actually changes.
- Disabled-by-default checks inside `CDO.deposit(...)` and
  `CDO.withdraw(...)`.
- Two events: `DepositsStateChanged`, `WithdrawalsStateChanged`.

This task does **not** implement Tranche-level pause checks, the
`AccessControlManager` contract itself, or the operational mechanics
of granting `PAUSER_ROLE`.

---

## Architecture Decisions Recap

| #   | Decision             | Value                                                                                          |
| --- | -------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Pause state location | `PrimeCDO` only                                                                                |
| 2   | Storage shape        | `TActionState` struct, 3 explicit fields                                                       |
| 3   | Default state        | DISABLED for both deposit and withdraw on every tranche                                        |
| 4   | Categories           | `DEPOSIT` (covers Tranche `deposit` + `mint`), `WITHDRAW` (covers `withdraw` + `redeem`)       |
| 5   | Authorization        | `onlyRole(PAUSER_ROLE)` via `AccessControlled`                                                 |
| 6   | API                  | `setActionStates(tranche, depositEnabled, withdrawEnabled)`. `address(0)` applies to all three |
| 7   | Semantics            | Idempotent — only emit on actual flag flip                                                     |
| 8   | Check location       | `PrimeCDO` only (no Tranche-level early check)                                                 |
| 9   | Check functions      | `deposit()` and `withdraw()`                                                                   |
| 10  | Events               | Two separate events (deposits state vs withdrawals state)                                      |

### Accepted trade-off — gas cost on paused reverts

Because the pause check lives at CDO level only, a user transaction
that reaches `Tranche.deposit(...)` while the target tranche is paused
will burn through every step of the Tranche flow (`updateAccounting`,
strategy conversion, `previewDeposit`, `safeTransferFrom`, `_mint`)
before reverting inside `CDO.deposit(...)`. Estimated cost: ~150k gas
wasted per failed call when wallet simulation is bypassed.
Acknowledged trade-off for design simplicity over defense-in-depth.
Tracked in Open Questions for revisit if pause becomes a frequent
operational lever.

---

## Goals

- Add `TrancheKind` enum, `TActionState` struct, three storage slots.
- Add `_kindOf(address) → TrancheKind` helper.
- Add `setActionStates(...)` admin function gated by
  `onlyRole(PAUSER_ROLE)`.
- Wire `notEnabled` reverts into `CDO.deposit(...)` (existing) and
  `CDO.withdraw(...)` (still `NotImplemented()` body, modifier wired
  for the future).
- Update storage-layout NatSpec on `PrimeCDO`.

---

## File Structure

```text
contracts/
└── core/
    └── PrimeCDO.sol            # amend
```

No new files. No changes to interfaces or other contracts.

---

## Requirements

### 1. `TrancheKind` Enum

Declared at the top of `PrimeCDO`, before structs (per
`code-standards.md` ordering — types before state vars).

```solidity
/// @notice Identifies which of the three tranches a function refers to.
enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }
```

Reserved indices `0`, `1`, `2`. Used by `_kindOf` and (potentially)
by future per-tranche logic. Kept in `PrimeCDO.sol` for now —
promote to a shared interface if other contracts start needing it.

---

### 2. `TActionState` Struct

```solidity
/// @notice Per-tranche enable flags for the two action categories.
/// @dev    Both bool fields pack into a single storage slot.
struct TActionState {
    bool isDepositEnabled;
    bool isWithdrawEnabled;
}
```

Packing: two `bool` fields → one storage slot. Documented inline.

---

### 3. Storage Additions

Appended **after** `_strategy` (spec 06) and **before** `__gap`
(spec 05). Three new slots (one per tranche). `__gap` shrinks from
50 to 47 to keep PrimeCDO's reserved layout total at 50 slots.

Safe because no proxy is deployed (per spec 07a confirmation).

```solidity
// --- Pause state ---
TActionState public actionsJr;
TActionState public actionsMezz;
TActionState public actionsSr;

// --- Storage gap (was 50, now 47 after three new struct slots) ---
uint256[47] private __gap;
```

`public` visibility on the three structs auto-generates getters that
return both bools — useful for off-chain monitoring without an extra
view function.

---

### 4. Errors

Added to `PrimeCDO`:

```solidity
error InvalidTranche(address tranche);
error DepositsDisabled(address tranche);
error WithdrawalsDisabled(address tranche);
```

- `InvalidTranche(tranche)` — `_kindOf` received an address that is
  none of the three wired vaults.
- `DepositsDisabled(tranche)` — `CDO.deposit(...)` called for a
  tranche whose `isDepositEnabled == false`.
- `WithdrawalsDisabled(tranche)` — analogous for withdraw.

Existing errors from specs 05/06/07a (`NotImplemented`,
`InvalidComponent`, `UnauthorizedTranche`, `TokenNotSupported`)
unchanged. `ZeroAddress` continues to come from `AccessControlled`.

---

### 5. Events

```solidity
event DepositsStateChanged(address indexed tranche, bool enabled);
event WithdrawalsStateChanged(address indexed tranche, bool enabled);
```

Two separate events (per Q4). Each emits **only** when the
corresponding flag actually flips — idempotent calls produce no
event.

---

### 6. `_kindOf(address)` Helper

Generalises StrataCDO's binary `isJrt` to three tranches.

```solidity
function _kindOf(address tranche) internal view returns (TrancheKind) {
    if (tranche == address(_jrVault))   return TrancheKind.JUNIOR;
    if (tranche == address(_mezzVault)) return TrancheKind.MEZZANINE;
    if (tranche == address(_srVault))   return TrancheKind.SENIOR;
    revert InvalidTranche(tranche);
}
```

Notes:

- Three SLOADs in the worst case. Acceptable because pause-related
  paths are not hot.
- Order of checks (JR → MZ → SR) is conventional and matches the
  loss-waterfall ordering documented in `project-overview.md`.
- Revert with `InvalidTranche(tranche)` (Q2) — consistent with
  StrataCDO behaviour.

### Storage-pointer helper

```solidity
function _actionsOf(address tranche) internal view returns (TActionState storage) {
    TrancheKind kind = _kindOf(tranche);
    if (kind == TrancheKind.JUNIOR)    return actionsJr;
    if (kind == TrancheKind.MEZZANINE) return actionsMezz;
    return actionsSr;
}
```

Returns a `storage` reference so callers can read or write without
copying. Internal-only. The chained `_kindOf` call surfaces the
`InvalidTranche` revert for any non-wired address.

> **Note on `view` mutability:** Solidity 0.8.x treats functions that
> return a `storage` pointer as `view` only if the caller doesn't
> modify through it. Declared `view` here because `_actionsOf` itself
> performs no writes; callers that go on to write through the
> pointer (like `_setActionStatesInner`) are themselves non-view.

---

### 7. `setActionStates(...)` — Public Admin Function

```solidity
/// @notice Sets the deposit and withdraw enable flags for a tranche.
/// @param  tranche          The tranche to modify. Pass `address(0)` to
///                          apply the same settings to all three
///                          tranches at once.
/// @param  isDepositEnabled  Whether `CDO.deposit(...)` is allowed for
///                          this tranche.
/// @param  isWithdrawEnabled Whether `CDO.withdraw(...)` is allowed
///                          for this tranche.
/// @dev    Caller must hold `PAUSER_ROLE` per the access-control
///         manager. Idempotent — flags that already match the
///         requested value are not re-written, and their events are
///         not re-emitted.
function setActionStates(
    address tranche,
    bool isDepositEnabled,
    bool isWithdrawEnabled
) external onlyRole(PAUSER_ROLE) {
    if (tranche == address(0)) {
        _setActionStatesInner(address(_jrVault),   isDepositEnabled, isWithdrawEnabled);
        _setActionStatesInner(address(_mezzVault), isDepositEnabled, isWithdrawEnabled);
        _setActionStatesInner(address(_srVault),   isDepositEnabled, isWithdrawEnabled);
        return;
    }
    _setActionStatesInner(tranche, isDepositEnabled, isWithdrawEnabled);
}
```

Behavioural notes:

- `tranche == address(0)` → batch-apply to all three (Q3, matches
  StrataCDO).
- Otherwise, single tranche. `_setActionStatesInner` reverts
  `InvalidTranche(tranche)` if not one of the three wired vaults.
- Idempotent at flag granularity, not call granularity: calling
  `setActionStates(jr, true, false)` when JR is already
  `(true, false)` performs two no-op compares, zero SSTORE, zero
  events. Calling it when JR is `(false, false)` performs one
  SSTORE on `isDepositEnabled` and emits `DepositsStateChanged` only.
- `PAUSER_ROLE` granted via the external `AccessControlManager` —
  spec 07a wired this dependency.

---

### 8. `_setActionStatesInner(...)` — Internal Helper

```solidity
function _setActionStatesInner(
    address tranche,
    bool isDepositEnabled,
    bool isWithdrawEnabled
) internal {
    TActionState storage state = _actionsOf(tranche);

    if (state.isDepositEnabled != isDepositEnabled) {
        state.isDepositEnabled = isDepositEnabled;
        emit DepositsStateChanged(tranche, isDepositEnabled);
    }

    if (state.isWithdrawEnabled != isWithdrawEnabled) {
        state.isWithdrawEnabled = isWithdrawEnabled;
        emit WithdrawalsStateChanged(tranche, isWithdrawEnabled);
    }
}
```

- Two independent compares — either, both, or neither flag may flip.
- Pure semantic mirror of StrataCDO's `setActionStatesInner`,
  generalised to use `_actionsOf` instead of binary if/else.

---

### 9. Amend `CDO.deposit(...)`

Add an enable check immediately after the existing `_requireSupported`
call. Keep the `onlyTranche nonReentrant` modifiers from spec 06
unchanged.

```diff
  function deposit(
      address tranche,
      address token,
      uint256 tokenAmount,
      uint256 baseAssets
  ) external override onlyTranche nonReentrant {
      tranche;     // informational; see spec 06 §6
      baseAssets;  // reserved for Accounting; see spec 06 §6

      _requireSupported(token);
+
+     if (!_actionsOf(msg.sender).isDepositEnabled) {
+         revert DepositsDisabled(msg.sender);
+     }

      _strategy.deposit(msg.sender, token, tokenAmount);
  }
```

Important details:

- Check is keyed on `msg.sender`, not the `tranche` parameter.
  `onlyTranche` already guarantees `msg.sender` is a wired vault,
  so `_actionsOf(msg.sender)` will not revert `InvalidTranche`.
- Check comes **after** `_requireSupported(token)`. Rationale:
  ordering by likely-to-fail-cheapest matters less here than keeping
  the deposit body's structure easy to follow. Both checks are
  cheap (1 SLOAD each); flipping the order does not materially
  change gas.
- No new modifier — inline `if`. Avoids adding a modifier that's only
  used by two functions and that would otherwise need to take a
  parameter.

---

### 10. Amend `CDO.withdraw(...)`

`withdraw` body remains `NotImplemented()` (spec 06 non-goal), but
the disabled check is wired now so the future withdraw spec inherits
a working pause gate.

```diff
  function withdraw(
      address tranche,
      address token,
      uint256 tokenAmount,
      uint256 baseAssets,
      address owner_,
      address receiver
- ) external override {
+ ) external override onlyTranche {
+     if (!_actionsOf(msg.sender).isWithdrawEnabled) {
+         revert WithdrawalsDisabled(msg.sender);
+     }
+
      tranche; token; tokenAmount; baseAssets; owner_; receiver;
      revert NotImplemented();
  }
```

Two changes:

1. Add `onlyTranche` modifier (it was missing from spec 06's stub).
   Now consistent with `deposit`.
2. Add the inline withdraw-disabled check above the
   `NotImplemented()` revert.

A paused tranche calling `withdraw` will see `WithdrawalsDisabled`
(informative) rather than `NotImplemented` (misleading). When the
real withdraw body lands, the gate is already correct.
`nonReentrant` will be added with the real body.

---

### 11. Storage Layout Doc Update

Update the storage-layout NatSpec block from spec 07a to reflect
the three new slots.

```diff
  /// @dev Storage layout (post 07a baseline):
  ///   [Initializable]                  – 1 packed slot
  ///   [Ownable]                        – _owner (1 slot) + __gap[50]
  ///   [Ownable2Step]                   – _pendingOwner (1 slot) + __gap[49]
  ///   [ReentrancyGuard]                – _status (1 slot) + __gap[49]
  ///   [AccessControlled]               – acm + twoStepConfigManager (2 slots) + __gap[48]
  ///   [PrimeCDO own]                   – _jrVault, _mezzVault, _srVault,
- ///                                      _accounting, _strategy (5 slots) + __gap[50]
+ ///                                      _accounting, _strategy (5 slots)
+ ///                                      + actionsJr, actionsMezz, actionsSr (3 slots, 2 bools packed each)
+ ///                                      + __gap[47]
```

---

## Notes

### Why default DISABLED

Per Q2 (decided earlier). Mirrors StrataCDO. Three reasons:

- A misconfiguration during `config(...)` cannot accidentally open
  user flows before operations explicitly authorise them.
- Forces a deliberate enable step (audit-friendly).
- Storage default for `bool` is `false`, which means no explicit
  initialisation is required — fits the storage default cleanly.

### Why two separate events instead of one

Per Q4. Each event has a single boolean argument and a single
semantic meaning — easier to filter and graph off-chain. Combined
events lead to noisier subscriptions when only one of the two flags
flipped.

### Why `address(0)` for "apply to all" instead of a separate function

Per Q3. Matches the StrataCDO API. Single setter is enough surface
area; users either pass a real tranche or the zero sentinel. A
separate `setAllActionStates` would be redundant.

### Why no `withdraw` `nonReentrant` yet

`nonReentrant` belongs with the real withdraw body — wiring it on
the `NotImplemented()` stub adds nothing (no external calls happen,
no state is touched). The withdraw spec will add it together with
the rest of the body. Documented in §Non-Goals.

### Pause check ordering vs `_requireSupported`

The inline pause check runs after `_requireSupported(token)` in
`deposit`. This is a minor stylistic choice — both checks are cheap
SLOADs and either order is correct. Keeping `_requireSupported`
first preserves the spec-06 deposit body shape and minimises diff
noise.

---

## Non-Goals

- Implementing or deploying `AccessControlManager`.
- Granting `PAUSER_ROLE` to any operational address (deployment
  scripts).
- Implementing `CDO.withdraw(...)` body (still `NotImplemented()`).
- Adding pause checks to `Tranche` entrypoints (explicitly declined
  per the gas trade-off).
- Pausing `updateAccounting`, `config`, `setActionStates`, or view
  functions.
- Auto-pause logic (e.g. StrataCDO's `shortfallPauser`).
- Per-token or per-asset pausing.
- Time-locked pause expiry.
- Adding `nonReentrant` to `withdraw` (lands with the real body).
- Migrating `config()` from `onlyOwner` to a role.

---

## Acceptance Criteria

- `PrimeCDO` declares
  `enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }`.
- `PrimeCDO` declares
  `struct TActionState { bool isDepositEnabled; bool isWithdrawEnabled; }`.
- Three `public` storage variables `actionsJr`, `actionsMezz`,
  `actionsSr` exist, all defaulting to `(false, false)`.
- `__gap` size on `PrimeCDO` is `47`.
- `_kindOf(address)` returns the correct enum value for each wired
  vault and reverts `InvalidTranche(tranche)` for any other address.
- `_actionsOf(address)` returns the correct storage reference for
  each wired vault and reverts `InvalidTranche(tranche)` otherwise.
- `setActionStates(address(0), d, w)` applies `(d, w)` to all three
  tranches.
- `setActionStates(tranche, d, w)` applies to that single tranche
  and reverts `InvalidTranche` for an unwired address.
- `setActionStates` is `onlyRole(PAUSER_ROLE)`.
- Calling `setActionStates` with a flag value equal to the current
  flag value does NOT emit the corresponding event and does NOT
  perform an SSTORE.
- `CDO.deposit(...)` reverts `DepositsDisabled(msg.sender)` when
  the caller's `isDepositEnabled == false`.
- `CDO.withdraw(...)` reverts `WithdrawalsDisabled(msg.sender)` when
  the caller's `isWithdrawEnabled == false`, even though the body
  still ultimately reverts `NotImplemented()` on the success branch.
- `CDO.withdraw(...)` now carries `onlyTranche`.
- After fresh deploy (no `setActionStates` call), `CDO.deposit(...)`
  for any wired tranche reverts `DepositsDisabled`.
- All reverts use custom errors. No string `require` / `revert`
  added by this spec.
- Storage-layout NatSpec on `PrimeCDO` updated to show the three new
  slots and `__gap[47]`.
- `pnpm build` compiles cleanly under solc 0.8.35.
- No changes to `Tranche.sol`, `CDOComponent.sol`, `AccessControlled.sol`,
  `IAccessControlManager.sol`, or any interface.

---

## Check When Done

- Build passes.
- `forge inspect PrimeCDO storage` shows `actionsJr`,
  `actionsMezz`, `actionsSr` between `_strategy` and `__gap`.
- `progress-tracker.md` updated:
  - Move 07b to **Completed** with file changed (`PrimeCDO.sol`).
  - Add to **Architecture Decisions**:
    - "Pause is gated by `PAUSER_ROLE` and stored per-tranche on
      PrimeCDO as `TActionState` structs. Default DISABLED."
    - "Pause check is performed only at CDO level (not Tranche)
      with an accepted ~150k gas trade-off on failed user calls."
  - Add to **Open Questions**:
    - Pause check CDO-only — wasted gas on user reverts when wallet
      simulation is bypassed. Revisit if pause becomes frequent.
    - No `PAUSER_ROLE` grants exist yet because
      `AccessControlManager` is not deployed (carried over from 07a).
      Until granted, no caller can change pause state — protocol is
      effectively frozen until that's resolved.
    - StrataCDO has an auto-pause `shortfallPauser` after every
      deposit/withdraw — confirm Atrium needs the equivalent and
      spec it separately.
    - `TrancheKind` enum lives on `PrimeCDO` for now. Promote to a
      shared interface if other contracts start needing it.
  - Add a session note describing: TActionState pattern adopted,
    disabled-by-default rationale, storage layout shift (`__gap[50]`
    → `__gap[47]`), modifier wiring on `withdraw` stub.
