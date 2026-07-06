# 10'' - ERC20Cooldown (Concrete)

## Overview

Concrete silo holding ERC20 tokens during Strategy-side cooldown
periods. Receives sUSDai from `UsdaiStrategy.withdraw` and
`UsdaiStrategy.reduceReserve`, locks for the configured duration,
releases on `finalize`.

Ships:

- `ERC20Cooldown.sol` — extends `CooldownBase` (spec 11), implements
  `IERC20Cooldown` (spec 10).
- Per-token `cooldownDisabled` flag for the emergency-exit toggle.
- Per-(token, user) request queue with slot-cap merging.

Out of scope:

- Interface changes — `IERC20Cooldown` and `ICooldown` exist from
  spec 10.
- `CooldownBase` — exists from spec 11.
- The Strategy that drives it (`UsdaiStrategy`) — spec 10'.
- Role wiring — `COOLDOWN_WORKER_ROLE` granted to UsdaiStrategy in
  spec 15 (deployment).

---

## Architecture Decisions Recap

| #   | Decision           | Value                                                                                                          |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | Pattern            | Same shape as `SharesCooldown` (spec 11) but for plain ERC20 not vault shares                                  |
| 2   | Storage            | `activeRequests[token][account]` queue + `cooldownDisabled[token]` flag                                        |
| 3   | Request shape      | `TRequest { uint64 unlockAt, uint192 amount }` — packed in one slot                                            |
| 4   | Slot caps          | Reuse `MAX_ACTIVE_REQUEST_SLOTS = 70` (merge) and `PUBLIC_REQUEST_SLOTS_CAP = 40` (revert) from `CooldownBase` |
| 5   | Worker role        | `COOLDOWN_WORKER_ROLE` (the UsdaiStrategy holds it)                                                            |
| 6   | Zero-cooldown path | Immediate `safeTransferFrom(worker → to)` then `Finalized` event — no slot creation                            |
| 7   | `finalize` access  | Permissionless (anyone can finalise on behalf of any user)                                                     |
| 8   | Cancel             | Not supported — once locked, tokens release after cooldown only                                                |
| 9   | Disabled flag      | Per-token. Set by `COOLDOWN_WORKER_ROLE` (Strategy toggles it as part of `setCooldowns`)                       |

---

## Goals

- Land the silo so `UsdaiStrategy.withdraw` and `reduceReserve` have
  a real `IERC20Cooldown` target.
- Match the storage shape and slot-cap semantics already used by
  `SharesCooldown` so audit reviewers see consistency.
- Keep the contract small and stateless beyond its request queues.

---

## File Structure

```text
contracts/
├── core/
│   └── cooldown/
│       ├── CooldownBase.sol            # exists (spec 11)
│       └── ERC20Cooldown.sol           # NEW
│
└── interfaces/
    └── cooldown/
        ├── ICooldown.sol               # exists (spec 10)
        └── IERC20Cooldown.sol          # exists (spec 10)
```

---

## Requirements

### `core/cooldown/ERC20Cooldown.sol`

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ICooldown } from "../../interfaces/cooldown/ICooldown.sol";
import { IERC20Cooldown } from "../../interfaces/cooldown/IERC20Cooldown.sol";
import { CooldownBase } from "./CooldownBase.sol";

