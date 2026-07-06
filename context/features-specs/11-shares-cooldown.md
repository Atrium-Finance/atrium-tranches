# 11 - SharesCooldown Silo

## Overview

`SharesCooldown` is the silo contract that holds tranche shares during
coverage-driven cooldown periods. It owns the per-vault coverage
ranges (which determine cooldown duration and exit fee), tracks
individual redeem requests, and finalises them back through the
tranche vaults once the lock expires.

This spec ships:

- `ISharesCooldown.sol` interface — request shape, exit-params shape,
  coverage-range bounds shape, events, and the full external surface.
- `ICooldown.sol` shared base interface — already created in spec 10
  for `IERC20Cooldown`; SharesCooldown extends it.
- `SharesCooldown.sol` contract — implements `ISharesCooldown`,
  inherits from a small `CooldownBase` that holds the shared
  constants and the `AccessControlled` plumbing.
- `CooldownBase.sol` abstract — pulled out of the upstream pattern.
  Holds the slot-cap constants and the standard `initialize` hook.

This spec does NOT ship:

- The PrimeCDO integration (`cooldownShares`, `calculateExitMode`,
  `setSharesCooldown` is already in 09'). PrimeCDO's withdraw body
  is spec 12.
- The `Tranche.burnSharesAsFee` entry point used during fee accrual
  — Tranche spec is separate (already exists in foundation).
- A standalone `ERC20Cooldown` silo (spec 10'').

---

## Architecture Decisions Recap

| #   | Decision                  | Value                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Request representation    | Storage struct + `requestId` (array index). Non-transferable                                                             |
| 2   | Lock mechanism            | Lock shares in silo. Shares remain in the vault `totalSupply` and continue accruing yield                                |
| 3   | Coverage ranges           | **3 ranges fixed**: `r0` (cov ≤ p0), `r1` (p0 < cov ≤ p1), `r2` (cov > p1). One slot per vault for bounds. `O(1)` lookup |
| 4   | Per-tranche config        | All 3 tranches have independent `vaultExitBounds`. Admin sets each                                                       |
| 5   | Claim path                | Silo redeems through the Tranche → tokens flow to receiver in one tx                                                     |
| 6   | Cancel                    | Allowed at any time by the recipient. Shares return to the user; **no fee**                                              |
| 7   | Coverage snapshot         | Coverage fresh at request time. Subsequent coverage changes do not retroactively affect queued requests                  |
| 8   | Slot caps                 | `MAX_ACTIVE_REQUEST_SLOTS = 70` (merge on overflow), `PUBLIC_REQUEST_SLOTS_CAP = 40` (revert when external receiver)     |
| 9   | Early exit fee            | Enabled per-vault via `vaultEarlyExitFeePerDay`. Capped at 1%/day. Fee = `feePerDay × daysLeft`                          |
| 10  | Access on `requestRedeem` | `onlyRole(COOLDOWN_WORKER_ROLE)`. PrimeCDO holds the role                                                                |
| 11  | Coverage encoding         | `uint256` 1e18 throughout. Matches PrimeCDO's `coverage()`. No conversion                                                |
| 12  | Fee encoding              | `uint256` 1e18 (e.g. `0.005e18 = 0.5%`). Consistent with the rest of the codebase                                        |
| 13  | `sharesLock` encoding     | `uint32` seconds (max ~136 years). Fits comfortably in one slot alongside `feePpm`                                       |

Note on slot packing: with `uint256` for `p0`, `p1`, and `feePpm`,
`TExitUpperBounds` no longer fits in a single slot — it consumes
8 slots per vault. Accepted trade-off per Q5 to keep precision
consistent with spec 09.

---

## Goals

- Define the on-chain shape and behaviour of the silo.
- Provide a typed external surface so PrimeCDO can call
  `sharesCooldown.calculateExitParams(...)` and
  `sharesCooldown.requestRedeem(...)` without ad-hoc encoding.
- Cover the three user-facing flows: `finalize`, `finalizeWithFee`,
  `cancel`.
- Wire the role gating so only the CDO (granted the worker role) can
  create requests.

---

## File Structure

```text
contracts/
├── core/
│   └── cooldown/
│       ├── CooldownBase.sol           # NEW — abstract
│       └── SharesCooldown.sol         # NEW — concrete
│
└── interfaces/
    └── cooldown/
        ├── ICooldown.sol              # exists from spec 10
        └── ISharesCooldown.sol        # NEW
```

`ICooldown.sol` from spec 10 is reused. `IERC20Cooldown.sol` (also
from spec 10) is **not** referenced by `SharesCooldown` — they are
sibling concretes of the same base interface.

---

## Requirements

### 1. `interfaces/cooldown/ISharesCooldown.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "../ITranche.sol";
import { ICooldown } from "./ICooldown.sol";

/// @title  ISharesCooldown
/// @notice Silo for tranche vault shares during coverage-driven
///         cooldown periods. Tracks per-recipient redeem requests,
///         finalises them through the originating vault, and applies
///         optional early-exit fees.
interface ISharesCooldown is ICooldown {
    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    /// @notice One queued redeem request.
    /// @param  unlockAt The earliest `block.timestamp` at which this
    ///                  request can be finalised without paying the
    ///                  early-exit fee.
    /// @param  shares   The amount of vault shares locked in the silo
    ///                  for this request.
    /// @param  token    The output asset the user expects on
    ///                  finalisation (set at request time; may be
    ///                  overridden via `finalizeWithTokenOverride` or
    ///                  the `token` argument of `finalize`).
    struct TRequest {
        uint64 unlockAt;
        uint192 shares;
        address token;
    }

    /// @notice Exit parameters returned by {calculateExitParams}.
    /// @dev    18-decimal fee, seconds for the lock.
    struct TExitParams {
        uint256 feeBps;       // 1e18 = 100%, capped at PERCENTAGE_100
        uint32  sharesLock;   // seconds
    }

    /// @notice Per-vault coverage bounds and the three exit-range
    ///         parameter triples.
    /// @dev    Three ranges:
    ///           - `coverage ≤ p0`   → r0 (typically longest lock /
    ///                                 highest fee)
    ///           - `p0 < coverage ≤ p1` → r1
    ///           - `coverage > p1`   → r2 (typically zero)
    ///         `p0 ≤ p1` invariant enforced by {setVaultExitBounds}.
    struct TExitUpperBounds {
        uint256 p0;
        uint256 p1;
        TExitParams r0;
        TExitParams r1;
        TExitParams r2;
    }

    /// @notice Guard struct for {finalizeWithFee}. Caller may zero
    ///         out fields they don't want checked.
    struct TFinalizeWithFeeGuard {
        uint192 shares;
        uint256 daysLeft;
    }

    /// @notice Guard struct for {cancel}.
    struct TCancelGuard {
        uint192 shares;
    }

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event RequestedCooldown(
        address indexed vault,
        address token,
        address initialFrom,
        address to,
        uint256 shares,
        uint64 unlockAt
    );
    event RequestCanceled(address indexed vault, address user, uint256 shares);
    event VaultCooldownBoundsUpdated(address indexed vault, TExitUpperBounds bounds);
    event VaultEarlyExitFeeSet(address indexed vault, uint256 earlyExitFee);
    event ExitFeeAccrued(
        address indexed vault,
        address user,
        uint256 sharesFee,
        uint256 sharesUser
    );

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error OnlySharesOwner(address caller, address expectedOwner);
    error OutOfRange(uint256 index, uint256 length);
    error RequestReady(uint256 unlockAt, uint256 nowTs);
    error UnexpectedShares(uint192 actual, uint192 guard);
    error UnexpectedDays(uint256 actual, uint256 guard);
    error EmptyFee();
    error InvalidFee(uint256 fee);
    error InvalidBounds(uint256 p0, uint256 p1);
    error MaxRedemptionLimitReached();

    // ---------------------------------------------------------------
    // User-facing entrypoints
    // ---------------------------------------------------------------

    /// @notice Finalise claimable requests for `user` on `vault`,
    ///         optionally filtered to a single `token`. Permissionless
    ///         (anyone may finalise on behalf of any user).
    function finalize(ITranche vault, address token, address user) external returns (uint256 claimed);

    /// @notice Same as {finalize} but evaluates claimability at the
    ///         supplied timestamp (for view-style finalisation; the
    ///         on-chain enforcement still requires
    ///         `at <= block.timestamp`).
    function finalize(ITranche vault, address token, address user, uint256 at) external returns (uint256 claimed);

    /// @notice Finalise all claimable requests for `user` using
    ///         `token` regardless of each request's recorded token.
    ///         Restricted to the recipient (`user == msg.sender`).
    function finalizeWithTokenOverride(
        IERC20 vault,
        address token,
        address user
    ) external returns (uint256 claimed);

    /// @notice Early-finalise a single not-yet-unlocked request by
    ///         paying a fee proportional to days remaining.
    ///         Restricted to the recipient.
    /// @param  vault The tranche vault whose request is being exited.
    /// @param  token Output token override; `address(0)` keeps the
    ///               request's recorded token.
    /// @param  user  The recipient (must equal `msg.sender`).
    /// @param  i     Index of the request in the user's active queue.
    /// @param  guard Optional guard rails on shares and days-left.
    function finalizeWithFee(
        ITranche vault,
        address token,
        address user,
        uint256 i,
        TFinalizeWithFeeGuard calldata guard
    ) external returns (uint256 claimed);

    /// @notice Cancel an active request and return the shares to the
    ///         recipient. Restricted to the recipient. No fee.
    /// @dev    Allowed at any time, including after the lock has
    ///         expired but before {finalize}.
    function cancel(
        IERC20 vault,
        address user,
        uint256 i,
        TCancelGuard calldata guard
    ) external;

    // ---------------------------------------------------------------
    // Worker entrypoints (CDO)
    // ---------------------------------------------------------------

    /// @notice Lock `shares` of `vault` from `initialFrom` for `to`,
    ///         recording a lockup that expires after `cooldownSeconds`.
    /// @dev    Caller must hold `COOLDOWN_WORKER_ROLE` (PrimeCDO).
    ///         If `fee > 0`, a portion of the shares is burned as
    ///         entry fee via `vault.burnSharesAsFee(...)` before the
    ///         rest is locked. When `cooldownSeconds == 0`, the
    ///         function instead redeems immediately through the
    ///         vault and emits `Finalized`.
    /// @param  vault            The originating tranche vault.
    /// @param  token            Output token recorded for finalisation.
    /// @param  initialFrom      The account whose redemption this is
    ///                          (caller-provided; informational for
    ///                          slot-cap accounting).
    /// @param  to               The recipient who can finalise/cancel.
    /// @param  shares           Vault shares to lock (or redeem if no
    ///                          cooldown).
    /// @param  fee              Entry fee in 1e18 precision (`0.005e18`
    ///                          = 0.5%). Burned from `shares` via the
    ///                          tranche before lockup.
    /// @param  cooldownSeconds  Lock duration. `0` triggers immediate
    ///                          finalisation.
    function requestRedeem(
        ITranche vault,
        address token,
        address initialFrom,
        address to,
        uint256 shares,
        uint256 fee,
        uint32  cooldownSeconds
    ) external;

    // ---------------------------------------------------------------
    // Admin entrypoints
    // ---------------------------------------------------------------

    /// @notice Set the three coverage ranges for `vault`.
    /// @dev    Owner-gated. Requires `bounds.p0 <= bounds.p1`.
    ///         Passing `bounds.r2.sharesLock = 0 && bounds.p1 == 0`
    ///         is the canonical "cooldown disabled" configuration
    ///         (`finalize` returns immediately for all locked shares).
    function setVaultExitBounds(address vault, TExitUpperBounds calldata bounds) external;

    /// @notice Set the per-day early-exit fee rate for `vault`.
    /// @dev    Owner-gated. Capped at `0.01e18` (1%/day). Setting to
    ///         zero disables {finalizeWithFee}.
    function setVaultEarlyExitFee(address vault, uint256 fee) external;

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @notice Returns the exit parameters that apply to `vault` at
    ///         the supplied coverage level.
    /// @dev    `coverage` is in 1e18 precision (matches
    ///         `PrimeCDO.coverage()`). Selection rule:
    ///           - `coverage ≤ p0`   → `r0`
    ///           - `p0 < coverage ≤ p1` → `r1`
    ///           - otherwise         → `r2`
    function calculateExitParams(
        address vault,
        uint256 coverage
    ) external view returns (TExitParams memory);

    /// @notice Returns the configured bounds for `vault`.
    function vaultExitBounds(address vault) external view returns (TExitUpperBounds memory);

    /// @notice Returns the configured early-exit per-day fee for `vault`.
    function vaultEarlyExitFeePerDay(address vault) external view returns (uint256);

    /// @notice Returns the i-th active request for `(vault, account)`.
    function activeRequests(address vault, address account, uint256 i)
        external view returns (TRequest memory);

    /// @notice Returns the number of active requests for
    ///         `(vault, account)`.
    function activeRequestsLength(address vault, address account)
        external view returns (uint256);
}
```

Notes on the interface:

- `ITranche` is the tranche vault interface (already exists in the
  Atrium codebase) which extends `IERC4626` with the Atrium-specific
  `burnSharesAsFee(...)`, `redeem(token, shares, receiver, owner)`,
  and `getCDOAddress()` views.
- `IERC20 vault` overloads on `cancel` / `finalizeWithTokenOverride`
  exist because those entry points don't need the full `ITranche`
  surface — only the share-token surface.
- `coverage` argument on `calculateExitParams` is `uint256` 1e18 —
  PrimeCDO passes its `coverage()` value directly with no
  conversion.

---

### 2. `core/cooldown/CooldownBase.sol`

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { AccessControlled } from "../../governance/AccessControlled.sol";
import { ICooldown } from "../../interfaces/cooldown/ICooldown.sol";

/// @title  CooldownBase
/// @notice Shared base for silo contracts that hold assets during a
///         cooldown period. Centralises the slot-cap constants and
///         the standard `initialize(owner, acm)` hook.
abstract contract CooldownBase is ICooldown, AccessControlled {
    /// @dev Maximum active requests per `(vault, account)`. Requests
    ///      beyond this count are merged into the last entry to
    ///      bound `finalize` and `balanceOf` gas costs.
    uint256 internal constant MAX_ACTIVE_REQUEST_SLOTS = 70;

    /// @dev Maximum active requests when `initialFrom != to`
    ///      (request created on behalf of another address). Reached
    ///      via revert, not merge — anti-spam protection for the
    ///      external receiver.
    uint256 internal constant PUBLIC_REQUEST_SLOTS_CAP = 40;

    function initialize(address owner_, address acm_) public virtual initializer {
        AccessControlled_init(owner_, acm_);
    }
}
```

---

### 3. `core/cooldown/SharesCooldown.sol`

Full source:

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ITranche } from "../../interfaces/ITranche.sol";
import { ICooldown } from "../../interfaces/cooldown/ICooldown.sol";
import { ISharesCooldown } from "../../interfaces/cooldown/ISharesCooldown.sol";
import { CooldownBase } from "./CooldownBase.sol";

