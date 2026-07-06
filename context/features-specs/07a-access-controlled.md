# 07a - Migrate PrimeCDO to AccessControlled

## Overview

Replace `PrimeCDO`'s direct inheritance of `OwnableUpgradeable` and
`ReentrancyGuardUpgradeable` with a shared `AccessControlled` base
contract. This consolidates upgradeability, ownership, reentrancy
protection, and external role-registry access (via
`IAccessControlManager`) into a single foundation that the rest of the
protocol can adopt.

This task is a **minimal refactor**: it swaps the inheritance chain
and initializer signature without changing any function's access-control
gate. `config(...)` stays `onlyOwner`. No new functions are added.
Pause, role-based gates, and `AccessControlManager` deployment are out
of scope and handled in follow-up specs.

This task is **storage-layout-breaking**. Acceptable because no
`PrimeCDO` proxy is deployed to production yet (confirmed
2026-05-21). After this spec lands, the new layout becomes the
upgrade baseline.

---

## Goals

- Introduce `IAccessControlManager.sol` and `AccessControlled.sol` as
  shared protocol foundation files.
- Replace `Initializable + OwnableUpgradeable + ReentrancyGuardUpgradeable`
  with `AccessControlled` in `PrimeCDO`'s inheritance chain.
- Change `initialize(address owner_)` to
  `initialize(address owner_, address acm_)`.
- Delegate constructor / `_disableInitializers` and `nonReentrant` to
  the `AccessControlled` base.
- Remove the duplicate `error ZeroAddress();` (now inherited).
- Preserve every existing behavior: `config(...)` is still
  `onlyOwner`, `deposit(...)` is still `onlyTranche nonReentrant`, all
  other entrypoints unchanged.

---

## File Structure

```text
contracts/
├── core/
│   └── PrimeCDO.sol                       # amend
│
├── governance/
│   └── AccessControlled.sol               # NEW
│
└── interfaces/
    └── IAccessControlManager.sol          # NEW
```

No changes to `ICDO`, `ICDOComponent`, `ITranche`, `IAccounting`,
`IStrategy`, `Tranche.sol`, or `CDOComponent.sol`.

---

## Requirements

### 1. Create `IAccessControlManager.sol`

#### File

```text
contracts/interfaces/IAccessControlManager.sol
```

#### Full source

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title IAccessControlManager
/// @notice Shared role registry interface used by every contract that
///         inherits {AccessControlled}.
/// @dev    Extends OpenZeppelin's {IAccessControl} so role grants and
///         revocations follow the standard semantics. Adds per-method
///         permissioning (`grantCall` / `revokeCall` /
///         `isAllowedToCall` / `hasPermission`) for fine-grained
///         function-level access if the shared role model is
///         insufficient.
interface IAccessControlManager is IAccessControl {
    function grantCall(
        address contractAddress,
        bytes4 sel,
        address accountToPermit
    ) external;

    function revokeCall(
        address contractAddress,
        bytes4 sel,
        address accountToRevoke
    ) external;

    function isAllowedToCall(address account, bytes4 sel)
        external view returns (bool);

