// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "../ITranche.sol";
import { ICooldown } from "./ICooldown.sol";

/**
 * @title  ISharesCooldown
 * @notice Silo for tranche vault shares during coverage-driven
 *         cooldown periods. Tracks per-recipient redeem requests,
 *         finalises them through the originating vault, and applies
 *         optional early-exit fees.
 */
interface ISharesCooldown is ICooldown {
    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    /**
     * @notice One queued redeem request.
     * @param  unlockAt The earliest `block.timestamp` at which this
     *                  request can be finalised without paying the
     *                  early-exit fee.
     * @param  shares   The amount of vault shares locked in the silo
     *                  for this request.
     * @param  token    The output asset the user expects on
     *                  finalisation (set at request time; may be
     *                  overridden via `finalizeWithTokenOverride` or
     *                  the `token` argument of `finalize`).
     */
    struct TRequest {
        uint64 unlockAt;
        uint192 shares;
        address token;
    }

    /**
     * @notice Exit parameters returned by {calculateExitParams}.
     * @dev    18-decimal fee, seconds for the lock.
     */
    struct TExitParams {
        uint256 feeBps; // 1e18 = 100%, capped at PERCENTAGE_100
        uint32 sharesLock; // seconds
    }

    /**
     * @notice Per-vault coverage bounds and the three exit-range
     *         parameter triples.
     * @dev    Three ranges:
     *           - `coverage <= p0`   -> r0 (typically longest lock /
     *                                  highest fee)
     *           - `p0 < coverage <= p1` -> r1
     *           - `coverage > p1`    -> r2 (typically zero)
     *         `p0 <= p1` invariant enforced by {setVaultExitBounds}.
     */
    struct TExitUpperBounds {
        uint256 p0;
        uint256 p1;
        TExitParams r0;
        TExitParams r1;
        TExitParams r2;
    }

    /**
     * @notice Guard struct for {finalizeWithFee}. Caller may zero
     *         out fields they don't want checked.
     */
    struct TFinalizeWithFeeGuard {
        uint192 shares;
        uint256 daysLeft;
    }

    /** @notice Guard struct for {cancel}. */
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
    event ExitFeeAccrued(address indexed vault, address user, uint256 sharesFee, uint256 sharesUser);

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

    /**
     * @notice Finalise claimable requests for `user` on `vault`,
     *         optionally filtered to a single `token`. Permissionless
     *         (anyone may finalise on behalf of any user).
     */
    function finalize(ITranche vault, address token, address user) external returns (uint256 claimed);

    /**
     * @notice Same as {finalize} but evaluates claimability at the
     *         supplied timestamp (for view-style finalisation; the
     *         on-chain enforcement still requires
     *         `at <= block.timestamp`).
     */
    function finalize(ITranche vault, address token, address user, uint256 at) external returns (uint256 claimed);

    /**
     * @notice Finalise all claimable requests for `user` using
     *         `token` regardless of each request's recorded token.
     *         Restricted to the recipient (`user == msg.sender`).
     */
    function finalizeWithTokenOverride(IERC20 vault, address token, address user) external returns (uint256 claimed);

    /**
     * @notice Early-finalise a single not-yet-unlocked request by
     *         paying a fee proportional to days remaining.
     *         Restricted to the recipient.
     * @param  vault The tranche vault whose request is being exited.
     * @param  token Output token override; `address(0)` keeps the
     *               request's recorded token.
     * @param  user  The recipient (must equal `msg.sender`).
     * @param  i     Index of the request in the user's active queue.
     * @param  guard Optional guard rails on shares and days-left.
     */
    function finalizeWithFee(
        ITranche vault,
        address token,
        address user,
        uint256 i,
        TFinalizeWithFeeGuard calldata guard
    ) external returns (uint256 claimed);

    /**
     * @notice Cancel an active request and return the shares to the
     *         recipient. Restricted to the recipient. No fee.
     * @dev    Allowed at any time, including after the lock has
     *         expired but before {finalize}.
     */
    function cancel(IERC20 vault, address user, uint256 i, TCancelGuard calldata guard) external;

    // ---------------------------------------------------------------
    // Worker entrypoints (CDO)
    // ---------------------------------------------------------------

    /**
     * @notice Lock `shares` of `vault` from `initialFrom` for `to`,
     *         recording a lockup that expires after `cooldownSeconds`.
     * @dev    Caller must hold `COOLDOWN_WORKER_ROLE` (PrimeCDO).
     *         If `fee > 0`, a portion of the shares is burned as
     *         entry fee via `vault.burnSharesAsFee(...)` before the
     *         rest is locked. When `cooldownSeconds == 0`, the
     *         function instead redeems immediately through the
     *         vault and emits `Finalized`.
     * @param  vault            The originating tranche vault.
     * @param  token            Output token recorded for finalisation.
     * @param  initialFrom      The account whose redemption this is
     *                          (caller-provided; informational for
     *                          slot-cap accounting).
     * @param  to               The recipient who can finalise/cancel.
     * @param  shares           Vault shares to lock (or redeem if no
     *                          cooldown).
     * @param  fee              Entry fee in 1e18 precision (`0.005e18`
     *                          = 0.5%). Burned from `shares` via the
     *                          tranche before lockup.
     * @param  cooldownSeconds  Lock duration. `0` triggers immediate
     *                          finalisation.
     */
    function requestRedeem(
        ITranche vault,
        address token,
        address initialFrom,
        address to,
        uint256 shares,
        uint256 fee,
        uint32 cooldownSeconds
    ) external;

    // ---------------------------------------------------------------
    // Admin entrypoints
    // ---------------------------------------------------------------

    /**
     * @notice Set the three coverage ranges for `vault`.
     * @dev    Owner-gated. Requires `bounds.p0 <= bounds.p1`.
     *         Passing `bounds.r2.sharesLock = 0 && bounds.p1 == 0`
     *         is the canonical "cooldown disabled" configuration
     *         (`finalize` returns immediately for all locked shares).
     */
    function setVaultExitBounds(address vault, TExitUpperBounds calldata bounds) external;

    /**
     * @notice Set the per-day early-exit fee rate for `vault`.
     * @dev    Owner-gated. Capped at `0.01e18` (1%/day). Setting to
     *         zero disables {finalizeWithFee}.
     */
    function setVaultEarlyExitFee(address vault, uint256 fee) external;

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /**
     * @notice Returns the exit parameters that apply to `vault` at
     *         the supplied coverage level.
     * @dev    `coverage` is in 1e18 precision (matches
     *         `PrimeCDO.coverage()`). Selection rule:
     *           - `coverage <= p0`    -> `r0`
     *           - `p0 < coverage <= p1` -> `r1`
     *           - otherwise          -> `r2`
     */
    function calculateExitParams(address vault, uint256 coverage) external view returns (TExitParams memory);

    /** @notice Returns the configured bounds for `vault`. */
    function vaultExitBounds(address vault) external view returns (TExitUpperBounds memory);

    /** @notice Returns the configured early-exit per-day fee for `vault`. */
    function vaultEarlyExitFeePerDay(address vault) external view returns (uint256);

    /** @notice Returns the i-th active request for `(vault, account)`. */
    function activeRequests(address vault, address account, uint256 i) external view returns (TRequest memory);

    /**
     * @notice Returns the number of active requests for
     *         `(vault, account)`.
     */
    function activeRequestsLength(address vault, address account) external view returns (uint256);
}
