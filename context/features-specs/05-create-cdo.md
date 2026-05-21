# 05 - Create PrimeCDO Skeleton & Component Wiring

## Overview

Create the upgradeable `PrimeCDO` contract — the central orchestrator that
components (Tranches, Accounting, Strategy) reference back to.

This task introduces:

- `IAccounting.sol` minimal interface
- `PrimeCDO.sol` upgradeable contract
- A single atomic `config(...)` entrypoint that wires all five components
  (3 tranches + accounting + strategy) in one transaction, with reverse
  ownership verification on each component.

This task does **not** implement any deposit, withdraw, accounting, or
yield-distribution logic. Every state-changing function from `ICDO` and
every view function that depends on accounting state reverts with
`NotImplemented()`, mirroring the pattern already used in `Tranche.sol`.

---

## Goals

- Create `IAccounting.sol` minimal interface.
- Create upgradeable `PrimeCDO.sol` implementing `ICDO`.
- Provide owner-gated atomic `config(...)` for wiring all components.
- Verify each component's back-reference (`getCDOAddress() == address(this)`)
  before accepting it.
- Establish storage layout, initializer pattern, and `__gap` for future
  expansion.

---

## File Structure

```text
contracts/
├── core/
│   └── PrimeCDO.sol            # NEW
│
└── interfaces/
    ├── ICDO.sol                # existing
    ├── ICDOComponent.sol       # existing
    ├── ITranche.sol            # existing
    ├── IStrategy.sol           # existing
    └── IAccounting.sol         # NEW
```

---

## Requirements

### 1. Create `IAccounting.sol`

#### File

```text
contracts/interfaces/IAccounting.sol
```

#### Implementation

Minimal interface — only the two methods `PrimeCDO` needs to forward to.
Mirrors the `IStrategy` minimality pattern from spec 04. Full accounting
surface (yield split, waterfall, exchange rates, Senior target index, etc.)
is deferred to a dedicated Accounting spec.

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IAccounting {
    /// @notice Refreshes total TVL from strategy and settles yield since
    ///         the previous call.
    function updateAccounting() external;

    /// @notice Returns the current accounting TVL attributable to a tranche.
    /// @param tranche The tranche vault address (jr, mezz, or sr).
    function totalAssets(address tranche) external view returns (uint256);
}
```

No errors, no events, no other methods in this spec.

---

### 2. Create `PrimeCDO.sol`

#### File

```text
contracts/core/PrimeCDO.sol
```

#### Imports

Named imports only, grouped per `code-standards.md`:

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { Initializable } from
    "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from
    "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { ICDO } from "../interfaces/ICDO.sol";
import { ICDOComponent } from "../interfaces/ICDOComponent.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
```

#### Inheritance

```solidity
contract PrimeCDO is
    Initializable,
    OwnableUpgradeable,
    ICDO
{ ... }
```

`PrimeCDO` does **not** inherit `CDOComponent`. `CDOComponent` is for
contracts that point _back to_ the CDO; `PrimeCDO` is the CDO itself.

---

### 3. Storage Layout

Declared in the canonical order from `code-standards.md` (state vars,
events, errors, modifiers, constructor, receive, fallback, external,
public, internal, private).

```solidity
// --- Tranche vaults ---
ITranche internal _jrVault;
ITranche internal _mezzVault;
ITranche internal _srVault;

// --- External components ---
IAccounting internal _accounting;
IStrategy   internal _strategy;

// --- Storage gap (see OZ upgradeable storage gaps) ---
uint256[50] private __gap;
```

Notes:

- Backing fields are `internal` and exposed through the `ICDO` getters
  (`jrVault()`, `mezzVault()`, `srVault()`, `strategy()`) and a new
  `accounting()` getter (see §6).
- `__gap` is sized 50 (matches OZ convention; `CDOComponent` uses 49 because
  it already declares `cdo` + `InvalidCaller`). Do not change the size
  without an upgrade-compatibility review.

---

### 4. Errors

Declare at the top of the contract per `code-standards.md`. All custom
errors, no string reverts.

```solidity
error NotImplemented();
error ZeroAddress();
error InvalidComponent(address component, address expectedCDO, address actualCDO);
```

- `NotImplemented()` — every `ICDO` state-changer and accounting-dependent
  view reverts with this until later specs replace them.
- `ZeroAddress()` — any of the five component addresses passed to `config`
  is `address(0)`.