    function hasPermission(
        address account,
        address contractAddress,
        bytes4 sel
    ) external view returns (bool);
}
```

---

### 2. Create `AccessControlled.sol`

#### File

```text
contracts/governance/AccessControlled.sol
```

#### Full source

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { Initializable } from
    "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { Ownable2StepUpgradeable } from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/// @title  AccessControlled
/// @notice Shared base contract for the protocol's privileged components.
/// @dev    Wraps Ownable2Step, ReentrancyGuard, and an external role
///         registry behind a single initializer. Subclasses inherit
///         `onlyOwner`, `onlyRole`, `onlyTwoStepConfigManager`, and
///         `nonReentrant` modifiers. Role state is NOT held in this
///         contract — every `onlyRole` check is delegated to the
///         external {IAccessControlManager} contract set at init time.
abstract contract AccessControlled is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ---------------------------------------------------------------
    // Role identifiers
    // ---------------------------------------------------------------

    bytes32 public constant PAUSER_ROLE                 = keccak256("PAUSER_ROLE");
    bytes32 public constant UPDATER_CDO_APR_ROLE        = keccak256("UPDATER_CDO_APR_ROLE");
    bytes32 public constant UPDATER_FEED_ROLE           = keccak256("UPDATER_FEED_ROLE");
    bytes32 public constant UPDATER_STRAT_CONFIG_ROLE   = keccak256("UPDATER_STRAT_CONFIG_ROLE");
    bytes32 public constant RESERVE_MANAGER_ROLE        = keccak256("RESERVE_MANAGER_ROLE");
    bytes32 public constant COOLDOWN_WORKER_ROLE        = keccak256("COOLDOWN_WORKER_ROLE");
    bytes32 public constant PROPOSER_CONFIG_ROLE        = keccak256("PROPOSER_CONFIG_ROLE");

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    /// @notice External role registry. Queried by every `onlyRole` check.
    IAccessControlManager public acm;

    /// @notice Address authorised to invoke `onlyTwoStepConfigManager`
    ///         functions. Intended to be a timelock-style proposer.
    address public twoStepConfigManager;

    /// @dev Storage gap — see OZ upgradeable storage gaps.
    uint256[48] private __gap;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// @notice Emitted when the access-control manager is changed.
    event NewAccessControlManager(address accessControlManager);

    /// @notice Emitted when the two-step config manager is changed.
    event NewTwoStepConfigManager(address twoStepConfigManager);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    /// @notice Thrown when a call is blocked by the access-control manager.
    error Unauthorized(address sender, address calledContract, bytes4 sel);

    /// @notice Thrown when an `onlyRole(role)` check fails.
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);

    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyRole(bytes32 role) {
        _checkRole(role, _msgSender());
        _;
    }

    modifier onlyTwoStepConfigManager() {
        require(twoStepConfigManager == _msgSender(), "ConfigManagerOnly");
        _;
    }

    // ---------------------------------------------------------------
    // Constructor / initialiser
    // ---------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise the shared base. Subclasses MUST call this
    ///         from their own initialiser.
    /// @param  owner               Initial owner. Must be non-zero
    ///                             (enforced by Ownable2Step).
    /// @param  accessControlManager External role registry. Must be
    ///                             non-zero.
    function AccessControlled_init(address owner, address accessControlManager)
        internal onlyInitializing
    {
        __Ownable_init_unchained(owner);
        __AccessControlled_init_unchained(accessControlManager);
        __ReentrancyGuard_init();
    }

    function __AccessControlled_init_unchained(address accessControlManager)
        internal onlyInitializing
    {
        setAccessControlManagerInner(accessControlManager);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Owner-only setter for the access-control manager.
    function setAccessControlManager(address accessControlManager_)
        external onlyOwner
    {
        setAccessControlManagerInner(accessControlManager_);
    }

    /// @notice Owner-only setter for the two-step config manager.
    function setTwoStepConfigManager(address twoStepConfigManager_)
        external onlyOwner
    {
        if (twoStepConfigManager_ == address(0)) revert ZeroAddress();
        twoStepConfigManager = twoStepConfigManager_;
        emit NewTwoStepConfigManager(twoStepConfigManager_);
    }

    function setAccessControlManagerInner(address accessControlManager)
        internal
    {
        if (accessControlManager == address(0)) revert ZeroAddress();
        acm = IAccessControlManager(accessControlManager);
        emit NewAccessControlManager(accessControlManager);
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    /// @dev Reverts if `msg.sender` is not allowed to call `sel` on this
    ///      contract per the access-control manager's per-method
    ///      permission table.
    function _checkAccessAllowed(bytes4 sel) internal view {
        if (!acm.isAllowedToCall(msg.sender, sel)) {
            revert Unauthorized(msg.sender, address(this), sel);
        }
    }

    /// @dev Reverts if `account` does not hold `role` per the
    ///      access-control manager's role table.
    function _checkRole(bytes32 role, address account) internal view virtual {
        if (!acm.hasRole(role, account)) {
            revert AccessControlUnauthorizedAccount(account, role);
        }
    }
}
```

