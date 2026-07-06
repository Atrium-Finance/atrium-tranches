# 14 - AccessControlManager (ACM)

## Overview

Ship the concrete `AccessControlManager` contract — the role registry
that backs every `onlyRole(...)` and `_checkAccessAllowed(...)` check
across the protocol. `AccessControlled` (spec 07a) holds the
`IAccessControlManager` reference; this spec lands the actual
contract behind that interface.

Ships:

- `AccessControlManager.sol` — UUPS-upgradeable contract extending
  OZ `AccessControlUpgradeable`. Adds the call-based permission
  layer on top of standard role-based ACL.
- `IAccessControlManager.sol` interface — extends OZ `IAccessControl`
  with the four call-based methods.
- Two namespaces of permission:
  - **Role-based** (OZ-standard): `hasRole(role, account)`,
    `grantRole`, `revokeRole`. Used by `onlyRole(bytes32)`.
  - **Call-based**: `grantCall(contract, sel, account)`,
    `isAllowedToCall(account, sel)`, `hasPermission(...)`. Used by
    `_checkAccessAllowed(bytes4)` for fine-grained per-function
    permissions.

Out of scope:

- The actual role-grant deployment script — spec 15.
- Two-step config manager — separate concern (already a setter
  hook on `AccessControlled` from 07a).
- Migrating consumer contracts off ACM if ACM ever needs replacing
  — `setAccessControlManager(...)` already lives on
  `AccessControlled`.

---

## Architecture Decisions Recap

| #   | Decision                           | Value                                                                                                      |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Pattern scope                      | **Both** `hasRole` and `isAllowedToCall`                                                                   |
| 2   | Base                               | OZ `AccessControlUpgradeable`                                                                              |
| 3   | Upgradeable                        | Yes — UUPS proxy, `initialize` pattern                                                                     |
| 4   | Initial admin                      | Single `admin` arg to `initialize` — granted `DEFAULT_ADMIN_ROLE`                                          |
| 5   | Role encoding for call permissions | `(contractAddress, selector) → bytes32` packed shape (high 20B address + low 4B selector)                  |
| 6   | Global call permission             | `contractAddress = address(0)` in `grantCall` → caller is permitted on **any** contract with that selector |

---

## Goals

- Define the on-chain shape of ACM.
- Make call-based permission queries work transparently with
  `_checkAccessAllowed`.
- Make `roleFor(contract, sel)` an internal pure function with the
  packing convention (high 20B address + low 4B selector).
- Provide UUPS upgrade gating so only `DEFAULT_ADMIN_ROLE` can
  authorise upgrades.

---

## File Structure

```text
contracts/
├── governance/
│   ├── AccessControlManager.sol         # NEW — concrete
│   └── interfaces/
│       └── IAccessControlManager.sol    # exists, amend if missing methods
└── governance/
    └── AccessControlled.sol             # exists (spec 07a), unchanged
```

`AccessControlled.sol` already declares `_checkAccessAllowed(bytes4)`
which calls `acm.isAllowedToCall(msg.sender, sel)`. No changes needed
there.

---

## Requirements

### 1. `IAccessControlManager.sol`

Extends OZ `IAccessControl` with the call-based surface.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

interface IAccessControlManager is IAccessControl {
    event PermissionGranted(address account, address contractAddress, bytes4 sel);
    event PermissionRevoked(address account, address contractAddress, bytes4 sel);

    error StrictPermissionOnly();

