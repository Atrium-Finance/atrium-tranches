// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — RedemptionPolicy
//  Per-tranche coverage-based cooldown mechanism + fee selection
//  See: docs/PV_V3_FINAL_v34.md section 28, docs/PV_V3_COVERAGE_GATE.md
// ══════════════════════════════════════════════════════════════════════

import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { TrancheId } from "../interfaces/IPrimeCDO.sol";

/**
 * @title RedemptionPolicy
 * @notice Per-tranche cooldown mechanism and fee selection based on Senior coverage.
 * @dev Coverage metric:
 *        cs = (Sr + Jr) / Sr  → Senior coverage
 *
 *      Senior:  always instant (no cooldown).
 *      Junior:  based on cs only — instant cs>instantCs, asset lock assetLockCs<cs≤instantCs, share lock cs≤assetLockCs.
 *
 *      All thresholds, durations, and fees are governance-configurable.
 *      See docs/PV_V3_FINAL_v34.md section 28, docs/PV_V3_COVERAGE_GATE.md
 */
contract RedemptionPolicy is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    enum CooldownMechanism {
        NONE, // instant
        ASSETS_LOCK, // lock assets in ERC20Cooldown
        SHARES_LOCK // lock shares in SharesCooldown
    }

    struct PolicyResult {
        CooldownMechanism mechanism;
        uint256 feeBps;
        uint256 cooldownDuration;
    }

    /** @dev Thresholds and params for Junior tranche (single-dimensional: cs only) */
    struct JuniorParams {
        uint256 instantCs; // cs > instantCs → NONE
        uint256 assetLockCs; // cs > assetLockCs → ASSETS_LOCK
        // cs ≤ assetLockCs → SHARES_LOCK
    }

    /** @dev Fee and duration per mechanism */
    struct MechanismConfig {
        uint256 instantFeeBps;
        uint256 assetsLockFeeBps;
        uint256 assetsLockDuration;
        uint256 sharesLockFeeBps;
        uint256 sharesLockDuration;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    IAccounting public s_accounting;

    JuniorParams public s_juniorParams;

    // Per-tranche fee/duration config
    mapping(TrancheId => MechanismConfig) public s_mechanismConfig;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event AccountingSet(address accounting);
    event JuniorParamsUpdated(uint256 instantCs, uint256 assetLockCs);
    event MechanismConfigUpdated(TrancheId indexed tranche);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__FeeTooHigh(uint256 feeBps);
    error PrimeVaults__InvalidThresholds();

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address owner_, address accounting_) Ownable(owner_) {
        s_accounting = IAccounting(accounting_);
        _initDefaults();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  QUERY
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Evaluate policy for a tranche based on live coverage from Accounting.
     * @dev Senior: always instant. Junior: evaluated against cs.
     * @param tranche The tranche requesting withdrawal
     * @return result The cooldown mechanism, fee, and duration
     */
    function evaluate(TrancheId tranche) external view returns (PolicyResult memory result) {
        if (tranche == TrancheId.SENIOR) return _buildResult(tranche, CooldownMechanism.NONE);
        uint256 cs = _getCoverage();
        return _buildResult(tranche, _evaluateJuniorMechanism(cs));
    }

    /**
     * @notice Evaluate for explicit coverage value (testing/preview).
     * @param tranche The tranche requesting withdrawal
     * @param cs Senior coverage (1e18 scale)
     * @return result The cooldown mechanism, fee, and duration
     */
    function evaluateForCoverage(TrancheId tranche, uint256 cs) external view returns (PolicyResult memory result) {
        if (tranche == TrancheId.SENIOR) return _buildResult(tranche, CooldownMechanism.NONE);
        return _buildResult(tranche, _evaluateJuniorMechanism(cs));
    }

    /**
     * @notice Get senior coverage (cs) from Accounting.
     * @dev cs = (Sr+Jr)/Sr
     * @return cs Senior coverage (1e18 scale, type(uint256).max if Sr == 0)
     */
    function getCoverage() external view returns (uint256 cs) {
        return _getCoverage();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setAccounting(address accounting_) external onlyOwner {
        s_accounting = IAccounting(accounting_);
        emit AccountingSet(accounting_);
    }

    /** @notice Update Junior coverage thresholds. instantCs must be > assetLockCs. */
    function setJuniorParams(uint256 instantCs_, uint256 assetLockCs_) external onlyOwner {
        if (instantCs_ <= assetLockCs_) revert PrimeVaults__InvalidThresholds();
        s_juniorParams = JuniorParams({ instantCs: instantCs_, assetLockCs: assetLockCs_ });
        emit JuniorParamsUpdated(instantCs_, assetLockCs_);
    }

    /** @notice Update fee and duration config for a tranche. */
    function setMechanismConfig(TrancheId tranche, MechanismConfig calldata config_) external onlyOwner {
        if (config_.instantFeeBps > MAX_FEE_BPS) revert PrimeVaults__FeeTooHigh(config_.instantFeeBps);
        if (config_.assetsLockFeeBps > MAX_FEE_BPS) revert PrimeVaults__FeeTooHigh(config_.assetsLockFeeBps);
        if (config_.sharesLockFeeBps > MAX_FEE_BPS) revert PrimeVaults__FeeTooHigh(config_.sharesLockFeeBps);
        s_mechanismConfig[tranche] = config_;
        emit MechanismConfigUpdated(tranche);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /** @dev Compute cs from Accounting TVLs. */
    function _getCoverage() internal view returns (uint256 cs) {
        (uint256 sr, uint256 jr) = s_accounting.getAllTVLs();
        cs = sr > 0 ? ((sr + jr) * PRECISION) / sr : type(uint256).max;
    }

    /** @dev Junior mechanism: instant if cs > instantCs, asset lock if cs > assetLockCs, else share lock. */
    function _evaluateJuniorMechanism(uint256 cs) internal view returns (CooldownMechanism) {
        JuniorParams memory p = s_juniorParams;
        if (cs > p.instantCs) return CooldownMechanism.NONE;
        if (cs > p.assetLockCs) return CooldownMechanism.ASSETS_LOCK;
        return CooldownMechanism.SHARES_LOCK;
    }

    /** @dev Build PolicyResult from mechanism + per-tranche config. */
    function _buildResult(TrancheId tranche, CooldownMechanism mechanism) internal view returns (PolicyResult memory) {
        MechanismConfig memory cfg = s_mechanismConfig[tranche];
        if (mechanism == CooldownMechanism.NONE) {
            return PolicyResult({ mechanism: CooldownMechanism.NONE, feeBps: cfg.instantFeeBps, cooldownDuration: 0 });
        } else if (mechanism == CooldownMechanism.ASSETS_LOCK) {
            return
                PolicyResult({
                    mechanism: CooldownMechanism.ASSETS_LOCK,
                    feeBps: cfg.assetsLockFeeBps,
                    cooldownDuration: cfg.assetsLockDuration
                });
        }
        return
            PolicyResult({
                mechanism: CooldownMechanism.SHARES_LOCK,
                feeBps: cfg.sharesLockFeeBps,
                cooldownDuration: cfg.sharesLockDuration
            });
    }

    /** @dev Set initial default thresholds, fees, and durations. */
    function _initDefaults() internal {
        // Junior thresholds
        s_juniorParams = JuniorParams({ instantCs: 1.60e18, assetLockCs: 1.40e18 });

        // Senior: always instant, fee configurable
        s_mechanismConfig[TrancheId.SENIOR] = MechanismConfig({
            instantFeeBps: 0,
            assetsLockFeeBps: 0,
            assetsLockDuration: 0,
            sharesLockFeeBps: 0,
            sharesLockDuration: 0
        });

        // Junior: 3 day asset lock, 7 day share lock
        s_mechanismConfig[TrancheId.JUNIOR] = MechanismConfig({
            instantFeeBps: 0,
            assetsLockFeeBps: 20,
            assetsLockDuration: 3 days,
            sharesLockFeeBps: 100,
            sharesLockDuration: 7 days
        });
    }
}