#### Surface summary (for reference)

What `AccessControlled` provides to subclasses:

- **Inherited base chain:** `Initializable` → `Ownable2StepUpgradeable`
  → `ReentrancyGuardUpgradeable` → `AccessControlled` (abstract).
- **Constructor:** disables initializers (subclasses do NOT need to
  declare a constructor).
- **Init helper:** `AccessControlled_init(address owner, address acm)`
  chains owner init, ACM init, and reentrancy guard init.
- **Modifiers:** `onlyOwner` (from Ownable2Step), `nonReentrant`
  (from RG), `onlyRole(bytes32)` (delegates to external `acm`),
  `onlyTwoStepConfigManager`.
- **Helpers:** `_checkRole`, `_checkAccessAllowed`,
  `setAccessControlManager` (admin), `setTwoStepConfigManager` (admin).
- **Errors:** `Unauthorized`, `AccessControlUnauthorizedAccount`,
  `ZeroAddress`.
- **Events:** `NewAccessControlManager`, `NewTwoStepConfigManager`.

Important note on `onlyRole`: the check is **delegated** to the
external `acm` contract via `acm.hasRole(role, account)`. Init guarantees
`acm != address(0)` (via `setAccessControlManagerInner`), so the call
never reverts on a zero target. If `acm` is set but has no grants for
the role, `_checkRole` reverts `AccessControlUnauthorizedAccount` —
correct behaviour.

The string `require` inside `onlyTwoStepConfigManager` is intentionally
preserved. Tracked as Open Question — see §Notes.

---

### 3. Amend `PrimeCDO.sol` — Inheritance

#### Remove imports

```diff
- import { Initializable } from
-     "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
- import { OwnableUpgradeable } from
-     "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
- import { ReentrancyGuardUpgradeable } from
-     "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
```

#### Add import

```diff
+ import { AccessControlled } from "../governance/AccessControlled.sol";
```

#### Inheritance chain

```diff
  contract PrimeCDO is
-     Initializable,
-     OwnableUpgradeable,
-     ReentrancyGuardUpgradeable,
+     AccessControlled,
      ICDO
  { ... }
```

#### Remove duplicate constructor

`AccessControlled` already declares a constructor that calls
`_disableInitializers()`. Remove PrimeCDO's local one if present.

```diff
- /// @custom:oz-upgrades-unsafe-allow constructor
- constructor() {
-     _disableInitializers();
- }
```

#### Remove duplicate `ZeroAddress` error

`AccessControlled` declares `error ZeroAddress();`. The same error
declared on `PrimeCDO` would compile (Solidity allows it, with the
subclass shadowing) but it is redundant and produces two distinct
selectors for the same conceptual error.

```diff
- error ZeroAddress();
```

`_requireNonZero` continues to compile because `ZeroAddress` is now
the inherited symbol — no behavioural change at the bytecode level.

---

### 4. Amend `PrimeCDO.initialize(...)`

#### Signature change

```diff
- /// @notice Initializes the PrimeCDO proxy.
- /// @param owner_ The initial owner (admin) of the CDO. Must be non-zero.
- /// @dev    Components are wired separately via {config}.
- function initialize(address owner_) external initializer {
-     if (owner_ == address(0)) revert ZeroAddress();
-     __Ownable_init(owner_);
-     __ReentrancyGuard_init();
- }
+ /// @notice Initializes the PrimeCDO proxy.
+ /// @param owner_ The initial owner (admin) of the CDO. Must be non-zero.
+ /// @param acm_   The {IAccessControlManager} that role checks are
+ ///               delegated to. Must be non-zero — AccessControlled
+ ///               reverts otherwise.
+ /// @dev    Components are wired separately via {config}.
+ function initialize(address owner_, address acm_) external initializer {
+     AccessControlled_init(owner_, acm_);
+ }
```

Notes:

- Explicit `owner_ == address(0)` check is gone — `Ownable2Step`'s
  `__Ownable_init_unchained(owner)` reverts on zero owner with its
  own error. Behavioural difference (selector changes); documented
  in §Notes.
