// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ITranche } from "./ITranche.sol";
import { IStrategy } from "./IStrategy.sol";
import { TrancheKind } from "./IAccounting.sol";

/**
 * @notice Routing classification for tranche withdrawals.
 *         `Dynamic` is appended last so the integer encoding of the
 *         first three modes stays stable; `calculateExitMode` never
 *         returns it — it's a caller-side sentinel used in
 *         {ITranche.TRedemptionParams} to opt out of mode-slippage
 *         validation.
 */
enum TExitMode {
    ERC4626,
    SharesLock,
    Fee,
    Dynamic
}

/**
 * @title  ICDO
 * @notice Primary entry point for tranche coordination, accounting,
 *         deposits, and withdrawals.
 */
interface ICDO {
    function jrVault() external view returns (ITranche);
    function mezzVault() external view returns (ITranche);
    function srVault() external view returns (ITranche);
    function strategy() external view returns (IStrategy);

    /**
     * @notice Wired SharesCooldown silo. `address(0)` when no silo
     *         is configured.
     */
    function sharesCooldown() external view returns (address);

    /**
     * @notice Owner-only setter. Pass `address(0)` to disable
     *         silo-aware coverage.
     */
    function setSharesCooldown(address sharesCooldown_) external;

    function totalAssets(address tranche) external view returns (uint256);

    /**
     * @notice Tranche kind. Reverts `InvalidTranche` on unwired
     *         addresses.
     */
    function kindOf(address tranche) external view returns (TrancheKind);

    // @notice TVL per tranche excluding shares parked in the silo.
    function totalAssetsUnlocked() external view returns (uint256 jr, uint256 mz, uint256 sr);

    /**
     * @notice Coverage = `(jrU + mzU + srU) / srU` in 1e18 precision.
     *         Returns `type(uint256).max` when unlocked Senior is 0.
     */
    function coverage() external view returns (uint256);

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
     * @notice Classify the exit path for `owner` against `tranche`.
     *         Silo-as-owner short-circuits to `ERC4626`.
     */
    function calculateExitMode(address tranche, address owner)
        external view
        returns (TExitMode mode, uint256 fee, uint32 cooldownSeconds);

    /**
     * @notice Forward a SharesCooldown lockup request. Tranche moves
     *         shares into the silo BEFORE calling.
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

    function accrueFee(address tranche, uint256 assets) external;

    function updateBalanceFlow() external;

    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external;

    // @notice Owner-only setter for per-tranche fallback exit fees.
    function setExitFees(uint256 jr, uint256 mz, uint256 sr) external;

    function exitFeeJr() external view returns (uint256);
    function exitFeeMz() external view returns (uint256);
    function exitFeeSr() external view returns (uint256);

    /**
     * @notice Drain `amount` of `token` from reserve to treasury.
     *         Gated by `RESERVE_MANAGER_ROLE`.
     */
    function reduceReserve(address token, uint256 amount) external;

    // @notice Owner-only setter for the reserve treasury wallet.
    function setReserveTreasury(address treasury_) external;

    function treasury() external view returns (address);

    function maxWithdraw(address tranche) external view returns (uint256);
    function maxWithdraw(address tranche, address owner) external view returns (uint256);
    function maxDeposit(address tranche) external view returns (uint256);
}
