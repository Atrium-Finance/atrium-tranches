// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IAccounting
//  TVL tracking, gain splitting, and loss waterfall interface
//  See: docs/PV_V3_FINAL_v34.md section 17
// ══════════════════════════════════════════════════════════════════════

import {TrancheId} from "./IPrimeCDO.sol";

/**
 * @title IAccounting
 * @notice Interface for the Accounting contract
 * @dev Tracks per-tranche TVL (Senior, Mezzanine, Junior).
 *      Splits gains: Senior gets target APR, Mezz gets MAX(floor, subPoolAPY*(1-RP2)), Junior gets residual.
 *      Loss waterfall: Junior → Mezzanine → Senior.
 *      See MATH_REFERENCE §E5 for gain splitting and §E9 for loss waterfall.
 */
interface IAccounting {
    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Update all TVL values based on current strategy position.
     * @dev Only callable by the paired PrimeCDO. Computes gain/loss, splits gains
     *      according to Senior/Mezz APR targets, runs 3-layer loss waterfall on negative gain.
     *      Updates srtTargetIndex, mzTargetIndex and lastUpdateTimestamp.
     *      See MATH_REFERENCE §C1-C5 for gain splitting, §D4 for loss waterfall.
     * @param currentStrategyTVL Current total assets reported by the strategy
     */
    function updateTVL(uint256 currentStrategyTVL) external;

    /**
     * @notice Record a new deposit into a tranche's TVL
     * @dev Only callable by the paired PrimeCDO. Increases the tranche's tracked TVL.
     * @param id Target tranche
     * @param amount Base-equivalent amount deposited
     */
    function recordDeposit(TrancheId id, uint256 amount) external;

    /**
     * @notice Record a withdrawal from a tranche's TVL
     * @dev Only callable by the paired PrimeCDO. Decreases the tranche's tracked TVL.
     * @param id Target tranche
     * @param amount Base-equivalent amount withdrawn
     */
    function recordWithdraw(TrancheId id, uint256 amount) external;

    /**
     * @notice Record a fee deducted from a tranche's TVL
     * @dev Only callable by the paired PrimeCDO. Moves amount from tranche TVL to reserve.
     * @param id Tranche the fee was charged to
     * @param feeAmount Fee amount in base-equivalent
     */
    function recordFee(TrancheId id, uint256 feeAmount) external;

    /**
     * @notice Claim accumulated reserve (fees + gain cuts). Resets s_reserveTVL to 0.
     * @dev Only callable by the paired PrimeCDO.
     * @return amount Reserve amount claimed (base-equivalent, 18 decimals)
     */
    function claimReserve() external returns (uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get TVL for a specific tranche
     * @param id Tranche to query
     * @return TVL in base-equivalent (18 decimals)
     */
    function getTrancheTVL(TrancheId id) external view returns (uint256);

    /**
     * @notice Get Junior TVL
     * @return Junior TVL in base-equivalent (18 decimals)
     */
    function getJuniorTVL() external view returns (uint256);

    /**
     * @notice Get TVL for all three tranches at once
     * @return sr Senior TVL
     * @return mz Mezzanine TVL
     * @return jr Junior TVL
     */
    function getAllTVLs() external view returns (uint256 sr, uint256 mz, uint256 jr);

    /**
     * @notice Get the current computed Senior APR
     * @dev Computed from risk premium curves and APR feed.
     *      Formula: APR_sr = MAX(APR_target, APR_base × (1 - RP1 - alpha × RP2))
     *      See MATH_REFERENCE §E5.
     * @return Senior APR as 18-decimal fixed-point
     */
    function getSeniorAPR() external view returns (uint256);

    /**
     * @notice Get the current computed Mezzanine APR
     * @dev APR_mz = MAX(aprBase, subPoolAPY * (1 - RP2)) where aprBase = Aave benchmark.
     * @return Mezzanine APR as 18-decimal fixed-point
     */
    function getMezzAPR() external view returns (uint256);

    /**
     * @notice Get the current computed Junior residual APR
     * @dev Residual = net strategy yield - Senior claim - Mezz claim, divided by Junior TVL.
     *      See MATH_REFERENCE §C5.
     * @return Junior residual APR as 18-decimal fixed-point
     */
    function getJuniorAPR() external view returns (uint256);
}