- `acm_ == address(0)` reverts with the inherited `ZeroAddress` from
  `setAccessControlManagerInner`.
- No `__ReentrancyGuard_init()` call needed; `AccessControlled_init`
  chains it.

---

### 5. `config(...)`, `deposit(...)`, getters — No Changes

The function bodies stay exactly as merged in specs 05 and 06:

- `config(...)` — `onlyOwner` (keeps owner gate for admin per the
  agreed scope).
- `deposit(...)` — `onlyTranche nonReentrant`. `nonReentrant` now
  resolves through `AccessControlled` → `ReentrancyGuardUpgradeable`,
  same selector as before.
- `_jrVault` / `_mezzVault` / `_srVault` / `_accounting` /
  `_strategy` storage and their getters unchanged.
- `withdraw`, `updateAccounting`, `totalAssets`, `maxDeposit`,
  `maxWithdraw`, `accounting()` — all still `revert NotImplemented()`.

This is the point of the spec: minimum surface change, maximum
upgrade-baseline cleanliness.

---

### 6. Storage Layout Documentation

Document the new layout in source as a NatSpec `@dev` block on
`PrimeCDO` so future upgrade audits have a clear baseline.

```solidity
/// @dev Storage layout (post 07a baseline):
///   [Initializable]                  – 1 packed slot
///   [Ownable]                        – _owner (1 slot) + __gap[50]
///   [Ownable2Step]                   – _pendingOwner (1 slot) + __gap[49]
///   [ReentrancyGuard]                – _status (1 slot) + __gap[49]
///   [AccessControlled]               – acm + twoStepConfigManager (2 slots) + __gap[48]
///   [PrimeCDO own]                   – _jrVault, _mezzVault, _srVault,
///                                      _accounting, _strategy (5 slots) + __gap[50]
///
///   This layout is the upgrade baseline. Future versions must be
///   append-only relative to this layout.
contract PrimeCDO is AccessControlled, ICDO { ... }
```

Exact slot indices are maintained by the compiler; the ordering and
gap sizes are the contract. Auditors verify via
`forge inspect PrimeCDO storage`.

---

## Notes

### What this spec is NOT

- Not a refactor of access-control gates. `config()` stays
  `onlyOwner`. Migration to role-based gates is deferred.
- Not the implementation of `AccessControlManager` itself. Spec 07a
  declares the `acm_` constructor argument and trusts that deployment
  provides a valid contract. A future spec writes the concrete
  `AccessControlManager`.
- Not pause. Pause is spec 07b, written against this baseline.

### Behavioural differences vs. prior PrimeCDO

1. **`initialize` signature** now takes 2 args instead of 1. Deploy
   scripts must be updated.
2. **Owner transfer** is now 2-step (`Ownable2StepUpgradeable`):
   `transferOwnership(newOwner)` only proposes; the new owner must
   `acceptOwnership()`. Strict improvement — transfer-by-typo can't
   lock the contract.
3. **Zero-owner revert selector** changes — `Ownable2Step`'s own
   selector (`OwnableInvalidOwner(address)`) replaces the local
   `ZeroAddress()`. Off-chain decoders need updated ABIs.
4. **Constructor inheritance**: PrimeCDO no longer declares its own
   constructor. The disabled-initializer pattern is inherited.
5. **Role registry dependency**: After this spec, any future use of
   `onlyRole(...)` on PrimeCDO depends on a deployed
   `AccessControlManager` with appropriate grants. Until that exists,
   no `onlyRole`-gated function is added — no live functional blocker.

### Pre-existing patterns kept verbatim

Two patterns in `AccessControlled.sol` deviate slightly from project
code standards but are intentionally preserved:

- `require(twoStepConfigManager == _msgSender(), "ConfigManagerOnly")`
  uses a string require. Convert to a custom error in a dedicated
  cleanup spec — tracked in Open Questions.
- `_msgSender()` is used in modifiers rather than `msg.sender`. This
  is OZ's meta-transaction-compatible pattern; harmless when no
  meta-tx forwarder is wired.

