# 06 - Implement PrimeCDO Deposit Flow

## Overview

Replace the `NotImplemented()` stub on `PrimeCDO.deposit(...)` with the real
forwarding flow, and wire the Tranche → Strategy allowance path that the
deposit relies on.

This task introduces:

- `Tranche.configure()` — owner-of-CDO-callable function that approves every
  Strategy-supported token from the Tranche to the Strategy (unlimited).
- `IStrategy` extensions: `deposit(from, token, amount)`, `getSupportedTokens()`.
- `ITranche.configure()` declaration.
- `PrimeCDO.deposit(...)` real body: validates caller is a wired tranche,
  validates `token` is strategy-supported, calls
  `strategy.deposit(tranche, token, tokenAmount)`. Strategy pulls the tokens
  from the tranche using the allowance set by `configure()`.
- Amends `PrimeCDO.config(...)` from spec 05: after wiring all five
  components, calls `configure()` on each of the three tranches so they can
  set up Strategy allowances.
- Amends `PrimeCDO` inheritance from spec 05: adds
  `ReentrancyGuardUpgradeable` to the inheritance chain (pre-deploy, no
  storage-layout impact at runtime).

This task does **not** implement the Strategy contract, the Accounting
contract, withdraw flow, or any yield-distribution logic.

---

## Architecture Decision — Token Flow Pattern

Chosen pattern (Pattern B/3):

```text
Tranche  --(pre-approves unlimited via configure())-->  Strategy
                                                            ▲
                                                            │ pulls
                                                            │ tokens
                                                            │
PrimeCDO  --strategy.deposit(from=tranche, token, amount)-->┘
```

- Tranche **pre-approves Strategy** for every supported token during
  `configure()`. No allowance from Tranche → CDO.
- CDO **orchestrates only** — never holds the deposited tokens, never sets
  allowances on its own balance.
- Strategy pulls tokens **directly from the Tranche** via
  `safeTransferFrom(from, ...)` using the pre-approved allowance.
- Strategy is callable only by CDO (`onlyCDO`), preventing arbitrary
  callers from draining tranches by exploiting the unlimited allowance.

Rejected alternatives are noted in §Notes.

---

## Goals

- Extend `IStrategy` with `deposit(from, token, amount)` and
  `getSupportedTokens()`.
- Extend `ITranche` with `configure()`.
- Implement `Tranche.configure()` — `onlyCDO`, approves every supported
  token to the Strategy unlimited.
- Implement `PrimeCDO.deposit(...)` — `onlyTranche` + `nonReentrant`,
  validates token support, forwards to Strategy.
- Amend `PrimeCDO.config(...)` to call `tranche.configure()` on each
  wired tranche after storage is written.
- Amend `PrimeCDO` to inherit `ReentrancyGuardUpgradeable` and initialize
  it in `initialize(...)`.

---

## File Structure

```text
contracts/
├── core/
│   └── PrimeCDO.sol            # amend: inheritance + deposit + config
│
├── vaults/
│   └── Tranche.sol             # amend: add configure()
│
└── interfaces/
    ├── ICDO.sol                # unchanged
    ├── ITranche.sol            # amend: add configure()
    └── IStrategy.sol           # amend: add deposit() + getSupportedTokens()
```

No new files.

---

## Requirements

### 1. Extend `IStrategy.sol`

Append the two new methods. Do not reorder or modify existing ones.

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

interface IStrategy {
    // --- existing (from spec 04) ---
    function convertToAssets(address token, uint256 amount, Math.Rounding rounding)
        external view returns (uint256);
    function convertToTokens(address token, uint256 amount, Math.Rounding rounding)
        external view returns (uint256);

    // --- new ---

    /// @notice Pulls `amount` of `token` from `from` and stakes it.
    /// @dev    Caller must be the CDO. `from` is the tranche that has
    ///         pre-approved the Strategy via {ITranche.configure}.
    /// @param  from   The tranche holding the tokens.
    /// @param  token  The token to pull and stake.
    /// @param  amount The amount of `token` to pull.
    function deposit(address from, address token, uint256 amount) external;