- `InvalidComponent(component, expectedCDO, actualCDO)` — a component's
  `getCDOAddress()` does not equal `address(this)`. `expectedCDO` is always
  `address(this)`; `actualCDO` is what the component returned.

---

### 5. Events

Per Invariant #8 in `architecture-context.md`, emit on every state change.

```solidity
event Configured(
    address indexed jrVault,
    address indexed mezzVault,
    address indexed srVault,
    address accounting,
    address strategy
);
```

Single event because `config(...)` is atomic. Two of the five addresses
(`accounting`, `strategy`) are non-indexed since EVM caps indexed params
at three per event and the three tranche addresses are the most
filter-relevant.

---

### 6. Initializer

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}

/// @notice Initializes the PrimeCDO proxy.
/// @param owner_ The initial owner (admin) of the CDO. Must be non-zero.
/// @dev    Components are wired separately via {config}.
function initialize(address owner_) external initializer {
    if (owner_ == address(0)) revert ZeroAddress();
    __Ownable_init(owner_);
}
```

- Constructor disables initializers per `architecture-context.md`
  "Upgradeability Model".
- Initializer takes **only** the owner. Tranches, accounting, and strategy
  are wired post-deploy via `config(...)`.

---

### 7. `config(...)` — Atomic Component Wiring

```solidity
/// @notice Atomically wires the five core components to this CDO.
/// @dev    Owner-gated. Every component must already point back to this
///         CDO via its `getCDOAddress()` view, otherwise reverts with
///         `InvalidComponent`. May be called multiple times to re-wire.
/// @param  jr         Junior tranche vault.
/// @param  mz         Mezzanine tranche vault.
/// @param  sr         Senior tranche vault.
/// @param  accounting_ Accounting contract.
/// @param  strategy_  Strategy contract.
function config(
    address jr,
    address mz,
    address sr,
    address accounting_,
    address strategy_
) external onlyOwner {
    _requireNonZero(jr);
    _requireNonZero(mz);
    _requireNonZero(sr);
    _requireNonZero(accounting_);
    _requireNonZero(strategy_);

    _requireBackRef(jr);
    _requireBackRef(mz);
    _requireBackRef(sr);
    _requireBackRef(accounting_);
    _requireBackRef(strategy_);

    _jrVault    = ITranche(jr);
    _mezzVault  = ITranche(mz);
    _srVault    = ITranche(sr);
    _accounting = IAccounting(accounting_);
    _strategy   = IStrategy(strategy_);

    emit Configured(jr, mz, sr, accounting_, strategy_);
}
```

#### Internal helpers

```solidity
function _requireNonZero(address a) internal pure {
    if (a == address(0)) revert ZeroAddress();
}

function _requireBackRef(address component) internal view {
    address actual = ICDOComponent(component).getCDOAddress();
    if (actual != address(this)) {
        revert InvalidComponent(component, address(this), actual);
    }
}
```

#### Behavior notes

- **Re-config is allowed.** Owner may call `config(...)` again at any time.
  Each call re-runs both the zero-address check and the back-reference
  check on all five addresses.
- **All-or-nothing.** If any check fails, no storage is written and no
  event is emitted.
- **No partial setters in this spec.** `setJrVault`, `setAccounting`, etc.
  are intentionally not provided. If granular updates are needed later, a
  follow-up spec can add them — they must keep the same back-reference
  verification rule.

---

### 8. `ICDO` Getters (Trivial Implementations)

These do not depend on accounting state and can be implemented directly.

```solidity
function jrVault()   external view returns (ITranche) { return _jrVault;   }
function mezzVault() external view returns (ITranche) { return _mezzVault; }
function srVault()   external view returns (ITranche) { return _srVault;   }
function strategy()  external view returns (IStrategy){ return _strategy;  }
```

Plus a new accounting getter (not yet on `ICDO`, but trivially useful):

```solidity
function accounting() external view returns (IAccounting) {
    return _accounting;
}
```

> **Open question:** Should `accounting()` be added to `ICDO`? Symmetry
> with `strategy()` suggests yes. Tracked in Open Questions; do not
> modify `ICDO.sol` in this spec.

---

### 9. Stub Implementations (`NotImplemented()`)

Every other `ICDO` function reverts. Pattern matches `Tranche.sol`'s
`IPrimeVault` stubs.

```solidity
function totalAssets(address /*tranche*/) external view returns (uint256) {
    revert NotImplemented();
}

function updateAccounting() external {
    revert NotImplemented();
}