/// @title  SharesCooldown
/// @notice Silo that holds tranche vault shares during the
///         coverage-driven cooldown period.
contract SharesCooldown is ISharesCooldown, CooldownBase {
    uint256 private constant PERCENTAGE_100 = 1e18;
    uint256 private constant MAX_FEE_PER_DAY = 0.01e18;    // 1%/day cap
    uint256 private constant SECONDS_PER_DAY = 1 days;

    mapping(address vault => mapping(address account => TRequest[]))
        private _activeRequests;

    mapping(address vault => uint256) public override vaultEarlyExitFeePerDay;
    mapping(address vault => TExitUpperBounds) private _vaultExitBounds;

    modifier onlyUser(address user) {
        if (msg.sender != user) revert OnlySharesOwner(msg.sender, user);
        _;
    }

    // ---------------------------------------------------------------
    // Worker entrypoint
    // ---------------------------------------------------------------

    function requestRedeem(
        ITranche vault,
        address token,
        address initialFrom,
        address to,
        uint256 shares,
        uint256 fee,
        uint32  cooldownSeconds
    ) external onlyRole(COOLDOWN_WORKER_ROLE) {
        if (shares == 0) return;

        if (fee > 0) {
            (uint256 sharesUser, ) = _accrueFee(vault, shares, fee);
            shares = sharesUser;
        }

        if (cooldownSeconds == 0) {
            // No lock — finalise immediately.
            vault.redeem(token, shares, to, address(this));
            emit Finalized(IERC20(address(vault)), to, shares);
            return;
        }

        TRequest[] storage requests = _activeRequests[address(vault)][to];
        uint256 requestsCount = requests.length;

        if (initialFrom != to && requestsCount >= PUBLIC_REQUEST_SLOTS_CAP) {
            revert ExternalReceiverRequestLimitReached(
                IERC20(address(vault)), initialFrom, to, shares
            );
        }

        uint64 unlockAt = uint64(block.timestamp + cooldownSeconds);

        if (requestsCount < MAX_ACTIVE_REQUEST_SLOTS) {
            if (
                requestsCount > 0 &&
                requests[requestsCount - 1].unlockAt == unlockAt
            ) {
                // Same-block request — merge with the last entry.
                TRequest storage last = requests[requestsCount - 1];
                last.token = token;
                last.shares += uint192(shares);
            } else {
                requests.push(TRequest(unlockAt, uint192(shares), token));
            }
        } else {
            // Slot cap reached — merge into last and extend unlock.
            TRequest storage last = requests[requestsCount - 1];
            last.token = token;
            last.shares += uint192(shares);
            if (last.unlockAt < unlockAt) {
                last.unlockAt = unlockAt;
            }
        }

        emit RequestedCooldown(address(vault), token, initialFrom, to, shares, unlockAt);
    }

    // ---------------------------------------------------------------
    // User-facing
    // ---------------------------------------------------------------

    function finalize(IERC20 vault, address user) external returns (uint256 claimed) {
        return _finalizePublic(ITranche(address(vault)), address(0), user, block.timestamp);
    }

    function finalize(IERC20 vault, address user, uint256 at) external returns (uint256 claimed) {
        return _finalizePublic(ITranche(address(vault)), address(0), user, at);
    }

    function finalize(ITranche vault, address token, address user) external returns (uint256 claimed) {
        return _finalizePublic(vault, token, user, block.timestamp);
    }

    function finalize(ITranche vault, address token, address user, uint256 at)
        external returns (uint256 claimed)
    {
        return _finalizePublic(vault, token, user, at);
    }

    function finalizeWithTokenOverride(IERC20 vault, address token, address user)
        external onlyUser(user) returns (uint256 claimed)
    {
        claimed = _finalizeAll(address(vault), user, token, block.timestamp);
        emit Finalized(vault, user, claimed);
    }

    function finalizeWithFee(
        ITranche vault,
        address token,
        address user,
        uint256 i,
        TFinalizeWithFeeGuard calldata guard
    ) external onlyUser(user) returns (uint256 claimed) {
        TRequest[] storage requests = _activeRequests[address(vault)][user];
        uint256 len = requests.length;
        if (i >= len) revert OutOfRange(i, len);

        TRequest memory req = requests[i];
        if (req.unlockAt <= block.timestamp) revert RequestReady(req.unlockAt, block.timestamp);
        if (guard.shares != 0 && guard.shares != req.shares) {
            revert UnexpectedShares(req.shares, guard.shares);
        }

        // Swap-pop the entry.
        if (i < len - 1) requests[i] = requests[len - 1];
        requests.pop();

        uint256 shares = req.shares;
        uint256 daysLeft = (req.unlockAt - block.timestamp) / SECONDS_PER_DAY + 1;
        uint256 feePerDay = vaultEarlyExitFeePerDay[address(vault)];

        if (guard.daysLeft != 0 && guard.daysLeft != daysLeft) {
            revert UnexpectedDays(daysLeft, guard.daysLeft);
        }

        (uint256 sharesUser, uint256 sharesFee) = _accrueFee(vault, shares, feePerDay * daysLeft);

        address tokenToRedeem = token != address(0) ? token : req.token;
        vault.redeem(tokenToRedeem, sharesUser, user, address(this));

        emit ExitFeeAccrued(address(vault), user, sharesFee, sharesUser);
        return sharesUser;
    }

    function cancel(
        IERC20 vault,
        address user,
        uint256 i,
        TCancelGuard calldata guard
    ) external onlyUser(user) {
        TRequest[] storage requests = _activeRequests[address(vault)][user];
        uint256 len = requests.length;
        if (i >= len) revert OutOfRange(i, len);

        TRequest memory req = requests[i];
        if (guard.shares != 0 && guard.shares != req.shares) {
            revert UnexpectedShares(req.shares, guard.shares);
        }

        if (i < len - 1) requests[i] = requests[len - 1];
        requests.pop();

        // Return shares to the recipient (no fee on cancel).
        IERC20(address(vault)).transfer(user, req.shares);
        emit RequestCanceled(address(vault), user, req.shares);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setVaultExitBounds(address vault, TExitUpperBounds calldata bounds)
        external onlyOwner
    {
        if (bounds.p0 > bounds.p1) revert InvalidBounds(bounds.p0, bounds.p1);
        _vaultExitBounds[vault] = bounds;
        emit VaultCooldownBoundsUpdated(vault, bounds);
    }

    function setVaultEarlyExitFee(address vault, uint256 fee) external onlyOwner {
        if (fee > MAX_FEE_PER_DAY) revert InvalidFee(fee);
        vaultEarlyExitFeePerDay[vault] = fee;
        emit VaultEarlyExitFeeSet(vault, fee);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function calculateExitParams(address vault, uint256 coverage_)
        public view returns (TExitParams memory)
    {
        TExitUpperBounds memory bounds = _vaultExitBounds[vault];
        if (coverage_ <= bounds.p0) return bounds.r0;
        if (coverage_ <= bounds.p1) return bounds.r1;
        return bounds.r2;
    }

    function vaultExitBounds(address vault) external view returns (TExitUpperBounds memory) {
        return _vaultExitBounds[vault];
    }

    function activeRequests(address vault, address account, uint256 i)
        external view returns (TRequest memory)
    {
        return _activeRequests[vault][account][i];
    }

    function activeRequestsLength(address vault, address account)
        external view returns (uint256)
    {
        return _activeRequests[vault][account].length;
    }

    function balanceOf(IERC20 vault, address user)
        external view returns (ICooldown.TBalanceState memory)
    {
        return _balanceOf(vault, user, block.timestamp);
    }

    function balanceOf(IERC20 vault, address user, uint256 at)
        external view returns (ICooldown.TBalanceState memory)
    {
        return _balanceOf(vault, user, at);
    }

    // ---------------------------------------------------------------
    // Internal — finalisation
    // ---------------------------------------------------------------

    function _finalizePublic(
        ITranche vault,
        address token,
        address user,
        uint256 at
    ) internal returns (uint256 claimed) {
        if (token == address(0)) {
            claimed = _finalizeAll(address(vault), user, address(0), at);
        } else {
            (claimed, ) = _processFinalization(address(vault), user, token, address(0), at);
        }
        if (claimed == 0) revert NothingToFinalize();
        emit Finalized(IERC20(address(vault)), user, claimed);
    }

    function _finalizeAll(
        address vault,
        address user,
        address overrideToken,
        uint256 at
    ) internal returns (uint256 claimed) {
        if (overrideToken != address(0)) {
            (claimed, ) = _processFinalization(vault, user, address(0), overrideToken, at);
            return claimed;
        }
        address finalizeToken = ITranche(vault).asset();
        while (true) {
            (uint256 singleClaimed, address nextToken) =
                _processFinalization(vault, user, finalizeToken, overrideToken, at);
            claimed += singleClaimed;
            if (nextToken == address(0)) break;
            finalizeToken = nextToken;
        }
    }

    function _processFinalization(
        address vault,
        address user,
        address token,
        address overrideToken,
        uint256 at
    ) internal returns (uint256 claimed, address nextToken) {
        if (at > block.timestamp) revert InvalidTime();
        // either `token` filters per-request, or `overrideToken` is
        // the redemption asset for matched requests
        if (token == address(0) && overrideToken == address(0)) revert UnsupportedToken(address(0));

        TRequest[] storage requests = _activeRequests[vault][user];
        bool isCooldownActive = _isCooldownActive(vault);

        uint256 len = requests.length;
        for (uint256 i; i < len;) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > at) {
                // still pending
                unchecked { i++; }
                continue;
            }
            if (token != address(0) && token != req.token) {
                if (nextToken == address(0)) nextToken = req.token;
                unchecked { i++; }
                continue;
            }

            claimed += req.shares;

            // Swap-pop.
            if (i < len - 1) requests[i] = requests[len - 1];
            requests.pop();
            unchecked { len--; }
        }

        if (claimed > 0) {
            address tokenToRedeem = overrideToken != address(0) ? overrideToken : token;
            ITranche(vault).redeem(tokenToRedeem, claimed, user, address(this));
        }
    }

    function _balanceOf(IERC20 vault, address user, uint256 at)
        internal view returns (ICooldown.TBalanceState memory)
    {
        TRequest[] storage requests = _activeRequests[address(vault)][user];
        bool isCooldownActive = _isCooldownActive(address(vault));

        uint256 len = requests.length;
        uint256 pending;
        uint256 claimable;
        uint256 nextUnlockAt;
        uint256 nextUnlockAmount;

        for (uint256 i; i < len; i++) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > at) {
                pending += req.shares;
                if (nextUnlockAt == 0 || req.unlockAt < nextUnlockAt) {
                    nextUnlockAt = req.unlockAt;
                    nextUnlockAmount = req.shares;
                    continue;
                }
                if (req.unlockAt == nextUnlockAt) {
                    nextUnlockAmount += req.shares;
                }
                continue;
            }
            claimable += req.shares;
        }

        return ICooldown.TBalanceState({
            pending: pending,
            claimable: claimable,
            nextUnlockAt: nextUnlockAt,
            nextUnlockAmount: nextUnlockAmount,
            totalRequests: len
        });
    }

    // ---------------------------------------------------------------
    // Internal — fee / helpers
    // ---------------------------------------------------------------

    function _accrueFee(ITranche vault, uint256 shares, uint256 feeBps)
        internal returns (uint256 sharesUser, uint256 sharesFee)
    {
        sharesFee = Math.mulDiv(shares, feeBps, PERCENTAGE_100, Math.Rounding.Floor);
        sharesUser = shares > sharesFee ? shares - sharesFee : 0;
        if (sharesUser == 0 || sharesFee == 0) revert EmptyFee();
        vault.burnSharesAsFee(sharesFee, address(this));
    }

    function _isCooldownActive(address vault) internal view returns (bool) {
        TExitUpperBounds memory bounds = _vaultExitBounds[vault];
        return bounds.p1 > 0 || bounds.r2.sharesLock > 0;
    }
}
```

---

## Notes

### Why `vault.redeem(token, shares, receiver, owner)`?

`ITranche.redeem` in the Atrium codebase takes an explicit `token`
parameter (the output asset, which may not be the base) and an
explicit `owner` (here `address(this)` — the silo holds the shares).
When the silo calls `vault.redeem(...)` with `owner == sharesCooldown`,
PrimeCDO's `calculateExitMode(...)` recognises the caller and short-
circuits to ERC4626 mode — no fee, no cooldown — so finalisation
completes in one transaction.

### Why three ranges instead of a flexible array?

Per Q1: the upstream pattern packs `(p0, p1, r0, r1, r2)` into a
storage layout sized for fixed slots. With our `uint256` encoding
the pack collapses (8 slots instead of 1), but the `O(1)` lookup is
still a win — no loop, no dynamic-array gas tax. If a fourth range
becomes necessary, this contract is replaced rather than extended.

### Cooldown "disabled" sentinel

A vault with `bounds.p1 == 0` and `bounds.r2.sharesLock == 0`
deliberately reads as "cooldown not configured". `_isCooldownActive`
returns false and `finalize` skips the `req.unlockAt > at` check
entirely, allowing immediate finalisation of any historically-locked
requests. This is the escape hatch for emergency unlock or for
vaults that are run without coverage cooldowns at all.

### Why `cancel` has no fee

Per Q6. Two reasons:

- `cancel` returns shares without redeeming through the vault. The
  user is taking back exactly what they put in — there's no exit
  event for which to charge.
- The early-exit fee path is `finalizeWithFee`. Cancel exists for
  the user who changed their mind, not for the user trying to
  shortcut the lock.

If anti-griefing turns out to require a cancel cost in practice
(e.g. users cancelling immediately to grief the gas of `finalize`
loop), that's a future tweak.

### Slot caps recap

`MAX_ACTIVE_REQUEST_SLOTS = 70`: when reached, new requests merge
into the last entry. The merged entry's `unlockAt` is the max of
the existing and the new, the `shares` sum, the `token` is
overwritten with the latest intent. This bounds gas for `finalize`
and `balanceOf` loops.

`PUBLIC_REQUEST_SLOTS_CAP = 40`: when `initialFrom != to` and the
recipient already has 40 active requests, the call reverts. This
prevents griefing where a third party piles up requests on a
recipient's queue and forces them to pay gas to drain it.

### Coverage flow end-to-end

1. User calls `Tranche.withdraw(token, shares, receiver, owner)`.
2. Tranche routes to `CDO.cooldownShares(...)` (spec 12).
3. CDO computes `cdo.coverage()` (already in 1e18).
4. CDO computes exit params:
   `cdo.calculateExitMode(tranche, owner)` →
   `sharesCooldown.calculateExitParams(tranche, coverage)`.
5. CDO calls `sharesCooldown.requestRedeem(...)` with the chosen
   fee + lock.
6. Tranche transfers the shares to the silo (via the redeem flow).
7. After lock expires, user calls
   `sharesCooldown.finalize(tranche, token, user)` and the silo
   redeems through the tranche on behalf of the user.

Steps 1, 2, 6, and the CDO surface around step 4–5 are not
covered here — they are spec 12.

---

## Non-Goals

- PrimeCDO integration (`cooldownShares`, `calculateExitMode`,
  fee retention) — spec 12.
- `Tranche.burnSharesAsFee` body — already exists in the foundation.
- An ERC20 silo for non-share assets — separate spec 10''.
- Multi-recipient batched finalise (`finalizeMany`) — out of scope.
- Off-chain indexer support beyond the events already declared.
- Migration story for already-locked shares if `sharesCooldown` is
  re-deployed — currently a clean redeploy + admin re-config.

---

## Acceptance Criteria

- `ICooldown` (from spec 10) is reused without modification.
- `ISharesCooldown` matches §1.
- `CooldownBase` matches §2, declares the two slot-cap constants
  and the `initialize(owner, acm)` hook.
- `SharesCooldown` compiles under solc 0.8.35 with `pnpm build`
  clean.
- `requestRedeem` is `onlyRole(COOLDOWN_WORKER_ROLE)`.
- `setVaultExitBounds`, `setVaultEarlyExitFee` are `onlyOwner`.
- `cancel`, `finalizeWithFee`, `finalizeWithTokenOverride` are
  recipient-gated via `onlyUser`.
- `finalize` (all four overloads) is permissionless.
- Slot caps enforced: 70 total (merge on overflow), 40 for
  external receiver (revert on overflow).
- Early-exit per-day fee capped at `0.01e18` (1%).
- `calculateExitParams` returns the right range:
  - `cov ≤ p0` → r0
  - `p0 < cov ≤ p1` → r1
  - `cov > p1` → r2
- `_isCooldownActive(vault)` returns false when `p1 == 0` and
  `r2.sharesLock == 0` — the disabled sentinel.
- `_accrueFee` reverts `EmptyFee` when either `sharesUser == 0` or
  `sharesFee == 0` (degenerate inputs).
- All reverts use custom errors. No string reverts.
- `setVaultExitBounds` rejects `p0 > p1` with `InvalidBounds`.
- Events `RequestedCooldown`, `Finalized`, `RequestCanceled`,
  `ExitFeeAccrued`, `VaultCooldownBoundsUpdated`,
  `VaultEarlyExitFeeSet` fire on their respective state changes.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move spec 11 to Completed with files: `SharesCooldown.sol`,
    `CooldownBase.sol`, `ISharesCooldown.sol`.
  - Architecture decisions:
    - Three-range coverage table per vault.
    - `uint256` 1e18 coverage encoding throughout.
    - `requestRedeem` gated `COOLDOWN_WORKER_ROLE` (PrimeCDO holds).
    - Cancel returns shares without fee; early exit pays
      proportional fee via `finalizeWithFee`.
    - Slot caps 70 / 40 (Atrium adopts the upstream values).
  - Open Questions:
    - Whether `cancel` should accrue a small protocol fee in
      practice (currently free).
    - Whether `finalize` overload set needs a `finalizeMany`
      convenience.
    - Concrete coverage threshold values per tranche (`p0`, `p1`)
      and per-day fee — set by deploy script / governance, not in
      this spec.
    - PrimeCDO `cooldownShares` body and the
      `calculateExitMode → requestRedeem` glue — spec 12.
- Spec 12 (PrimeCDO withdraw body) unblocked.
- Spec 15 (deployment) gains another wire-up step.