    function grantCall(address contractAddress, bytes4 sel, address accountToPermit) external;
    function revokeCall(address contractAddress, bytes4 sel, address accountToRevoke) external;
    function isAllowedToCall(address account, bytes4 sel) external view returns (bool);
    function hasPermission(address account, address contractAddress, bytes4 sel)
        external view returns (bool);
}
```

Note: `IAccessControl` from OZ already declares `hasRole`,
`grantRole`, `revokeRole`, `getRoleAdmin`, `renounceRole`. Don't
re-declare.

---

### 2. `AccessControlManager.sol`

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { AccessControlUpgradeable }
    from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable }
    from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable }
    from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";

/// @title  AccessControlManager
/// @notice Role registry for the Atrium protocol. Backs both
///         `onlyRole(bytes32)` (role-based ACL) and
///         `_checkAccessAllowed(bytes4)` (call-based ACL) on every
///         consumer contract.
contract AccessControlManager is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    IAccessControlManager
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // -------------------------------------------------------------
    // Call-based permissions
    // -------------------------------------------------------------

    function grantCall(address contractAddress, bytes4 sel, address accountToPermit)
        external override
    {
        bytes32 role = _roleFor(contractAddress, sel);
        grantRole(role, accountToPermit);
        emit PermissionGranted(accountToPermit, contractAddress, sel);
    }

    function revokeCall(address contractAddress, bytes4 sel, address accountToRevoke)
        external override
    {
        bytes32 role = _roleFor(contractAddress, sel);
        revokeRole(role, accountToRevoke);
        emit PermissionRevoked(accountToRevoke, contractAddress, sel);
    }

    function isAllowedToCall(address account, bytes4 sel)
        external view override returns (bool)
    {
        // `msg.sender` is the consumer contract performing the check.
        // First try contract-specific permission, then fall back to
        // the global wildcard (contractAddress == 0).
        if (hasRole(_roleFor(msg.sender, sel), account)) return true;
        return hasRole(_roleForGlobal(sel), account);
    }

    function hasPermission(address account, address contractAddress, bytes4 sel)
        external view override returns (bool)
    {
        return hasRole(_roleFor(contractAddress, sel), account);
    }

    // -------------------------------------------------------------
    // Internal — role encoding
    // -------------------------------------------------------------

    /// @dev Pack `(contractAddress: 20B, padding: 8B, sel: 4B)` into a
    ///      bytes32. Reverts on degenerate inputs to keep
    ///      `grantCall(zero, zero, x)` from collapsing into the
    ///      role-based namespace.
    function _roleFor(address contractAddress, bytes4 sel)
        internal pure returns (bytes32 role)
    {
        if (contractAddress == address(0) || sel == bytes4(0)) {
            revert StrictPermissionOnly();
        }
        role = (bytes32(uint256(uint160(contractAddress))) << 96)
             | bytes32(uint256(uint32(sel)));
    }

    /// @dev Global permission slot — same packing with
    ///      `contractAddress == address(0)` reserved for the wildcard
    ///      namespace. Internal-only entry that bypasses the
    ///      degenerate-input check.
    function _roleForGlobal(bytes4 sel) internal pure returns (bytes32 role) {
        if (sel == bytes4(0)) revert StrictPermissionOnly();
        role = bytes32(uint256(uint32(sel)));
    }

    // -------------------------------------------------------------
    // UUPS upgrade gating
    // -------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation)
        internal override onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    // Reserved storage gap for future upgrades.
    uint256[50] private __gap;
}
```

Notes on the contract:

- `Initializable` first in the inheritance chain so the OZ
  upgrade-safe checker recognises the pattern.
- `AccessControlUpgradeable` provides `hasRole`, `grantRole`,
  `revokeRole`, `getRoleAdmin`, `_grantRole`. Reuse without
  override.
- `IAccessControlManager` listed last because it carries no
  implementation, only declarations.
- `_disableInitializers()` in constructor prevents direct
  initialisation of the implementation; only the proxy can call
  `initialize`.
- The single-admin model is intentional. Multi-admin setups are
  achieved post-deploy by the admin granting `DEFAULT_ADMIN_ROLE` to
  additional accounts.
- `isAllowedToCall` performs two `hasRole` reads in the worst case
  (contract-specific miss → global fallback). For consumers that
  never use the wildcard, the second read returns false at the cost
  of one extra storage hit — acceptable.
- `_roleFor` reverts on zero inputs. `_roleForGlobal` is the
  intentional "global namespace" entry. They share the same
  encoding shape except for the high 20 bytes (zero vs. real
  contract).

---

### 3. Constructor Disabling and Init Pattern

Match the rest of the codebase:

```solidity
constructor() {
    _disableInitializers();
}

function initialize(address admin) external initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, admin);
}
```

`__AccessControl_init` is a no-op in current OZ but called for
forward-compat. `__UUPSUpgradeable_init` is also a no-op but kept
for symmetry.

---

### 4. UUPS Upgrade Authorisation

```solidity
function _authorizeUpgrade(address newImplementation)
    internal override onlyRole(DEFAULT_ADMIN_ROLE)
{}
```

Only `DEFAULT_ADMIN_ROLE` can call `upgradeTo` / `upgradeToAndCall`.
The DEFAULT_ADMIN_ROLE itself is rotatable (via standard OZ
`grantRole` / `renounceRole`) so the deploying EOA can hand over to
a multisig post-deploy.

---

## Notes

### Why both ACL patterns

Atrium uses `onlyRole(bytes32)` everywhere today (PrimeCDO,
SharesCooldown, Strategy, Accounting), all relying on `hasRole`.
The call-based layer is added now so future contracts have the
fine-grained option without an ACM redeploy. Example use case:
allow a specific keeper bot to call exactly one Strategy method
without holding any broad role.

