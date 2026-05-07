// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — RiskParams
//  Premium curve parameters for RP1/RP2 risk pricing
//  See: docs/PV_V3_FINAL_v34.md section 30
// ══════════════════════════════════════════════════════════════════════

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title RiskParams
 * @notice Stores risk premium curve parameters used by Accounting to compute Senior/Junior APR.
 * @dev RP1 = x + y * ratio_sr^k (Senior pays Mezzanine)
 *      RP2 = x + y * coverage^k  (Pool pays Junior)
 *      Timelock is external (PrimeGovernor wraps calls).
 *      See MATH_REFERENCE §E2, §E3 for curve formulas.
 */
contract RiskParams is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct PremiumCurve {
        uint256 x;
        uint256 y;
        uint256 k;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant MAX_SENIOR_X = 0.30e18; //0.3
    uint256 public constant MAX_SENIOR_XY = 0.80e18; //0.8
    uint256 public constant MAX_JUNIOR_XY = 0.50e18; //0.5
    uint256 public constant MAX_RESERVE_BPS = 2_000;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    PremiumCurve public s_seniorPremium;
    PremiumCurve public s_juniorPremium;
    uint256 public s_reserveBps;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event SeniorPremiumUpdated(uint256 x, uint256 y, uint256 k);
    event JuniorPremiumUpdated(uint256 x, uint256 y, uint256 k);
    event ReserveBpsUpdated(uint256 reserveBps);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__SeniorXTooHigh(uint256 x, uint256 max);
    error PrimeVaults__SeniorXYTooHigh(uint256 xy, uint256 max);
    error PrimeVaults__JuniorXYTooHigh(uint256 xy, uint256 max);
    error PrimeVaults__ReserveBpsTooHigh(uint256 bps, uint256 max);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address owner_) Ownable(owner_) {
        s_seniorPremium = PremiumCurve({x: 0.10e18, y: 0.125e18, k: 0.3e18}); // RP1 = 10% + 12.5% * ratio_sr^0.3
        s_juniorPremium = PremiumCurve({x: 0.05e18, y: 0.10e18, k: 0.5e18}); // RP2 = 5% + 10% * coverage^0.5
        s_reserveBps = 500;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Update the Senior risk premium curve (RP1)
     * @dev Constraints: x <= 0.30e18, x + y <= 0.80e18
     * @param curve New PremiumCurve values
     */
    function setSeniorPremium(PremiumCurve calldata curve) external onlyOwner {
        if (curve.x > MAX_SENIOR_X)
            revert PrimeVaults__SeniorXTooHigh(curve.x, MAX_SENIOR_X);
        if (curve.x + curve.y > MAX_SENIOR_XY)
            revert PrimeVaults__SeniorXYTooHigh(
                curve.x + curve.y,
                MAX_SENIOR_XY
            );
        s_seniorPremium = curve;
        emit SeniorPremiumUpdated(curve.x, curve.y, curve.k);
    }

    /**
     * @notice Update the Junior risk premium curve (RP2)
     * @dev Constraint: x + y <= 0.50e18
     * @param curve New PremiumCurve values
     */
    function setJuniorPremium(PremiumCurve calldata curve) external onlyOwner {
        if (curve.x + curve.y > MAX_JUNIOR_XY)
            revert PrimeVaults__JuniorXYTooHigh(
                curve.x + curve.y,
                MAX_JUNIOR_XY
            );
        s_juniorPremium = curve;
        emit JuniorPremiumUpdated(curve.x, curve.y, curve.k);
    }

    /**
     * @notice Update the reserve cut from positive gains
     * @dev Constraint: reserveBps <= 2000 (20%)
     * @param reserveBps_ New reserve basis points
     */
    function setReserveBps(uint256 reserveBps_) external onlyOwner {
        if (reserveBps_ > MAX_RESERVE_BPS)
            revert PrimeVaults__ReserveBpsTooHigh(reserveBps_, MAX_RESERVE_BPS);
        s_reserveBps = reserveBps_;
        emit ReserveBpsUpdated(reserveBps_);
    }
}