### Why `AccessControlManager` is a separate contract

Embedding `AccessControlUpgradeable` directly in `PrimeCDO` would:

- Replicate role state in every privileged contract.
- Force per-contract role grants (administrative overhead).
- Couple PrimeCDO's upgrade lifecycle to AC's role-admin migration.

The external-registry pattern (one `AccessControlManager` shared by
many `AccessControlled` consumers) matches modern lending-protocol
practice.

---

## Non-Goals

- Implementing `AccessControlManager`.
- Refactoring `config()`, `deposit()`, or any other function's
  access gate.
- Adding pause functionality.
- Removing or renaming any existing PrimeCDO function.
- Changing `Tranche.sol` to use `AccessControlled`.
- Migrating `CDOComponent` to use `AccessControlled`.
- Writing deployment scripts that wire `acm_`.
- Converting `onlyTwoStepConfigManager`'s string require to a custom
  error.

---

## Acceptance Criteria

- `contracts/interfaces/IAccessControlManager.sol` exists, pragma
  `0.8.35`, license `BUSL-1.1`, surface matches the source in §1.
- `contracts/governance/AccessControlled.sol` exists, pragma
  `0.8.35`, license `BUSL-1.1`, matches the source in §2.
- `PrimeCDO` inherits `AccessControlled` directly (not the three OZ
  bases).
- `PrimeCDO` declares no constructor (inherited from
  `AccessControlled`).
- `PrimeCDO.initialize(address owner_, address acm_)` exists, is
  `initializer`-guarded, and calls `AccessControlled_init(owner_, acm_)`
  as its single statement.
- `PrimeCDO` no longer declares `error ZeroAddress();`.
- `PrimeCDO` still declares `NotImplemented`, `InvalidComponent`,
  `UnauthorizedTranche`, `TokenNotSupported` errors.
- `config(...)` is `onlyOwner`, body unchanged.
- `deposit(...)` is `onlyTranche nonReentrant`, body unchanged.
- All other `ICDO` functions still revert `NotImplemented()`.
- Storage-layout NatSpec block exists at the top of `PrimeCDO`.
- `forge inspect PrimeCDO storage` (or equivalent) lists storage in
  the order documented.
- `pnpm build` compiles cleanly under solc 0.8.35.
- No new string-based reverts in the changed files. (The single
  pre-existing string require inside `AccessControlled` is acceptable
  per §Notes.)
- No changes to `CDOComponent.sol`, `Tranche.sol`, `ICDO.sol`,
  `ICDOComponent.sol`, `ITranche.sol`, `IAccounting.sol`,
  `IStrategy.sol`.

---

## Check When Done

- Build passes.
- `forge inspect PrimeCDO storage` matches the documented layout.
- `progress-tracker.md` updated:
  - Move 07a to **Completed** with files added (`AccessControlled.sol`,
    `IAccessControlManager.sol`) and changed (`PrimeCDO.sol`).
  - Add to **Architecture Decisions**:
    - "PrimeCDO uses the external-registry access-control pattern via
      `AccessControlled` + `IAccessControlManager`."
    - "PrimeCDO's storage-layout baseline shifted on 2026-05-DD. All
      future upgrades start from this layout."
  - Add to **Open Questions**:
    - `AccessControlManager` implementation is not yet written — until
      written and deployed, `acm_` arg must point at a contract
      satisfying `IAccessControlManager`; tests use a mock.
    - Deploy script must be updated to supply `acm_` to
      `initialize(...)`.
    - Owner-transfer flow is now 2-step — confirm operational tooling
      handles `acceptOwnership()`.
    - `onlyTwoStepConfigManager` in `AccessControlled` uses a string
      `require` — convert to custom error in a follow-up cleanup.
    - Several role constants imported via `AccessControlled` are not
      yet wired to any function — track as protocol evolves.
  - Add a session note: pragma, license, storage layout shift, and
    confirmation no proxy was live.
- Spec 07b (pause via `TActionState`) is unblocked.