    /// @notice Returns the list of tokens the strategy currently supports
    ///         for deposit. Bounded list, controlled by Strategy's admin.
    function getSupportedTokens() external view returns (IERC20[] memory);
}
```

Notes:

- `deposit` returns nothing in this spec. If a future spec needs the
  staked amount or share, the signature can be widened in a follow-up.
- `getSupportedTokens()` returns `IERC20[]` (matches what
  `Tranche.configure()` expects); CDO iterates it as a read-only view.

---

### 2. Extend `ITranche.sol`

Append a single method.

```solidity
interface ITranche is IERC4626 {
    /// @notice Approves every Strategy-supported token from this tranche
    ///         to the Strategy (unlimited), so the Strategy can pull
    ///         deposit assets during {ICDO.deposit}.
    /// @dev    Must be callable only by the CDO. Idempotent — safe to
    ///         re-call after the Strategy's supported-token list changes.
    function configure() external;
}
```

---

### 3. Implement `Tranche.configure()`

#### Affected file

```text
contracts/vaults/Tranche.sol
```

#### Imports (add if missing)

```solidity
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 }    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
```

(`SafeERC20` and `IERC20` should already be present from spec 04.)

#### Implementation

```solidity
/// @inheritdoc ITranche
function configure() external onlyCDO {
    address strategy = address(cdo.strategy());
    IERC20[] memory tokens = IStrategy(strategy).getSupportedTokens();
    uint256 len = tokens.length;
    for (uint256 i; i < len;) {
        SafeERC20.forceApprove(tokens[i], strategy, type(uint256).max);
        unchecked { ++i; }
    }
}
```

Notes:

- `onlyCDO` modifier is inherited from `CDOComponent`.
- `forceApprove` (not `approve`) — required for USDT-style tokens that
  revert on `approve` when current allowance != 0.
- `unchecked { ++i; }` is safe because `i < len` and `len` is bounded by
  the Strategy's supported-token list (admin-controlled, not
  user-controlled). Document the assumption inline:

  ```solidity
  // safe: i bounded by len, len bounded by Strategy admin
  ```

- Idempotent: calling twice on the same list is a no-op cost-wise except
  for gas; calling after a token is added re-runs all approvals
  (acceptable for a function gated to CDO-initiated config).

---

### 4. Amend `PrimeCDO` — Inheritance & Initializer

#### Inheritance (spec 05 amendment)

```solidity
import { ReentrancyGuardUpgradeable } from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract PrimeCDO is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ICDO
{ ... }
```

Order matters for storage layout. `ReentrancyGuardUpgradeable` is
inserted **before** `ICDO` so its `_status` slot occupies a deterministic
position in the layout. This is safe because no proxy of `PrimeCDO` has
been deployed yet.

#### Initializer (spec 05 amendment)

```solidity
function initialize(address owner_) external initializer {
    if (owner_ == address(0)) revert ZeroAddress();
    __Ownable_init(owner_);
    __ReentrancyGuard_init();
}
```

#### `__gap` — keep at 50

The `uint256[50] private __gap` declared in spec 05 stays at 50. The
storage slot added by `ReentrancyGuardUpgradeable` (`_status`, 1 slot)
lives in OZ's contract, not in `PrimeCDO`'s own layout, and is followed
by its own `__gap[49]`. `PrimeCDO`'s own storage (`_jrVault` ... `_strategy`

- `__gap[50]`) is unchanged.

---

### 5. Amend `PrimeCDO.config(...)` — Call `tranche.configure()`

After all five components are validated and stored, loop the three
tranches and call `configure()` on each. This sets up the Tranche →
Strategy allowance the new `deposit` flow depends on.

```solidity
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

    // NEW: prime tranche → strategy allowances
    _jrVault.configure();
    _mezzVault.configure();
    _srVault.configure();

    emit Configured(jr, mz, sr, accounting_, strategy_);
}
```

Order matters: `Tranche.configure()` reads `cdo.strategy()`, so
`_strategy` MUST be set before the loop runs.

Re-config behavior:

- Owner may call `config(...)` again with a new strategy.
- New strategy's `getSupportedTokens()` may differ from the previous one.
- Re-config re-runs `configure()` on each tranche, which re-approves the
  new set unlimited.
- Stale allowances from the previous strategy are **not** revoked by
  this flow. Tracked as Open Question.

---

### 6. Implement `PrimeCDO.deposit(...)`

#### Replace the stub

The `NotImplemented()` stub from spec 05 is replaced.

#### Modifier — `onlyTranche`

Declare a new modifier at the top of `PrimeCDO`:

```solidity
error UnauthorizedTranche(address caller);

