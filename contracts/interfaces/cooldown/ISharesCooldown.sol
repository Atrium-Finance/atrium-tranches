// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "../ITranche.sol";
import { ICooldown } from "./ICooldown.sol";

/**
 * @title  ISharesCooldown
 * @notice Silo for tranche shares during coverage-driven cooldown.
 *         Tracks per-recipient redeem requests, finalises through the
 *         originating vault, and applies optional early-exit fees.
 */
interface ISharesCooldown is ICooldown {
    /**
     * @notice One queued redeem request.
     * @param  unlockAt Earliest `block.timestamp` for fee-free finalise.
     * @param  shares   Vault shares locked in the silo.
     * @param  token    Output asset expected on finalisation.
     */
    struct TRequest {
        uint64 unlockAt;
        uint192 shares;
        address token;
    }

    // @notice Exit parameters: `feeBps` in 1e18, `sharesLock` in seconds.
    struct TExitParams {
        uint256 feeBps;
        uint32 sharesLock;
    }

    /**
     * @notice Per-vault coverage bounds and three exit-range triples.
     *         Selection by `coverage`:
     *           `<= p0` → r0,  `(p0, p1]` → r1,  `> p1` → r2.
     *         Invariant `p0 <= p1` enforced by {setVaultExitBounds}.
     */
    struct TExitUpperBounds {
        uint256 p0;
        uint256 p1;
        TExitParams r0;
        TExitParams r1;
        TExitParams r2;
    }

    // @notice Guard for {finalizeWithFee}. Zero fields skip the check.
    struct TFinalizeWithFeeGuard {
        uint192 shares;
        uint256 daysLeft;
    }

    // @notice Guard for {cancel}.
    struct TCancelGuard {
        uint192 shares;
    }

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

    error OnlySharesOwner(address caller, address expectedOwner);
    error OutOfRange(uint256 index, uint256 length);
    error RequestReady(uint256 unlockAt, uint256 nowTs);
    error UnexpectedShares(uint192 actual, uint192 guard);
    error UnexpectedDays(uint256 actual, uint256 guard);
    error EmptyFee();
    error InvalidFee(uint256 fee);
    error InvalidBounds(uint256 p0, uint256 p1);
    error MaxRedemptionLimitReached();

    /**
     * @notice Finalise claimable requests for `user` on `vault`,
     *         optionally filtered to a single `token`. Permissionless.
     */
    function finalize(ITranche vault, address token, address user) external returns (uint256 claimed);

    // @notice Same as {finalize} but evaluated at `at`.
    function finalize(ITranche vault, address token, address user, uint256 at) external returns (uint256 claimed);

    /**
     * @notice Finalise all claimable requests for `user` using `token`
     *         regardless of each request's recorded token. Recipient-
     *         only (`user == msg.sender`).
     */
    function finalizeWithTokenOverride(IERC20 vault, address token, address user) external returns (uint256 claimed);

    /**
     * @notice Early-finalise a not-yet-unlocked request by paying a
     *         fee proportional to days remaining. Recipient-only.
     */
    function finalizeWithFee(
        ITranche vault,
        address token,
        address user,
        uint256 i,
        TFinalizeWithFeeGuard calldata guard
    ) external returns (uint256 claimed);

    /**
     * @notice Cancel an active request and return shares to the
     *         recipient. Recipient-only. No fee.
     */
    function cancel(IERC20 vault, address user, uint256 i, TCancelGuard calldata guard) external;

    /**
     * @notice Lock `shares` of `vault` from `initialFrom` for `to`,
     *         expiring after `cooldownSeconds`. Caller holds
     *         `COOLDOWN_WORKER_ROLE`. `fee > 0` burns part of `shares`
     *         as entry fee via `vault.burnSharesAsFee` before lockup.
     *         `cooldownSeconds == 0` redeems immediately.
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

    /**
     * @notice Owner-only setter for the three coverage ranges of
     *         `vault`. Requires `p0 <= p1`.
     */
    function setVaultExitBounds(address vault, TExitUpperBounds calldata bounds) external;

    /**
     * @notice Owner-only setter for the per-day early-exit fee rate
     *         of `vault`. Capped at `0.01e18` (1%/day).
     */
    function setVaultEarlyExitFee(address vault, uint256 fee) external;

    /**
     * @notice Exit parameters that apply to `vault` at the supplied
     *         coverage level (1e18 precision).
     */
    function calculateExitParams(address vault, uint256 coverage) external view returns (TExitParams memory);

    function vaultExitBounds(address vault) external view returns (TExitUpperBounds memory);
    function vaultEarlyExitFeePerDay(address vault) external view returns (uint256);
    function activeRequests(address vault, address account, uint256 i) external view returns (TRequest memory);
    function activeRequestsLength(address vault, address account) external view returns (uint256);
}
