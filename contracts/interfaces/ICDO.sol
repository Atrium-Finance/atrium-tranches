// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ITranche } from "./ITranche.sol";
import { IStrategy } from "./IStrategy.sol";
import { TrancheKind } from "./IAccounting.sol";

/**
 * @notice Routing classification for tranche withdrawals.
 * @dev    `Dynamic` is appended last so the on-chain integer encoding
 *         of the first three modes stays stable. `cdo.calculateExitMode(...)`
 *         never returns `Dynamic` — the sentinel is purely a caller-side
 *         flag (used in {ITranche.TRedemptionParams} to opt out of
 *         mode-slippage validation).
 */
enum TExitMode {
    ERC4626,
    SharesLock,
    Fee,
    Dynamic
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

    /**
     * @notice Address of the wired SharesCooldown silo. `address(0)`
     *         when no silo is configured.
     */
    function sharesCooldown() external view returns (address);

    /**
     * @notice Owner-only setter for the SharesCooldown silo address.
     * @dev    Pass `address(0)` to disable silo-aware coverage.
     */
    function setSharesCooldown(address sharesCooldown_) external;

    function totalAssets(address tranche) external view returns (uint256);

    /**
     * @notice Returns the kind classification of a wired tranche.
     * @dev    Reverts with `InvalidTranche(tranche)` when the address
     *         is not one of the three wired vaults.
     */
    function kindOf(address tranche) external view returns (TrancheKind);

    /**
     * @notice TVL per tranche excluding shares parked in the
     *         SharesCooldown silo. Falls back to raw TVL when no
     *         silo is wired.
     */
    function totalAssetsUnlocked() external view returns (uint256 jr, uint256 mz, uint256 sr);

    /**
     * @notice Current protocol coverage ratio:
     *         `(jrUnlocked + mzUnlocked + srUnlocked) / srUnlocked`,
     *         encoded in 1e18 precision. Returns `type(uint256).max`
     *         when unlocked Senior TVL is zero.
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

    /**
     * @notice Reduce the protocol reserve by `amount` of `token`, sending
     *         the tokens to the configured treasury wallet.
     * @dev    Gated by `RESERVE_MANAGER_ROLE`. Decrements Accounting's
     *         reserve bucket then asks Strategy to physically transfer.
     */
    function reduceReserve(address token, uint256 amount) external;

    /**
     * @notice Owner-only setter for the reserve treasury wallet.
     */
    function setReserveTreasury(address treasury_) external;

    /** @notice Recipient wallet for reserve outflows. */
    function treasury() external view returns (address);

    function maxWithdraw(address tranche) external view returns (uint256);

    function maxWithdraw(address tranche, address owner) external view returns (uint256);

    function maxDeposit(address tranche) external view returns (uint256);
}
