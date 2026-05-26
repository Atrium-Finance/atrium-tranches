// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ITranche } from "./ITranche.sol";
import { IStrategy } from "./IStrategy.sol";

/**
 * @notice Routing classification for tranche withdrawals.
 */
enum TExitMode {
    ERC4626,
    SharesLock,
    Fee
}

/**
 * @title ICDO
 * @notice Primary entry point for tranche coordination, accounting, deposits, and withdrawals.
 */
interface ICDO {
    function jrVault() external view returns (ITranche);

    function mezzVault() external view returns (ITranche);

    function srVault() external view returns (ITranche);

    function strategy() external view returns (IStrategy);

    function totalAssets(address tranche) external view returns (uint256);

    function updateAccounting() external;

    function deposit(address tranche, address token, uint256 tokenAmount, uint256 baseAssets) external;

    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner,
        address receiver
    ) external;

    /**
     * @notice Classify the exit path for a withdrawal initiated by `owner`
     *         against `tranche`.
     * @dev    Silo-as-owner short-circuits to `ERC4626` so finalisation
     *         doesn't re-lock. View; never reverts.
     */
    function calculateExitMode(address tranche, address owner)
        external view
        returns (TExitMode mode, uint256 fee, uint32 cooldownSeconds);

    /**
     * @notice Forward a SharesCooldown lockup request from a tranche.
     * @dev    Tranche moves the shares into the silo BEFORE calling.
     */
    function cooldownShares(
        address tranche,
        address token,
        uint256 shares,
        address sender,
        address receiver,
        uint256 fee,
        uint32  cooldownSeconds
    ) external;

    /**
     * @notice Forward a tranche fee accrual into Accounting.
     */
    function accrueFee(address tranche, uint256 assets) external;

    /**
     * @notice NAV-only accounting refresh (no balance deltas).
     */
    function updateBalanceFlow() external;

    /**
     * @notice Record explicit balance deltas across the three tranches.
     */
    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external;

    /**
     * @notice Owner-only setter for the per-tranche fallback exit fees.
     */
    function setExitFees(uint256 jr, uint256 mz, uint256 sr) external;

    function exitFeeJr() external view returns (uint256);
    function exitFeeMz() external view returns (uint256);
    function exitFeeSr() external view returns (uint256);

    function maxWithdraw(address tranche) external view returns (uint256);

    function maxWithdraw(address tranche, address owner) external view returns (uint256);

    function maxDeposit(address tranche) external view returns (uint256);
}