### Why the wildcard namespace

`grantCall(address(0), sel, account)` makes `account` callable on
**any** contract that exposes `sel`. Use sparingly — useful for
"hot-wallet keeper rotation" patterns where a bot needs the same
selector across many strategies, and granting per-contract would
require a separate tx for each.

### Why `Initializable` before `AccessControlUpgradeable`

OZ Upgrades plugin scans the inheritance order. `Initializable`
must come first so the plugin recognises the `initializer` modifier
applies. `AccessControlUpgradeable` itself extends `Initializable`,
so this is also semantically correct.

### Role encoding shape

The `_roleFor` packing puts `address` in the high 20 bytes, 8 zero
bytes of padding, and `bytes4 sel` in the low 4 bytes. Conventional
shape for `(contract, selector)`-keyed permissions.

### Why no `setTwoStepConfigManager` here

`twoStepConfigManager` is a property of `AccessControlled` (the
consumer side), not of ACM. ACM is purely a role registry — it does
not know about the config-proposal flow. Setting that address lives
on each consumer.

### Upgrade migration story

If a bug is found in ACM, the protocol has two options:

1. **Patch in place** — deploy `AccessControlManagerV2`, call
   `upgradeTo(V2)` from `DEFAULT_ADMIN_ROLE`. All consumer contracts
   continue using the same ACM proxy address; no consumer changes.
2. **Replace** — deploy fresh ACM, then call
   `setAccessControlManager(newACM)` on every consumer
   (PrimeCDO, Accounting, Strategy, SharesCooldown, Tranches, etc.).
   This is the heavier path; option 1 is preferred.

The contract's storage layout is therefore the single critical
invariant for upgrades. Adding new fields must go AFTER `__gap`
and consume gap slots.

---

## Non-Goals

- `setTwoStepConfigManager` — lives on `AccessControlled`.
- Custom role hierarchies beyond OZ's `getRoleAdmin` default.
- Off-chain indexer compatibility specifics — events already cover
  the new permission-granted path.
- Migration tooling to move from a non-upgradeable ACM (if one were
  ever deployed). The codebase only ships the upgradeable variant.

---

## Acceptance Criteria

- `IAccessControlManager.sol` extends OZ `IAccessControl` with
  `grantCall`, `revokeCall`, `isAllowedToCall`, `hasPermission`.
  Events `PermissionGranted` and `PermissionRevoked` declared.
  Error `StrictPermissionOnly` declared.
- `AccessControlManager.sol` extends OZ
  `AccessControlUpgradeable` + `UUPSUpgradeable`. Compiles under
  solc 0.8.35.
- `initialize(address admin)` grants `DEFAULT_ADMIN_ROLE` to
  `admin`.
- `_disableInitializers()` is called in the constructor.
- `_authorizeUpgrade` gated by `DEFAULT_ADMIN_ROLE`.
- `_roleFor(zero, x)` and `_roleFor(x, zero4)` revert
  `StrictPermissionOnly`.
- `isAllowedToCall(account, sel)` returns true when either
  contract-specific or wildcard permission is granted.
- `hasPermission(account, contract, sel)` returns true only when
  contract-specific permission is granted (no wildcard fallback).
- `grantCall` / `revokeCall` emit the call-based events in addition
  to OZ's `RoleGranted` / `RoleRevoked`.
- `__gap[50]` reserved.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 14 to Completed. Files: `AccessControlManager.sol`,
    `IAccessControlManager.sol`.
  - Architecture decisions:
    - Both ACL patterns supported (`hasRole` + `isAllowedToCall`).
    - UUPS-upgradeable; admin-gated upgrades.
    - Wildcard namespace via `contractAddress == address(0)` in
      `grantCall`.
  - Open Questions:
    - Whether `grantCall` / `revokeCall` should restrict to
      `DEFAULT_ADMIN_ROLE` (currently inherits OZ's
      role-admin-of-the-derived-role check, which for arbitrary
      `_roleFor(...)` values is the zero admin = DEFAULT_ADMIN_ROLE
      by default).
    - Whether wildcard permissions need a per-selector emergency
      revoke (currently relies on `revokeCall(0, sel, account)`).
- Spec 15 (deployment) gains the ACM-proxy deployment step plus
  the role-grant matrix for PrimeCDO, Accounting, Strategy,
  SharesCooldown, Tranches.
- `_checkAccessAllowed` on consumer contracts now reachable (it
  used to be declared in 07a but had no concrete ACM to hit).