function deposit(
    address /*tranche*/,
    address /*token*/,
    uint256 /*tokenAmount*/,
    uint256 /*baseAssets*/
) external {
    revert NotImplemented();
}

function withdraw(
    address /*tranche*/,
    address /*token*/,
    uint256 /*tokenAmount*/,
    uint256 /*baseAssets*/,
    address /*owner*/,
    address /*receiver*/
) external {
    revert NotImplemented();
}

function maxWithdraw(address /*tranche*/) external view returns (uint256) {
    revert NotImplemented();
}

function maxWithdraw(address /*tranche*/, address /*owner*/) external view returns (uint256) {
    revert NotImplemented();
}

function maxDeposit(address /*tranche*/) external view returns (uint256) {
    revert NotImplemented();
}
```

Unnamed parameters silence the "state mutability can be restricted to
pure" warning at the source — same approach taken on `Tranche.sol`'s
remaining stubs.

---

## Notes

- Upgradeability pattern (UUPS vs Transparent) is still unresolved
  globally (Open Question in tracker). This spec does not pull in
  `UUPSUpgradeable` — defer until the protocol-wide decision is made.
  Adding it later is a forward-compatible inheritance change as long as
  storage layout is preserved.
- No access control roles beyond `OwnableUpgradeable` in this spec. Roles
  (e.g. `KEEPER` for `updateAccounting`, `TRANCHE_ROLE` for
  deposit/withdraw callers) will be introduced when those functions get
  real bodies.
- `Tranche.sol`'s `cdo` field is inherited from `CDOComponent` but is not
  yet initialized anywhere in the codebase. `_requireBackRef` will revert
  on a freshly-deployed `Tranche` whose `cdo == address(0)`. Wiring the
  tranche's back-reference is **out of scope for this spec** but is a
  prerequisite for `config(...)` to succeed end-to-end — captured as an
  Open Question.

---

## Non-Goals

This task does NOT include:

- Implementing `deposit` / `withdraw` routing.
- Implementing `updateAccounting` or any yield/waterfall logic.
- Implementing `totalAssets` or any of the `max*` limit views.
- Building the real `Accounting` contract.
- Building the real `Strategy` contract.
- Adding a `setCDO` setter to `CDOComponent`, or modifying `Tranche.sol`
  to initialize its `cdo` field.
- Adding `accounting()` to the `ICDO` interface.
- Choosing UUPS vs Transparent.
- Defining additional access-control roles.
- Writing deployment scripts.

---

## Acceptance Criteria

- `IAccounting.sol` compiles successfully under solc 0.8.35.
- `PrimeCDO.sol` compiles successfully under solc 0.8.35.
- `PrimeCDO` inherits `Initializable`, `OwnableUpgradeable`, and `ICDO`
  in that order.
- `PrimeCDO` does NOT inherit `CDOComponent`.
- Constructor calls `_disableInitializers()`.
- `initialize(address)` is guarded by `initializer` and reverts on
  zero owner.
- `config(...)` is `onlyOwner`, performs all five zero-address checks,
  all five back-reference checks, writes storage, and emits `Configured`.
- All five back-reference checks revert with
  `InvalidComponent(component, address(this), actualCDO)` when mismatched.
- Getters `jrVault`, `mezzVault`, `srVault`, `strategy`, `accounting`
  return the configured addresses.
- Every other `ICDO` function reverts with `NotImplemented()`.
- All reverts use custom errors — no string-based `require` or `revert`.
- `__gap` is reserved (size 50).
- No string reverts, no `require(..., "msg")`, no `tx.origin`.
- Named imports throughout; no wildcard imports.
- Formatter passes; no linting errors; no circular imports.

---

## Check When Done

- `pnpm build` compiles cleanly under solc 0.8.35 with no new warnings
  beyond the pre-existing pure-mutability notes already tracked.
- `progress-tracker.md` updated:
  - Move this task to **Completed** with a one-line summary of files
    added (`contracts/core/PrimeCDO.sol`,
    `contracts/interfaces/IAccounting.sol`).
  - Add the back-reference wiring caveat (`Tranche.cdo` is uninitialized)
    to Open Questions.
  - Add the `accounting()` getter / `ICDO` symmetry question to Open
    Questions.
  - Add a session note for the change.
- No changes to `lib/`, OpenZeppelin sources, or any existing interface
  file (`ICDO.sol`, `ICDOComponent.sol`, `ITranche.sol`, `IStrategy.sol`).