/// @title  ERC20Cooldown
/// @notice Silo holding generic ERC20 tokens during Strategy-side
///         cooldown periods.
contract ERC20Cooldown is IERC20Cooldown, CooldownBase {
    using SafeERC20 for IERC20;

    struct TRequest {
        uint64  unlockAt;
        uint192 amount;
    }

    mapping(address token => mapping(address account => TRequest[])) private _activeRequests;
    mapping(address token => bool) public cooldownDisabled;

    // -------------------------------------------------------------
    // Worker entrypoint
    // -------------------------------------------------------------

    function transfer(
        IERC20 token,
        address initialFrom,
        address to,
        uint256 amount,
        uint256 cooldownSeconds
    ) external override onlyRole(COOLDOWN_WORKER_ROLE) {
        if (amount == 0) return;

        if (cooldownSeconds == 0) {
            // Pass-through — no slot, no lock.
            token.safeTransferFrom(msg.sender, to, amount);
            emit Finalized(token, to, amount);
            return;
        }

        TRequest[] storage requests = _activeRequests[address(token)][to];
        uint256 requestsCount = requests.length;

        if (initialFrom != to && requestsCount >= PUBLIC_REQUEST_SLOTS_CAP) {
            revert ExternalReceiverRequestLimitReached(token, initialFrom, to, amount);
        }

        uint64 unlockAt = uint64(block.timestamp + cooldownSeconds);

        if (requestsCount < MAX_ACTIVE_REQUEST_SLOTS) {
            if (requestsCount > 0 && requests[requestsCount - 1].unlockAt == unlockAt) {
                requests[requestsCount - 1].amount += uint192(amount);
            } else {
                requests.push(TRequest(unlockAt, uint192(amount)));
            }
        } else {
            // Slot cap reached — merge into last, extend unlock.
            TRequest storage last = requests[requestsCount - 1];
            last.amount += uint192(amount);
            if (last.unlockAt < unlockAt) last.unlockAt = unlockAt;
        }

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit TransferRequested(token, initialFrom, to, amount, unlockAt);
    }

    // -------------------------------------------------------------
    // User-facing — permissionless finalise
    // -------------------------------------------------------------

    function finalize(IERC20 token, address user) external override returns (uint256) {
        return _finalize(token, user, block.timestamp);
    }

    function finalize(IERC20 token, address user, uint256 at) external override returns (uint256) {
        return _finalize(token, user, at);
    }

    function _finalize(IERC20 token, address user, uint256 at) internal returns (uint256 claimed) {
        if (at > block.timestamp) revert InvalidTime();

        TRequest[] storage requests = _activeRequests[address(token)][user];
        bool isCooldownActive = !cooldownDisabled[address(token)];

        uint256 len = requests.length;
        for (uint256 i; i < len;) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > at) {
                unchecked { i++; }
                continue;
            }
            claimed += req.amount;
            if (i < len - 1) requests[i] = requests[len - 1];
            requests.pop();
            unchecked { len--; }
        }

        if (claimed == 0) revert NothingToFinalize();

        token.safeTransfer(user, claimed);
        emit Finalized(token, user, claimed);
    }

    // -------------------------------------------------------------
    // Admin — emergency lever
    // -------------------------------------------------------------

    /// @notice Toggle cooldown enforcement for `token`. When
    ///         disabled, `finalize` releases all pending entries
    ///         regardless of `unlockAt`.
    /// @dev    Strategy calls this as part of `setCooldowns`.
    function setCooldownDisabled(IERC20 token, bool isCooldownDisabled)
        external override onlyRole(COOLDOWN_WORKER_ROLE)
    {
        cooldownDisabled[address(token)] = isCooldownDisabled;
    }

    // -------------------------------------------------------------
    // Views
    // -------------------------------------------------------------

    function balanceOf(IERC20 token, address user)
        external view override returns (ICooldown.TBalanceState memory)
    {
        return _balanceOf(token, user, block.timestamp);
    }

    function balanceOf(IERC20 token, address user, uint256 at)
        external view override returns (ICooldown.TBalanceState memory)
    {
        return _balanceOf(token, user, at);
    }

    function _balanceOf(IERC20 token, address user, uint256 at)
        internal view returns (ICooldown.TBalanceState memory)
    {
        TRequest[] storage requests = _activeRequests[address(token)][user];
        bool isCooldownActive = !cooldownDisabled[address(token)];

        uint256 len = requests.length;
        uint256 pending;
        uint256 claimable;
        uint256 nextUnlockAt;
        uint256 nextUnlockAmount;

        for (uint256 i; i < len; i++) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > at) {
                pending += req.amount;
                if (nextUnlockAt == 0 || req.unlockAt < nextUnlockAt) {
                    nextUnlockAt = req.unlockAt;
                    nextUnlockAmount = req.amount;
                    continue;
                }
                if (req.unlockAt == nextUnlockAt) {
                    nextUnlockAmount += req.amount;
                }
                continue;
            }
            claimable += req.amount;
        }

        return ICooldown.TBalanceState({
            pending: pending,
            claimable: claimable,
            nextUnlockAt: nextUnlockAt,
            nextUnlockAmount: nextUnlockAmount,
            totalRequests: len
        });
    }

    function activeRequests(address token, address account, uint256 i)
        external view returns (TRequest memory)
    {
        return _activeRequests[token][account][i];
    }

    function activeRequestsLength(address token, address account)
        external view returns (uint256)
    {
        return _activeRequests[token][account].length;
    }
}
```

---

## Notes

### Zero-cooldown short-circuit

When `cooldownSeconds == 0`, the silo skips slot creation entirely:
the worker (Strategy) transfers tokens directly to the recipient via
`safeTransferFrom`, and the silo emits `Finalized` for indexer
parity. No request is recorded. This is the default Atrium behaviour
— Strategy starts with all three tranche cooldowns at zero, so every
withdraw is a single-tx pass-through.

### Why `safeTransferFrom` from the worker (Strategy)

Strategy holds the sUSDai. In the cooldown path, the silo takes
custody by pulling from Strategy (`safeTransferFrom(strategy → silo)`)
and releases by `safeTransfer(silo → user)` on finalise. In the
zero-cooldown path, the silo orchestrates a direct
`safeTransferFrom(strategy → user)` so the silo never holds the
tokens. The pre-approval (Strategy approves silo unlimited at
`initialize` time, spec 10') makes both paths cheap.

### No cancel

`SharesCooldown` has cancel (the user changed their mind, return
shares). `ERC20Cooldown` doesn't — by the time tokens reach this
silo, the Atrium-side withdraw flow has already completed: shares
burned in Tranche, Accounting decremented. Returning tokens would
require re-minting shares or crediting Accounting back, both of
which are out of scope for a silo. If a Strategy-side mistake
needs reversal, the emergency exit is `setCooldownDisabled(true)` +
immediate finalise.

### Slot caps reused from `CooldownBase`

`MAX_ACTIVE_REQUEST_SLOTS = 70`, `PUBLIC_REQUEST_SLOTS_CAP = 40`.
Inherited from spec 11's base. No re-declaration here.

### Per-token granularity for `cooldownDisabled`

The flag is keyed by token, not globally — a single silo can be
shared across multiple Strategy concretes (one per underlying asset)
and toggle each independently. Atrium MVP ships one Strategy
(`UsdaiStrategy`) so this is forward-compat only.

### `setCooldownDisabled` access role

The same `COOLDOWN_WORKER_ROLE` that grants `transfer` access also
grants this toggle. Rationale: Strategy is the one orchestrating
cooldown duration changes (its `setCooldowns` body calls
`silo.setCooldownDisabled(...)`). Separating the role would force
admin to grant two roles to Strategy, which gains nothing.

### Worker-pull pattern in zero-cooldown branch

In the zero-cooldown branch, the silo calls
`token.safeTransferFrom(msg.sender, to, amount)` — i.e., it pulls
from the worker (Strategy) and pushes to the user, never holding
tokens itself. This requires Strategy to keep its silo allowance set
at all times. Allowance is established once at `initialize` (via
`forceApprove(silo, type(uint256).max)`) and never revoked.

---

## Non-Goals

- Cancel functionality.
- Per-user cooldown overrides (only per-token).
- Withdraw rate limits / daily caps.
- Multi-token batched finalise.
- Migration tooling for queue state if `ERC20Cooldown` is ever
  redeployed.

---

## Acceptance Criteria

- `ERC20Cooldown.sol` extends `CooldownBase` and implements every
  `IERC20Cooldown` method.
- Compiles under solc 0.8.35.
- `transfer(..., cooldownSeconds = 0)` performs a single
  `safeTransferFrom(msg.sender, to, amount)` and emits
  `Finalized` — no slot created.
- `transfer(..., cooldownSeconds > 0)` pulls tokens into the silo
  via `safeTransferFrom(msg.sender, address(this), amount)` and
  pushes a `TRequest`.
- Slot-cap behaviour: merge when `requests.length >=
MAX_ACTIVE_REQUEST_SLOTS`; revert
  `ExternalReceiverRequestLimitReached` when `initialFrom != to`
  and `requests.length >= PUBLIC_REQUEST_SLOTS_CAP`.
- `finalize(token, user)` and `finalize(token, user, at)` are
  permissionless and revert `NothingToFinalize` when no entries
  qualify.
- `setCooldownDisabled` is gated by `COOLDOWN_WORKER_ROLE`.
- When `cooldownDisabled[token] == true`, `finalize` releases all
  pending entries regardless of `unlockAt`.
- `balanceOf` views match the queue contents and respect the
  disabled flag.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 10'' to Completed. File: `ERC20Cooldown.sol`.
  - Architecture decisions:
    - Zero-cooldown short-circuit (no slot allocation).
    - No cancel — tokens flow one-way through the silo.
    - Per-token disabled flag, worker-role toggled.
  - Open Questions:
    - Whether `setCooldownDisabled` should require a separate
      `EMERGENCY_ROLE` instead of `COOLDOWN_WORKER_ROLE`.
    - Whether a single silo serving multiple Strategy concretes is
      the deployment target (currently 1:1 with UsdaiStrategy).
- Track A runtime gap closed (Strategy + ERC20Cooldown both
  concrete now).
- Spec 15 (deployment) gains the ERC20Cooldown deploy +
  `COOLDOWN_WORKER_ROLE` grant to UsdaiStrategy step.
