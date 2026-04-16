// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — Accounting
//  TVL tracking, gain splitting, and loss waterfall
//  See: docs/PV_V3_FINAL_v34.md section 17
// ══════════════════════════════════════════════════════════════════════

import { IAccounting } from "../interfaces/IAccounting.sol";
import { TrancheId } from "../interfaces/IPrimeCDO.sol";
import { IAprPairFeed } from "../interfaces/IAprPairFeed.sol";
import { RiskParams } from "../governance/RiskParams.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";

/**
 * @title Accounting
 * @notice Tracks per-tranche TVL for a single PrimeVaults market.
 * @dev Senior + Mezzanine + Junior + Reserve. All tranches are base-asset only.
 *      Gain splitting: Senior gets target APR, Mezz gets MAX(floor, subPoolAPY*(1-RP2)), Junior gets residual.
 *      Loss waterfall: Junior → Mezzanine → Senior.
 *      See MATH_REFERENCE §C1-C4 for gain splitting, §D1-D4 for loss waterfall.
 */
contract Accounting is IAccounting {
    using FixedPointMath for uint256;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;
    uint256 private constant YEAR = 365 days;
    uint256 private constant APR_12DEC_TO_18DEC = 1e6; // int64×12dec → uint256×18dec

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAprPairFeed public immutable i_aprFeed;
    RiskParams public immutable i_riskParams;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_seniorTVL;
    uint256 public s_mezzTVL;
    uint256 public s_juniorBaseTVL;
    uint256 public s_reserveTVL;
    uint256 public s_lastUpdateTimestamp;
    uint256 public s_srtTargetIndex;
    uint256 public s_mzTargetIndex;

    address public s_primeCDO;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event CDOSet(address cdo);
    event DepositRecorded(TrancheId indexed tranche, uint256 amount);
    event WithdrawRecorded(TrancheId indexed tranche, uint256 amount);
    event FeeRecorded(TrancheId indexed tranche, uint256 feeAmount);
    event GainSplit(uint256 netGain, uint256 seniorGain, uint256 mezzGain, uint256 juniorGain, uint256 reserveCut);
    event LossApplied(uint256 loss, uint256 jrAbsorbed, uint256 mzAbsorbed, uint256 srAbsorbed);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__CDOAlreadySet();
    error PrimeVaults__ZeroAddress();
    error PrimeVaults__InvalidTrancheId();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyCDO() {
        if (msg.sender != s_primeCDO) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address aprFeed_, address riskParams_) {
        i_aprFeed = IAprPairFeed(aprFeed_);
        i_riskParams = RiskParams(riskParams_);
        s_srtTargetIndex = PRECISION; // init: 1e18
        s_mzTargetIndex = PRECISION; // init: 1e18
        s_lastUpdateTimestamp = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SETUP
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set the PrimeCDO address. Can only be called once.
     * @param cdo_ Address of the paired PrimeCDO contract
     */
    function setCDO(address cdo_) external {
        if (cdo_ == address(0)) revert PrimeVaults__ZeroAddress();
        if (s_primeCDO != address(0)) revert PrimeVaults__CDOAlreadySet();
        s_primeCDO = cdo_;
        emit CDOSet(cdo_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE — updateTVL (gain splitting + loss waterfall)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Update TVLs: detect gain/loss from strategy, split gains or apply loss waterfall.
     * @dev See MATH_REFERENCE §C1-C5 for gain splitting, §D4 for loss waterfall.
     *      Called by PrimeCDO at the start of every deposit/withdraw.
     * @param currentStrategyTVL Strategy.totalAssets() — current base value in strategy
     */
    function updateTVL(uint256 currentStrategyTVL) external override onlyCDO {
        // C1: Strategy gain = current - previous tracked strategy TVL
        uint256 prevStrategyTVL = s_seniorTVL + s_mezzTVL + s_juniorBaseTVL + s_reserveTVL;

        if (prevStrategyTVL == 0) {
            s_lastUpdateTimestamp = block.timestamp;
            return;
        }

        uint256 deltaT = block.timestamp - s_lastUpdateTimestamp;
        if (deltaT == 0) return;

        if (currentStrategyTVL >= prevStrategyTVL) {
            // Gain path (C2-C5)
            uint256 strategyGain = currentStrategyTVL - prevStrategyTVL;
            _splitGain(strategyGain, deltaT);
        } else {
            // Loss path (D4) — 3-layer waterfall: Junior → Mezz → Senior
            uint256 loss = prevStrategyTVL - currentStrategyTVL;
            _applyLossWaterfall(loss);
        }

        s_lastUpdateTimestamp = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE — Record deposit / withdraw / fee
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Record a deposit into a tranche's TVL. */
    function recordDeposit(TrancheId id, uint256 amount) external override onlyCDO {
        _addToTranche(id, amount);
        emit DepositRecorded(id, amount);
    }

    /** @notice Record a withdrawal from a tranche's TVL. */
    function recordWithdraw(TrancheId id, uint256 amount) external override onlyCDO {
        _subFromTranche(id, amount);
        emit WithdrawRecorded(id, amount);
    }

    /** @notice Record a fee — deduct from tranche, add to reserve. */
    function recordFee(TrancheId id, uint256 feeAmount) external override onlyCDO {
        _subFromTranche(id, feeAmount);
        s_reserveTVL += feeAmount;
        emit FeeRecorded(id, feeAmount);
    }

    /** @notice Claim accumulated reserve. Resets s_reserveTVL to 0. */
    function claimReserve() external override onlyCDO returns (uint256 amount) {
        amount = s_reserveTVL;
        s_reserveTVL = 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Get TVL for a specific tranche. */
    function getTrancheTVL(TrancheId id) external view override returns (uint256) {
        if (id == TrancheId.SENIOR) return s_seniorTVL;
        if (id == TrancheId.MEZZ) return s_mezzTVL;
        if (id == TrancheId.JUNIOR) return s_juniorBaseTVL;
        revert PrimeVaults__InvalidTrancheId();
    }

    /** @notice Get Junior TVL. */
    function getJuniorTVL() external view override returns (uint256) {
        return s_juniorBaseTVL;
    }

    /** @notice Get TVL for all three tranches. */
    function getAllTVLs() external view override returns (uint256 sr, uint256 mz, uint256 jr) {
        sr = s_seniorTVL;
        mz = s_mezzTVL;
        jr = s_juniorBaseTVL;
    }

    /**
     * @notice Compute current Senior APR using APR feed + risk premiums.
     * @dev APR_sr = MAX(aprTarget, aprBase × (1 - RP1)). See MATH_REFERENCE §E5.
     */
    function getSeniorAPR() external view override returns (uint256) {
        return _computeSeniorAPR();
    }

    /**
     * @notice Compute current Mezzanine APR using APR feed + risk premiums.
     * @dev APR_mz = MAX(aprBase, subPoolAPY × (1 - RP2)). See MATH_REFERENCE §E6.
     */
    function getMezzAPR() external view override returns (uint256) {
        return _computeMezzAPR();
    }

    /**
     * @notice Compute Junior residual APR.
     * @dev Junior gets the residual after Senior and Mezzanine target claims.
     *      See MATH_REFERENCE §C5.
     * @return Junior residual APR as 18-decimal fixed-point
     */
    function getJuniorAPR() external view override returns (uint256) {
        return _computeJuniorAPR();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — Gain Splitting (§C2-C5)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Split positive strategy gain across tranches. See MATH_REFERENCE §C2-C5.
     *      Priority: reserve cut → Senior target → Mezz target → Junior residual.
     *      If yield insufficient for Senior + Mezz targets, the deficit is applied
     *      via the loss waterfall (Junior → Mezz → Senior).
     */
    function _splitGain(uint256 strategyGain, uint256 deltaT) internal {
        // C2: Reserve cut (only on positive gains)
        uint256 reserveBps = i_riskParams.s_reserveBps();
        uint256 reserveCut = (strategyGain * reserveBps) / 10_000;
        uint256 netGain = strategyGain - reserveCut;
        s_reserveTVL += reserveCut;

        // C3: Senior target gain (compound index)
        uint256 aprSr = _computeSeniorAPR();
        uint256 seniorGainTarget = (s_seniorTVL * aprSr * deltaT) / (YEAR * PRECISION);

        // Update Senior target index
        if (s_seniorTVL > 0 && aprSr > 0) {
            uint256 interestFactor = (aprSr * deltaT) / YEAR;
            s_srtTargetIndex = (s_srtTargetIndex * (PRECISION + interestFactor)) / PRECISION;
        }

        // C4: Mezzanine target gain (compound index)
        uint256 aprMz = _computeMezzAPR();
        uint256 mezzGainTarget = (s_mezzTVL * aprMz * deltaT) / (YEAR * PRECISION);

        // Update Mezz target index
        if (s_mezzTVL > 0 && aprMz > 0) {
            uint256 interestFactor = (aprMz * deltaT) / YEAR;
            s_mzTargetIndex = (s_mzTargetIndex * (PRECISION + interestFactor)) / PRECISION;
        }

        // C5: Senior + Mezz always receive their full target.
        // If yield insufficient, the deficit hits the loss waterfall.
        uint256 totalTarget = seniorGainTarget + mezzGainTarget;

        // Always credit full targets
        s_seniorTVL += seniorGainTarget;
        s_mezzTVL += mezzGainTarget;

        if (netGain >= totalTarget) {
            // CASE A: yield sufficient — Junior gets the residual
            uint256 juniorGain = netGain - totalTarget;
            s_juniorBaseTVL += juniorGain;
            emit GainSplit(netGain, seniorGainTarget, mezzGainTarget, juniorGain, reserveCut);
        } else {
            // CASE B: yield insufficient — deficit applied via loss waterfall
            uint256 deficit = totalTarget - netGain;
            _applyLossWaterfall(deficit);
            emit GainSplit(netGain, seniorGainTarget, mezzGainTarget, 0, reserveCut);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — Loss Waterfall (§D4)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Apply 3-layer loss waterfall. See MATH_REFERENCE §D4.
     *      Layer 1: Junior (first loss)
     *      Layer 2: Mezzanine
     *      Layer 3: Senior (last resort)
     */
    function _applyLossWaterfall(uint256 loss) internal {
        uint256 remaining = loss;

        // Layer 1: Junior (first loss)
        uint256 jrAbsorbed = remaining > s_juniorBaseTVL ? s_juniorBaseTVL : remaining;
        s_juniorBaseTVL -= jrAbsorbed;
        remaining -= jrAbsorbed;

        // Layer 2: Mezzanine
        uint256 mzAbsorbed = remaining > s_mezzTVL ? s_mezzTVL : remaining;
        s_mezzTVL -= mzAbsorbed;
        remaining -= mzAbsorbed;

        // Layer 3: Senior (last resort)
        uint256 srAbsorbed = remaining > s_seniorTVL ? s_seniorTVL : remaining;
        s_seniorTVL -= srAbsorbed;

        emit LossApplied(loss, jrAbsorbed, mzAbsorbed, srAbsorbed);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — APR Computation (§E3-E6)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Convert int64 × 12 decimals APR to uint256 × 18 decimals. Negative → 0.
     */
    function _aprTo18Dec(int64 apr12) internal pure returns (uint256) {
        if (apr12 <= 0) return 0;
        return uint256(uint64(apr12)) * APR_12DEC_TO_18DEC;
    }

    /**
     * @dev Compute RP1 = x + y × ratio_sr^k. See MATH_REFERENCE §E3.
     *      ratio_sr = TVL_sr / Pool_TVL
     */
    function _computeRP1() internal view returns (uint256) {
        uint256 pool = s_seniorTVL + s_mezzTVL + s_juniorBaseTVL;
        if (pool == 0 || s_seniorTVL == 0) return 0;

        uint256 ratioSr = s_seniorTVL.fpDiv(pool);

        (uint256 x, uint256 y, uint256 k) = i_riskParams.s_seniorPremium();
        uint256 rPow = ratioSr.fpow(k);
        return x + y.fpMul(rPow);
    }

    /**
     * @dev Compute RP2 = x + y × ratio_mz_sub^k. See MATH_REFERENCE §E6.
     *      ratio_mz_sub = TVL_mz / (TVL_mz + Jr)
     */
    function _computeRP2() internal view returns (uint256) {
        uint256 mzPlusJr = s_mezzTVL + s_juniorBaseTVL;
        if (mzPlusJr == 0) return 0;

        uint256 ratioMzSub = s_mezzTVL.fpDiv(mzPlusJr);

        (uint256 x, uint256 y, uint256 k) = i_riskParams.s_juniorPremium();
        uint256 rPow = ratioMzSub.fpow(k);
        return x + y.fpMul(rPow);
    }

    /**
     * @dev Read APR pair from feed. Returns (0, 0) if feed is not a contract or call fails.
     * @return aaveBenchmarkAPR Aave weighted-average supply rate (used as floor for Senior & Mezz)
     * @return strategyAPR Actual sUSDai yield rate (used as base APY for gain splitting)
     */
    function _getAprPair() internal view returns (uint256 aaveBenchmarkAPR, uint256 strategyAPR) {
        address feed = address(i_aprFeed);
        if (feed == address(0) || feed.code.length == 0) return (0, 0);
        try i_aprFeed.latestRoundData() returns (IAprPairFeed.TRound memory round) {
            aaveBenchmarkAPR = _aprTo18Dec(round.aprTarget);
            strategyAPR = _aprTo18Dec(round.aprBase);
        } catch {
            return (0, 0);
        }
    }

    /**
     * @dev Base APY = strategy APR (no dilution — all tranches are base-asset only).
     */
    function _computeBaseAPY() internal view returns (uint256) {
        (, uint256 strategyAPR) = _getAprPair();
        return strategyAPR;
    }

    /**
     * @dev APR_sr = MAX(aaveBenchmark, baseAPY × (1 - RP1)). See MATH_REFERENCE §E4.
     */
    function _computeSeniorAPR() internal view returns (uint256) {
        (uint256 aaveBenchmarkAPR, ) = _getAprPair();
        uint256 apyBase = _computeBaseAPY();

        uint256 rp1 = _computeRP1();

        uint256 aprSr = rp1 < PRECISION ? apyBase.fpMul(PRECISION - rp1) : 0;

        return aprSr > aaveBenchmarkAPR ? aprSr : aaveBenchmarkAPR;
    }

    /**
     * @dev Compute sub-pool effective APY. See MATH_REFERENCE §E5.
     *      APY_sub = APY_base + (APY_base - APY_sr) × TVL_sr / (TVL_mz + Jr)
     *      Can be negative when floor is active (clamped to 0).
     */
    function _computeSubPoolAPY() internal view returns (uint256) {
        uint256 apyBase = _computeBaseAPY();
        uint256 aprSr = _computeSeniorAPR();

        uint256 mzPlusJr = s_mezzTVL + s_juniorBaseTVL;
        if (mzPlusJr == 0) return 0;

        uint256 leverage = s_seniorTVL > 0 ? s_seniorTVL.fpDiv(mzPlusJr) : 0;

        if (apyBase >= aprSr) {
            // Normal case: sub-pool gets boosted by RP1 transfer from Senior
            uint256 bonus = (apyBase - aprSr).fpMul(leverage);
            return apyBase + bonus;
        } else {
            // Floor active: sub-pool pays for Senior floor guarantee
            uint256 deficit = (aprSr - apyBase).fpMul(leverage);
            if (apyBase > deficit) return apyBase - deficit;
            return 0;
        }
    }

    /**
     * @dev APY_mz = MAX(aaveBenchmark, APY_sub × (1 - RP2)). See MATH_REFERENCE §E7.
     *      Floor = Aave benchmark rate from AprPairFeed.
     */
    function _computeMezzAPR() internal view returns (uint256) {
        (uint256 aaveBenchmarkAPR, ) = _getAprPair();

        uint256 apySub = _computeSubPoolAPY();

        uint256 aprMz;
        if (apySub > 0) {
            uint256 rp2 = _computeRP2();
            aprMz = rp2 < PRECISION ? apySub.fpMul(PRECISION - rp2) : 0;
        }

        return aprMz > aaveBenchmarkAPR ? aprMz : aaveBenchmarkAPR;
    }

    /**
     * @dev Compute Junior APY (residual after Senior + Mezz).
     *      APY_jr = APY_sub + (APY_sub - APY_mz) × TVL_mz / Jr
     *      See MATH_REFERENCE §E8.
     */
    function _computeJuniorAPR() internal view returns (uint256) {
        if (s_juniorBaseTVL == 0) return 0;

        uint256 apySub = _computeSubPoolAPY();
        if (apySub == 0) return 0;

        uint256 apyMz = _computeMezzAPR();

        // APY_jr = APY_sub + (APY_sub - APY_mz) × TVL_mz / Jr
        if (s_mezzTVL == 0) return apySub;

        uint256 mezzLeverage = s_mezzTVL.fpDiv(s_juniorBaseTVL);

        if (apySub >= apyMz) {
            uint256 bonus = (apySub - apyMz).fpMul(mezzLeverage);
            return apySub + bonus;
        }
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — TVL helpers
    // ═══════════════════════════════════════════════════════════════════

    function _addToTranche(TrancheId id, uint256 amount) internal {
        if (id == TrancheId.SENIOR) s_seniorTVL += amount;
        else if (id == TrancheId.MEZZ) s_mezzTVL += amount;
        else if (id == TrancheId.JUNIOR) s_juniorBaseTVL += amount;
        else revert PrimeVaults__InvalidTrancheId();
    }

    function _subFromTranche(TrancheId id, uint256 amount) internal {
        if (id == TrancheId.SENIOR) s_seniorTVL -= amount;
        else if (id == TrancheId.MEZZ) s_mezzTVL -= amount;
        else if (id == TrancheId.JUNIOR) s_juniorBaseTVL -= amount;
        else revert PrimeVaults__InvalidTrancheId();
    }
}