modifier onlyTranche() {
    if (
        msg.sender != address(_jrVault) &&
        msg.sender != address(_mezzVault) &&
        msg.sender != address(_srVault)
    ) {
        revert UnauthorizedTranche(msg.sender);
    }
    _;
}
```

- Semantics: `msg.sender` must equal one of the three wired tranche
  addresses. The `tranche` parameter on `ICDO.deposit` is **not** checked
  against `msg.sender` (per Q10) — it's documented as informational and
  intentionally redundant.
- If `config(...)` has never been called, all three vault fields are
  `address(0)` and `msg.sender` from any EOA/contract will never equal
  zero (except via `delegatecall` self-call, which `onlyTranche` already
  rules out). Practically the modifier rejects everything pre-config.

#### Token-support validation

A new internal helper checks the strategy's supported list:

```solidity
error TokenNotSupported(address token);

function _requireSupported(address token) internal view {
    IERC20[] memory tokens = _strategy.getSupportedTokens();
    uint256 len = tokens.length;
    for (uint256 i; i < len;) {
        if (address(tokens[i]) == token) return;
        unchecked { ++i; }
    }
    revert TokenNotSupported(token);
}
```

- O(n) loop, n bounded by Strategy admin (same justification as
  `Tranche.configure()`).
- View-only; safe pre-state-change check.

#### `deposit` body

```solidity
/// @inheritdoc ICDO
function deposit(
    address tranche,
    address token,
    uint256 tokenAmount,
    uint256 baseAssets
) external override onlyTranche nonReentrant {
    // `tranche` and `baseAssets` are part of the interface but unused
    // in this spec. `tranche` is informational; `baseAssets` will be
    // consumed by the Accounting hook in a future spec.
    tranche;     // silence unused-param warning
    baseAssets;  // silence unused-param warning

    _requireSupported(token);

    _strategy.deposit(msg.sender, token, tokenAmount);
}
```

Behavior:

- **Checks:** `onlyTranche`, `nonReentrant`, `_requireSupported(token)`.
- **Effects:** none (CDO holds no per-deposit state).
- **Interactions:** single external call to `_strategy.deposit(...)`.
- CEI ordering trivially holds because there are no effects.
- `nonReentrant` defends against malicious tokens or strategies that
  attempt to re-enter `deposit` from inside the strategy call.
- CDO does **not** emit an event (Tranche emits `Deposit` /
  `OnMetaDeposit`; Strategy will emit its own in a future spec).
- `baseAssets` is accepted and ignored in this spec. It is preserved in
  the interface because Accounting will need it (deposits update tranche
  TVL in base-asset units, not token units).

---

### 7. Errors Added to `PrimeCDO`

Added in this spec, declared at the top alongside existing errors:

```solidity
error UnauthorizedTranche(address caller);
error TokenNotSupported(address token);
```

Existing errors from spec 05 (`NotImplemented`, `ZeroAddress`,
`InvalidComponent`) are unchanged.

---

## Notes

### Why Pattern B/3 (Strategy pulls from Tranche)

Two alternatives were rejected:

- **Pattern A (CDO middleman):** Tranche → CDO → Strategy with two
  transfers and CDO managing per-deposit allowances. Cleaner trust model
  (CDO is the only gatekeeper) but costs an extra `transferFrom`, an
  extra `forceApprove`, and adds CDO-side allowance-leakage surface.
- **Pattern C (Push from Tranche):** Tranche transfers directly to
  Strategy before calling `cdo.deposit(...)`. Cleanest CEI but pushes
  orchestration responsibility into Tranche.

Pattern B/3 was chosen because:

- Single token transfer (gas).
- Tranche-to-Strategy allowance is bounded by `Strategy.onlyCDO` — only
  CDO can trigger the pull, so unlimited allowance is not a drain vector.
- CDO stays orchestration-only, no balance to reason about.

### Redundant token-support checks (Open Question)

In the meta-vault path, three places end up checking that `token` is
supported:

1. `Tranche.deposit(address token, ...)` calls
   `cdo.strategy().convertToAssets(token, ...)` — reverts implicitly if
   unsupported (spec 04 comment "Optimistic path").
2. `PrimeCDO.deposit(...)` runs `_requireSupported(token)` explicitly
   (this spec).
3. `Strategy.deposit(...)` will revert internally if it receives an
   unsupported token (future spec).

This is defensive but redundant. Future cleanup: collapse to a single
authoritative check — likely in Strategy — once that contract exists and
its revert behavior is finalized. Tracked in Open Questions.

### Multi-contract scope justification

`ai-workflow-rules.md` says to split work that combines multiple
contracts. This spec touches `PrimeCDO`, `Tranche`, `ITranche`, and
`IStrategy`. The four are **tightly coupled by the deposit flow**: the
deposit cannot work end-to-end without all four changes, and splitting
would force one spec to land a function calling a method that doesn't
exist yet. The changes are co-located and tested together as a single
deposit pathway.

### Strategy is not implemented here

`IStrategy.deposit` and `IStrategy.getSupportedTokens` are declared but
no implementation exists yet. End-to-end testing of the deposit flow
requires a stub or mock Strategy in `test/mocks/` (build-only verification
in this spec; full test coverage deferred until the real Strategy
spec lands).

---

## Non-Goals

This task does NOT include:

- Implementing the real Strategy contract.
- Implementing the Accounting contract or any accounting hooks in CDO's
  deposit flow.
- Implementing `CDO.withdraw(...)` (remains `NotImplemented()`).
- Implementing `CDO.totalAssets`, `CDO.maxDeposit`, `CDO.maxWithdraw`
  (remain `NotImplemented()`).
- Implementing `CDO.updateAccounting()` (remains `NotImplemented()`).
- Revoking stale Strategy allowances when `config(...)` is re-called
  with a new strategy.
- Per-tranche or per-token deposit caps.
- Pausing / circuit breakers.
- Adding access-control roles beyond `OwnableUpgradeable`.
- Strategy event design (deferred to Strategy spec per Q15).
- Wiring `Tranche.cdo` field — still tracked as an Open Question from
  spec 05. `_requireBackRef` in `config(...)` will revert until that's
  resolved; this spec assumes a future Tranche spec adds the setter or
  the `Tranche.initialize` argument.

---

## Acceptance Criteria

- `IStrategy.sol` declares `deposit(address,address,uint256)` and
  `getSupportedTokens() returns (IERC20[] memory)`; existing methods
  unchanged.
- `ITranche.sol` declares `configure()`.
- `Tranche.sol` implements `configure()` with `onlyCDO`, loops
  `getSupportedTokens()` and `forceApprove`s unlimited to Strategy.
- `PrimeCDO.sol` inherits `ReentrancyGuardUpgradeable` between
  `OwnableUpgradeable` and `ICDO`.
- `PrimeCDO.initialize(owner_)` calls `__ReentrancyGuard_init()` after
  `__Ownable_init`.
- `PrimeCDO.config(...)` calls `_jrVault.configure()`,
  `_mezzVault.configure()`, `_srVault.configure()` after storage writes
  and before the `Configured` event.
- `PrimeCDO.deposit(...)` is `onlyTranche` and `nonReentrant`.
- `PrimeCDO.deposit(...)` reverts `TokenNotSupported(token)` when
  `token` is not in `strategy.getSupportedTokens()`.
- `PrimeCDO.deposit(...)` reverts `UnauthorizedTranche(msg.sender)` when
  caller is not one of the three wired vaults.
- `PrimeCDO.deposit(...)` makes exactly one external call to
  `_strategy.deposit(msg.sender, token, tokenAmount)`.
- `PrimeCDO.deposit(...)` does NOT modify CDO storage.
- `PrimeCDO.deposit(...)` does NOT emit an event from CDO.
- All reverts use custom errors — no string `require` / `revert`.
- Named imports only; no wildcard imports.
- `pnpm build` compiles cleanly under solc 0.8.35. New warnings, if
  any, are documented in the session note.
- No changes to `lib/`, OpenZeppelin sources, `ICDO.sol`,
  `IAccounting.sol`, `ICDOComponent.sol`, or `CDOComponent.sol`.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move this task to **Completed** with a summary of changed files:
    `contracts/core/PrimeCDO.sol`, `contracts/vaults/Tranche.sol`,
    `contracts/interfaces/ITranche.sol`,
    `contracts/interfaces/IStrategy.sol`.
  - Note that spec 05's inheritance was amended
    (`ReentrancyGuardUpgradeable` added).
  - Add to Open Questions:
    - Stale Strategy allowance on re-config — revoke explicitly?
    - Redundant token-support checks across Tranche / CDO / Strategy —
      consolidate?
    - `IStrategy.deposit` returns nothing — should it return staked
      amount or share?
    - `baseAssets` parameter on `ICDO.deposit` is currently unused at CDO
      level — confirm Accounting will consume it.
  - Add a session note covering: pattern decision (B/3), why Tranche
    pre-approves Strategy unlimited, why CDO doesn't emit.
