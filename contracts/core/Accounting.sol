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
 * @dev Senior + Junior + Reserve. All tranches are base-asset only.
 *      Gain splitting: Senior gets target APY, Junior gets residual.
 *      Loss waterfall (3 layers): Junior → Senior yield-tier → Senior principal-tier.
 *      Senior principal (s_seniorPrincipal) is the locked-in USDai value at deposit-time
 *      sUSDai/USDai exchange rate — when sUSDai depreciates, Junior and Senior-yield absorb
 *      the USDai shortfall before Senior's locked-in value is touched.
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
    /**
     * @notice Senior locked-in USDai value (sUSDai shares × deposit-time sUSDai/USDai rate).
     * @dev Equivalent to "sum of USDai amounts at deposit time" — every recordDeposit(SENIOR, x)
     *      captures the USDai-value of x at the prevailing sUSDai/USDai exchange rate at that
     *      moment. When sUSDai depreciates, current strategy USDai-value drops; the loss
     *      waterfall absorbs from Junior → Senior yield-tier (s_seniorTVL - this) → Senior
     *      principal-tier (this), preserving the locked-in value as long as Junior and
     *      Senior's accrued yield can cover.
     */
    uint256 public s_seniorPrincipal;
    uint256 public s_juniorBaseTVL;
    uint256 public s_reserveTVL;
    uint256 public s_lastUpdateTimestamp;
    uint256 public s_srtTargetIndex;

    address public s_primeCDO;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event CDOSet(address cdo);
    event DepositRecorded(TrancheId indexed tranche, uint256 amount);
    event WithdrawRecorded(TrancheId indexed tranche, uint256 amount);
    event FeeRecorded(TrancheId indexed tranche, uint256 feeAmount);
    event GainSplit(uint256 netGain, uint256 seniorGainTarget, uint256 juniorGain, uint256 reserveCut);
    event LossApplied(
        uint256 loss,
        uint256 jrAbsorbed,
        uint256 srYieldAbsorbed,
        uint256 srPrincipalAbsorbed
    );
    event SeniorPrincipalIncreased(uint256 amount, uint256 newPrincipal);
    event SeniorPrincipalScaled(uint256 oldTVL, uint256 newTVL, uint256 newPrincipal);
    event SeniorPrincipalAbsorbed(uint256 amount, uint256 newPrincipal);

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
        uint256 prevStrategyTVL = s_seniorTVL + s_juniorBaseTVL + s_reserveTVL;

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
            // Loss path (D4) — 3-layer waterfall: Junior → Senior yield → Senior principal
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
        if (id == TrancheId.SENIOR) {
            s_seniorPrincipal += amount;
            emit SeniorPrincipalIncreased(amount, s_seniorPrincipal);
        }
        _addToTranche(id, amount);
        emit DepositRecorded(id, amount);
    }

    /** @notice Record a withdrawal from a tranche's TVL. */
    function recordWithdraw(TrancheId id, uint256 amount) external override onlyCDO {
        if (id == TrancheId.SENIOR) {
            _scaleSeniorPrincipal(amount);
        }
        _subFromTranche(id, amount);
        emit WithdrawRecorded(id, amount);
    }

    /** @notice Record a fee — deduct from tranche, add to reserve. */
    function recordFee(TrancheId id, uint256 feeAmount) external override onlyCDO {
        if (id == TrancheId.SENIOR) {
            _scaleSeniorPrincipal(feeAmount);
        }
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
        if (id == TrancheId.JUNIOR) return s_juniorBaseTVL;
        revert PrimeVaults__InvalidTrancheId();
    }

    /** @notice Get Junior TVL. */
    function getJuniorTVL() external view override returns (uint256) {
        return s_juniorBaseTVL;
    }

    /** @notice Get TVL for both tranches. */
    function getAllTVLs() external view override returns (uint256 sr, uint256 jr) {
        sr = s_seniorTVL;
        jr = s_juniorBaseTVL;
    }

    /** @notice Get tracked Senior principal (sum of net deposits, no accrued yield). */
    function getSeniorPrincipal() external view override returns (uint256) {
        return s_seniorPrincipal;
    }

    /**
     * @notice Compute current Senior APY using APR feed + risk premium.
     * @dev APY_sr = MAX(aaveBenchmark, baseAPY × (1 - RP1)). See MATH_REFERENCE §E5.
     */
    function getSeniorAPY() external view override returns (uint256) {
        return _computeSeniorAPY();
    }

    /**
     * @notice Compute Junior residual APY.
     * @dev Junior == sub-pool. JuniorAPY = baseAPY + (baseAPY - seniorAPY) × (Sr / Jr).
     *      Floor active: JuniorAPY = max(0, baseAPY - (seniorAPY - baseAPY) × (Sr / Jr)).
     *      See MATH_REFERENCE §C5.
     * @return Junior residual APY as 18-decimal fixed-point
     */
    function getJuniorAPY() external view override returns (uint256) {
        return _computeJuniorAPY();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — Gain Splitting (§C2-C5)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Split positive strategy gain across tranches. See MATH_REFERENCE §C2-C5.
     *      Priority: reserve cut → Senior target → Junior residual.
     *      If yield insufficient for Senior target, the deficit is applied via the
     *      loss waterfall (Junior → Senior yield → Senior principal).
     */
    function _splitGain(uint256 strategyGain, uint256 deltaT) internal {
        // C2: Reserve cut (only on positive gains)
        uint256 reserveBps = i_riskParams.s_reserveBps();
        uint256 reserveCut = (strategyGain * reserveBps) / 10_000;
        uint256 netGain = strategyGain - reserveCut;
        s_reserveTVL += reserveCut;

        // C3: Senior target gain (compound index)
        uint256 apySr = _computeSeniorAPY();
        uint256 seniorGainTarget = (s_seniorTVL * apySr * deltaT) / (YEAR * PRECISION);

        // Update Senior target index
        if (s_seniorTVL > 0 && apySr > 0) {
            uint256 interestFactor = (apySr * deltaT) / YEAR;
            s_srtTargetIndex = (s_srtTargetIndex * (PRECISION + interestFactor)) / PRECISION;
        }

        // C5: Senior always receives full target.
        // If yield insufficient, the deficit hits the loss waterfall.
        s_seniorTVL += seniorGainTarget;

        if (netGain >= seniorGainTarget) {
            // CASE A: yield sufficient — Junior gets the residual
            uint256 juniorGain = netGain - seniorGainTarget;
            s_juniorBaseTVL += juniorGain;
            emit GainSplit(netGain, seniorGainTarget, juniorGain, reserveCut);
        } else {
            // CASE B: yield insufficient — deficit applied via loss waterfall
            uint256 deficit = seniorGainTarget - netGain;
            _applyLossWaterfall(deficit);
            emit GainSplit(netGain, seniorGainTarget, 0, reserveCut);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — Loss Waterfall (§D4)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Apply 3-layer loss waterfall. See MATH_REFERENCE §D4.
     *      Layer 1: Junior (first loss)
     *      Layer 2: Senior yield-tier (s_seniorTVL - s_seniorPrincipal)
     *      Layer 3: Senior principal-tier (last resort)
     */
    function _applyLossWaterfall(uint256 loss) internal {
        uint256 remaining = loss;

        // Layer 1: Junior (first loss)
        uint256 jrAbsorbed = remaining > s_juniorBaseTVL ? s_juniorBaseTVL : remaining;
        s_juniorBaseTVL -= jrAbsorbed;
        remaining -= jrAbsorbed;

        // Layer 2: Senior yield-tier
        uint256 seniorYield = s_seniorTVL > s_seniorPrincipal ? s_seniorTVL - s_seniorPrincipal : 0;
        uint256 srYieldAbsorbed = remaining > seniorYield ? seniorYield : remaining;
        s_seniorTVL -= srYieldAbsorbed;
        remaining -= srYieldAbsorbed;

        // Layer 3: Senior principal-tier (last resort)
        uint256 srPrincipalAbsorbed = remaining > s_seniorPrincipal ? s_seniorPrincipal : remaining;
        if (srPrincipalAbsorbed > 0) {
            s_seniorTVL -= srPrincipalAbsorbed;
            s_seniorPrincipal -= srPrincipalAbsorbed;
            emit SeniorPrincipalAbsorbed(srPrincipalAbsorbed, s_seniorPrincipal);
        }

        emit LossApplied(loss, jrAbsorbed, srYieldAbsorbed, srPrincipalAbsorbed);
    }

    /**
     * @dev Scale s_seniorPrincipal pro-rata when Senior TVL is reduced via withdraw/fee.
     *      newPrincipal = oldPrincipal × (oldTVL - amount) / oldTVL
     *      Truncates toward zero — conservative for the protocol over many small withdraws.
     */
    function _scaleSeniorPrincipal(uint256 amount) internal {
        uint256 oldTVL = s_seniorTVL;
        if (oldTVL == 0) return;
        uint256 newTVL = amount >= oldTVL ? 0 : oldTVL - amount;
        uint256 newPrincipal = newTVL == 0 ? 0 : (s_seniorPrincipal * newTVL) / oldTVL;
        if (newPrincipal != s_seniorPrincipal) {
            s_seniorPrincipal = newPrincipal;
            emit SeniorPrincipalScaled(oldTVL, newTVL, newPrincipal);
        }
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
     *      ratio_sr = TVL_sr / (TVL_sr + TVL_jr)
     */
    function _computeRP1() internal view returns (uint256) {
        uint256 pool = s_seniorTVL + s_juniorBaseTVL;
        if (pool == 0 || s_seniorTVL == 0) return 0;

        uint256 ratioSr = s_seniorTVL.fpDiv(pool);

        (uint256 x, uint256 y, uint256 k) = i_riskParams.s_seniorPremium();
        uint256 rPow = ratioSr.fpow(k);
        return x + y.fpMul(rPow);
    }

    /**
     * @dev Read APR pair from feed. Returns (0, 0) if feed is not a contract or call fails.
     * @return aaveBenchSenior Senior aprTarget floor (12dec → 18dec) from feed
     * @return strategyAPR Actual sUSDai yield rate (used as base APY for gain splitting)
     */
    function _getAprPair()
        internal
        view
        returns (uint256 aaveBenchSenior, uint256 strategyAPR)
    {
        address feed = address(i_aprFeed);
        if (feed == address(0) || feed.code.length == 0) return (0, 0);
        try i_aprFeed.latestRoundData() returns (IAprPairFeed.TRound memory round) {
            aaveBenchSenior = _aprTo18Dec(round.aprTargetSenior);
            strategyAPR = _aprTo18Dec(round.aprBase);
        } catch {
            return (0, 0);
        }
    }

    /**
     * @dev Base APR = strategy APR (no dilution — all tranches are base-asset only).
     */
    function _computeBaseAPY() internal view returns (uint256) {
        (, uint256 strategyAPR) = _getAprPair();
        return strategyAPR;
    }

    /**
     * @dev APY_sr = MAX(aaveBenchSenior, baseAPY × (1 - RP1)). See MATH_REFERENCE §E4.
     */
    function _computeSeniorAPY() internal view returns (uint256) {
        (uint256 aaveBenchSenior, ) = _getAprPair();
        uint256 baseAPY = _computeBaseAPY();

        uint256 rp1 = _computeRP1();

        uint256 apySr = rp1 < PRECISION ? baseAPY.fpMul(PRECISION - rp1) : 0;

        return apySr > aaveBenchSenior ? apySr : aaveBenchSenior;
    }

    /**
     * @dev Compute Junior APR (Junior == entire sub-pool in the 2-tranche model).
     *      Normal (baseAPY ≥ seniorAPY): JuniorAPY = baseAPY + (baseAPY - seniorAPY) × Sr/Jr.
     *      Floor active (baseAPY < seniorAPY): JuniorAPY = max(0, baseAPY - (seniorAPY - baseAPY) × Sr/Jr).
     *      See MATH_REFERENCE §E5.
     */
    function _computeJuniorAPY() internal view returns (uint256) {
        if (s_juniorBaseTVL == 0) return 0;

        uint256 baseAPY = _computeBaseAPY();
        uint256 apySr = _computeSeniorAPY();

        uint256 leverage = s_seniorTVL > 0 ? s_seniorTVL.fpDiv(s_juniorBaseTVL) : 0;

        if (baseAPY >= apySr) {
            // Normal: Junior absorbs Senior's discount with leverage
            uint256 bonus = (baseAPY - apySr).fpMul(leverage);
            return baseAPY + bonus;
        } else {
            // Floor active: Junior pays for Senior's floor guarantee
            uint256 deficit = (apySr - baseAPY).fpMul(leverage);
            return baseAPY > deficit ? baseAPY - deficit : 0;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — TVL helpers
    // ═══════════════════════════════════════════════════════════════════

    function _addToTranche(TrancheId id, uint256 amount) internal {
        if (id == TrancheId.SENIOR) s_seniorTVL += amount;
        else if (id == TrancheId.JUNIOR) s_juniorBaseTVL += amount;
        else revert PrimeVaults__InvalidTrancheId();
    }

    /** @dev Subtract from tranche TVL. Clamp to 0 instead of leaving dust. */
    function _subFromTranche(TrancheId id, uint256 amount) internal {
        if (id == TrancheId.SENIOR) s_seniorTVL = amount >= s_seniorTVL ? 0 : s_seniorTVL - amount;
        else if (id == TrancheId.JUNIOR) s_juniorBaseTVL = amount >= s_juniorBaseTVL ? 0 : s_juniorBaseTVL - amount;
        else revert PrimeVaults__InvalidTrancheId();
    }
}
