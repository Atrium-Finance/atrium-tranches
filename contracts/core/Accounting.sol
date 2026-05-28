// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { UD60x18 } from "@prb/math/src/ud60x18/ValueType.sol";
import { ud } from "@prb/math/src/ud60x18/Casting.sol";
import { mul, pow } from "@prb/math/src/ud60x18/Math.sol";

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { AccessControlled } from "../governance/AccessControlled.sol";
import { CDOComponent } from "../base/CDOComponent.sol";

import { ICDO } from "../interfaces/ICDO.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";
import { IAPRFeed } from "../interfaces/IAPRFeed.sol";

/**
 * @title  Accounting
 * @notice Owns the protocol's accounting state: tranche TVLs, reserve,
 *         APR pipeline, risk-premium parameters, Senior compounding
 *         index. Driven by the CDO; holds no funds.
 */
contract Accounting is AccessControlled, CDOComponent, IAccounting {
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /** @notice Seconds in a non-leap year. */
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /** @notice 1.0 in 1e18 precision. */
    uint256 public constant PERCENTAGE_100 = 1e18;

    /** @notice Cap on `reserveBps`: 20% of positive delta. */
    uint256 public constant RESERVE_BPS_MAX = 0.2e18;

    /** @dev SD7x12 feed upper bound: 200% APR. */
    int64 private constant APR_FEED_BOUNDARY_MAX = 2e12;
    /** @dev SD7x12 feed lower bound: 0% APR. */
    int64 private constant APR_FEED_BOUNDARY_MIN = 0;
    /** @dev Expected `IAPRFeed.decimals()` — SD7x12. */
    uint256 private constant APR_FEED_DECIMALS = 12;

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error NotImplemented();
    error InvalidTranche(address tranche);
    error InvalidFeedDecimals(uint8 actual, uint256 expected);
    error InvalidReserveBps(uint256 bps);
    error InvalidRiskParams();
    error InvalidAlphaWeights();
    error InvalidNavSplit(uint256 navT1, uint256 jr, uint256 mz, uint256 sr, uint256 reserve);
    error LossExceedsNav(uint256 loss, uint256 absorbable);

    // ---------------------------------------------------------------
    // Storage — tranche TVLs and total NAV
    // ---------------------------------------------------------------

    uint256 public tvlJr;
    uint256 public tvlMz;
    uint256 public tvlSr;
    uint256 public tvlReserve;

    /** @notice Last-recorded total strategy NAV. */
    uint256 public nav;

    // ---------------------------------------------------------------
    // Storage — APR feed and APR values
    // ---------------------------------------------------------------

    /** @notice External APR pair feed. `address(0)` disables pulls. */
    IAPRFeed public override aprPairFeed;

    /** @notice Floor target APR for Senior. */
    UD60x18 public override aprTarget;
    /** @notice Base APR pulled from the feed and normalised to UD60x18. */
    UD60x18 public override aprBase;
    /** @notice Senior target APR: `max(aprTarget, aprBase × (1 - RP_nominal))`. */
    UD60x18 public override aprSrt;

    /** @notice Last `block.timestamp` at which the Senior index was rolled. */
    uint256 public override lastUpdateTime;
    /** @notice Senior target index. Starts at 1e18 and compounds via `aprSrt`. */
    uint256 public override srtTargetIndex;

    // ---------------------------------------------------------------
    // Storage — Risk premium parameters (UD60x18)
    // ---------------------------------------------------------------

    UD60x18 public override riskX;
    UD60x18 public override riskY;
    UD60x18 public override riskK;

    // ---------------------------------------------------------------
    // Storage — Residual split alpha weights
    // ---------------------------------------------------------------

    uint256 public override alphaJr;
    uint256 public override alphaMz;

    // ---------------------------------------------------------------
    // Storage — Reserve cut
    // ---------------------------------------------------------------

    uint256 public override reserveBps;

    // ---------------------------------------------------------------
    // Storage gap
    // ---------------------------------------------------------------

    /** @dev Reserved for additional fields in future versions. */
    uint256[33] private __gap;

    // ---------------------------------------------------------------
    // Initialiser
    // ---------------------------------------------------------------

    /**
     * @notice Initialise the Accounting proxy.
     * @dev    `aprPairFeed_` may be `address(0)` — pulls no-op until {setAprPairFeed}.
     */
    function initialize(
        address cdo_,
        IAPRFeed aprPairFeed_,
        address owner_,
        address acm_,
        UD60x18 aprTarget_,
        UD60x18 aprBase_
    ) external initializer {
        if (cdo_ == address(0)) revert InvalidCaller(address(0));
        AccessControlled_init(owner_, acm_);

        cdo = ICDO(cdo_);
        aprPairFeed = aprPairFeed_;
        aprTarget = aprTarget_;
        aprBase = aprBase_;

        // Senior index seed = 1.0.
        srtTargetIndex = 1e18;
        lastUpdateTime = block.timestamp;

        // Default risk premium params: x = y = 20%, k = 0.3.
        riskX = ud(0.2e18);
        riskY = ud(0.2e18);
        riskK = ud(0.3e18);

        // Default residual-split alpha weights: Jr 2.5×, Mz 1×.
        alphaJr = 2.5e18;
        alphaMz = 1e18;

        // Default reserve cut: 5% of positive delta.
        reserveBps = 0.05e18;

        // Initial aprSrt — safe to seed at aprTarget since TVLs are zero.
        aprSrt = aprTarget_;
    }

    // ---------------------------------------------------------------
    // State-changing — driven by CDO
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IAccounting
     */
    function updateAccounting(uint256 navT1) external onlyCDO {
        _updateAccountingInner(navT1);
    }

    /**
     * @inheritdoc IAccounting
     */
    function updateBalanceFlow(
        uint256 /*jrIn*/,
        uint256 /*jrOut*/,
        uint256 /*mzIn*/,
        uint256 /*mzOut*/,
        uint256 /*srIn*/,
        uint256 /*srOut*/
    ) external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function updateBalanceFlow() external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function accrueFee(address /*tranche*/, uint256 /*assets*/) external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function reduceReserve(
        uint256 /*totalAmount*/,
        uint256 /*jrDistribute*/,
        uint256 /*mzDistribute*/,
        uint256 /*srDistribute*/
    ) external onlyCDO {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // State-changing — APR pipeline + admin setters
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IAccounting
     */
    function onAprChanged() external onlyRole(UPDATER_FEED_ROLE) {
        (bool modified, UD60x18 t, UD60x18 b) = _fetchAprs();
        if (modified) emit AprDataChangedViaPush(t, b);
    }

    /**
     * @inheritdoc IAccounting
     * @dev `address(0)` detaches the feed; non-zero feeds must report
     *      `decimals() == APR_FEED_DECIMALS`.
     */
    function setAprPairFeed(IAPRFeed aprPairFeed_) external onlyOwner {
        if (address(aprPairFeed_) != address(0)) {
            uint8 feedDecimals = aprPairFeed_.decimals();
            if (uint256(feedDecimals) != APR_FEED_DECIMALS) {
                revert InvalidFeedDecimals(feedDecimals, APR_FEED_DECIMALS);
            }
        }
        aprPairFeed = aprPairFeed_;
        emit AprPairFeedChanged(address(aprPairFeed_));
    }

    /**
     * @inheritdoc IAccounting
     * @dev Sanity bound: `x + y < 1e18` so the discounted base APR
     *      `aprBase × (1 - risk)` stays non-negative even when
     *      `srRatio = 1` (risk = x + y).
     */
    function setRiskParameters(
        UD60x18 riskX_,
        UD60x18 riskY_,
        UD60x18 riskK_
    ) external onlyRole(UPDATER_STRAT_CONFIG_ROLE) {
        if (UD60x18.unwrap(riskX_) + UD60x18.unwrap(riskY_) >= PERCENTAGE_100) {
            revert InvalidRiskParams();
        }
        riskX = riskX_;
        riskY = riskY_;
        riskK = riskK_;
        _updateAprSrt(aprTarget, aprBase);
        emit RiskParametersChanged(riskX_, riskY_, riskK_);
    }

    /**
     * @inheritdoc IAccounting
     */
    function setReserveBps(uint256 bps) external onlyOwner {
        if (bps > RESERVE_BPS_MAX) revert InvalidReserveBps(bps);
        reserveBps = bps;
        emit ReservePercentageChanged(bps);
    }

    /**
     * @inheritdoc IAccounting
     */
    function setAlphaWeights(uint256 jr, uint256 mz) external onlyOwner {
        if (jr == 0 || mz == 0) revert InvalidAlphaWeights();
        if (jr > 10e18 || mz > 10e18) revert InvalidAlphaWeights();
        alphaJr = jr;
        alphaMz = mz;
        emit AlphaWeightsChanged(jr, mz);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IAccounting
     */
    function totalAssets(
        uint256 navT1
    ) external view returns (uint256 jrAssets, uint256 mzAssets, uint256 srAssets, uint256 reserveAssets) {
        return calculateNAVSplit(nav, tvlJr, tvlMz, tvlSr, tvlReserve, navT1);
    }

    /**
     * @inheritdoc IAccounting
     */
    function totalAssetsT0()
        external
        view
        returns (uint256 jrTvl_, uint256 mzTvl_, uint256 srTvl_, uint256 reserveTvl_)
    {
        return (tvlJr, tvlMz, tvlSr, tvlReserve);
    }

    /**
     * @inheritdoc IAccounting
     */
    function totalAssets(address tranche) external view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        if (kind == TrancheKind.JUNIOR) return tvlJr;
        if (kind == TrancheKind.MEZZANINE) return tvlMz;
        return tvlSr;
    }

    /**
     * @inheritdoc IAccounting
     */
    function maxDeposit(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function maxWithdraw(address /*tranche*/, bool /*isSharesLockup*/) external view returns (uint256) {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // Public view — NAV split projection
    // ---------------------------------------------------------------

    /**
     * @notice Project the next-state NAV split given a fresh strategy NAV.
     * @dev    Three branches:
     *         - Bootstrap: all tranche NAVs zero → entire `navT1` to reserve.
     *         - Negative delta: loss cascades Jr → Mz → Sr (Reserve excluded
     *           per D6). `loss > jr + mz + sr` reverts `LossExceedsNav` (D9).
     *         - Positive delta: Case 1 (Sr meets target, residual to Jr/Mz)
     *           or Case 2 (Sr funded by Jr → Mz cascade, no Sr absorption).
     *         Invariant `navT1 == jr + mz + sr + reserve` enforced on
     *         every branch.
     */
    function calculateNAVSplit(
        uint256 navT0,
        uint256 jrtNavT0,
        uint256 mzNavT0,
        uint256 srtNavT0,
        uint256 reserveNavT0,
        uint256 navT1
    ) public view returns (uint256 jrtNavT1, uint256 mzNavT1, uint256 srtNavT1, uint256 reserveNavT1) {
        // Bootstrap: no tranche deposits yet — route any gain to reserve.
        if (jrtNavT0 == 0 && mzNavT0 == 0 && srtNavT0 == 0 && navT1 > 0) {
            return (0, 0, 0, navT1);
        }

        // Negative-delta path — loss waterfall (D6, D7, D11).
        if (navT1 < navT0) {
            uint256 loss = navT0 - navT1;

            // D9: loss cannot exceed the tranche-stack NAV.
            //     Reserve excluded — never absorbs loss (D6, D10).
            uint256 absorbable = jrtNavT0 + mzNavT0 + srtNavT0;
            if (loss > absorbable) revert LossExceedsNav(loss, absorbable);

            (jrtNavT1, mzNavT1, srtNavT1, ) = _applyWaterfall(jrtNavT0, mzNavT0, srtNavT0, loss);

            reserveNavT1 = reserveNavT0;

            if (navT1 != jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1) {
                revert InvalidNavSplit(navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
            }
            return (jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
        }

        uint256 deltaAbs = navT1 - navT0;

        // Step 1 — reserve cut from positive delta.
        uint256 reserveCut;
        if (deltaAbs > 0 && reserveBps > 0) {
            reserveCut = Math.mulDiv(deltaAbs, reserveBps, PERCENTAGE_100);
            deltaAbs -= reserveCut;
        }
        reserveNavT1 = reserveNavT0 + reserveCut;

        // Step 2 — Senior's target gain via the index ratchet.
        uint256 srtTargetIndexT1 = _calculateTargetIndex(srtTargetIndex, lastUpdateTime, block.timestamp, aprSrt);
        uint256 srtGainTarget;
        if (srtNavT0 > 0 && srtTargetIndex > 0) {
            uint256 projected = Math.mulDiv(srtNavT0, srtTargetIndexT1, srtTargetIndex);
            if (projected > srtNavT0) {
                srtGainTarget = projected - srtNavT0;
            }
        }

        // Step 3 — Case 1 vs Case 2.
        if (deltaAbs >= srtGainTarget) {
            // Case 1: yield enough for Sr's target — residual to Jr/Mz.
            srtNavT1 = srtNavT0 + srtGainTarget;
            uint256 residual = deltaAbs - srtGainTarget;
            (uint256 jrGain, uint256 mzGain) = _splitResidual(jrtNavT0, mzNavT0, residual);
            jrtNavT1 = jrtNavT0 + jrGain;
            mzNavT1 = mzNavT0 + mzGain;
        } else {
            // Case 2 (D8): Sr funded by cascading shortfall through Jr → Mz.
            //   If Jr+Mz can't cover, Sr simply receives less than target
            //   (still a gain period, no Sr absorption, no impairment).
            uint256 shortfall = srtGainTarget - deltaAbs;
            (uint256 jrAfter, uint256 mzAfter, , uint256 unfunded) = _applyWaterfallNoSr(jrtNavT0, mzNavT0, shortfall);
            uint256 srFunded = shortfall - unfunded;
            srtNavT1 = srtNavT0 + deltaAbs + srFunded;
            jrtNavT1 = jrAfter;
            mzNavT1 = mzAfter;
        }

        // Step 4 — invariant: pool conservation.
        if (navT1 != jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1) {
            revert InvalidNavSplit(navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
        }
    }

    // ---------------------------------------------------------------
    // Internal — accounting flow
    // ---------------------------------------------------------------

    function _updateAccountingInner(uint256 navT1) internal {
        // 1. Refresh APRs from feed (if wired). When unchanged, recompute
        //    aprSrt with current params so srRatio drift is reflected.
        (bool aprChanged, , ) = _fetchAprs();
        if (!aprChanged) _updateAprSrt(aprTarget, aprBase);

        uint256 navBefore = nav;
        uint256 jrNavBefore = tvlJr;
        uint256 mzNavBefore = tvlMz;
        uint256 srNavBefore = tvlSr;

        // 2. Split the delta.
        (uint256 jrtNavT1, uint256 mzNavT1, uint256 srtNavT1, uint256 reserveNavT1) = calculateNAVSplit(
            navBefore,
            jrNavBefore,
            mzNavBefore,
            srNavBefore,
            tvlReserve,
            navT1
        );

        // 3. Loss events (D12). Negative-delta path only; the cascade
        //    monotonically reduces tranche NAVs so the subtractions are safe.
        if (navT1 < navBefore) {
            emit LossAbsorbed(navBefore - navT1, jrNavBefore - jrtNavT1, mzNavBefore - mzNavT1, srNavBefore - srtNavT1);
            if (srtNavT1 < srNavBefore) {
                emit SeniorImpaired(srNavBefore - srtNavT1, srtNavT1);
            }
        }

        // 4. Roll the Senior index forward (period closed at current aprSrt).
        _updateIndex();

        // 5. Commit.
        nav = navT1;
        tvlJr = jrtNavT1;
        tvlMz = mzNavT1;
        tvlSr = srtNavT1;
        tvlReserve = reserveNavT1;

        emit AccountingUpdated(navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
    }

    function _updateIndex() internal {
        srtTargetIndex = _calculateTargetIndex(srtTargetIndex, lastUpdateTime, block.timestamp, aprSrt);
        lastUpdateTime = block.timestamp;
    }

    function _fetchAprs() internal returns (bool modified, UD60x18 aprTargetT1, UD60x18 aprBaseT1) {
        if (address(aprPairFeed) == address(0)) {
            return (false, aprTarget, aprBase);
        }
        IAPRFeed.Round memory round = aprPairFeed.latestRoundData();
        aprTargetT1 = _normalizeAprFromFeed(round.aprTarget);
        aprBaseT1 = _normalizeAprFromFeed(round.aprBase);
        if (
            UD60x18.unwrap(aprTargetT1) != UD60x18.unwrap(aprTarget) ||
            UD60x18.unwrap(aprBaseT1) != UD60x18.unwrap(aprBase)
        ) {
            aprTarget = aprTargetT1;
            aprBase = aprBaseT1;
            _updateAprSrt(aprTargetT1, aprBaseT1);
            return (true, aprTargetT1, aprBaseT1);
        }
        return (false, aprTargetT1, aprBaseT1);
    }

    /**
     * @dev Clamps the SD7x12 feed value into `[0, APR_FEED_BOUNDARY_MAX]`
     *      then rescales to UD60x18 (× 10^6 to go from 12 → 18 decimals).
     */
    function _normalizeAprFromFeed(int64 apr) internal pure returns (UD60x18) {
        if (apr < APR_FEED_BOUNDARY_MIN) return ud(0);
        if (apr > APR_FEED_BOUNDARY_MAX) apr = APR_FEED_BOUNDARY_MAX;
        return ud(uint256(uint64(apr)) * 1e6);
    }

    // ---------------------------------------------------------------
    // Internal — Senior index + risk premium
    // ---------------------------------------------------------------

    /**
     * @dev Linear-per-period compound: `indexT1 = indexT0 × (1 + apr × dt / YEAR)`.
     *      Sufficient for sub-day update cadence; converges to true
     *      compound as period → 0.
     */
    function _calculateTargetIndex(
        uint256 targetIndex,
        uint256 t0,
        uint256 t1,
        UD60x18 apr
    ) internal pure returns (uint256) {
        if (t1 <= t0) return targetIndex;
        uint256 dt = t1 - t0;
        uint256 interestFactor = Math.mulDiv(UD60x18.unwrap(apr), dt, SECONDS_PER_YEAR);
        return Math.mulDiv(targetIndex, PERCENTAGE_100 + interestFactor, PERCENTAGE_100);
    }

    function _calculateRiskPremium() internal view returns (UD60x18) {
        uint256 sub = tvlJr + tvlMz;
        uint256 total = sub + tvlSr;
        UD60x18 srRatio = total == 0 ? ud(0) : ud(Math.mulDiv(tvlSr, PERCENTAGE_100, total));
        return _calculateRiskPremiumInner(riskX, riskY, riskK, srRatio);
    }

    /** @dev `risk = x + y × srRatio^k`. */
    function _calculateRiskPremiumInner(
        UD60x18 x,
        UD60x18 y,
        UD60x18 k,
        UD60x18 srRatio
    ) internal pure returns (UD60x18) {
        // PRBMath: pow returns x^y; mul handles 1e18-scaled multiplication.
        return ud(UD60x18.unwrap(x) + UD60x18.unwrap(mul(y, pow(srRatio, k))));
    }

    /**
     * @dev `aprSrt = max(aprTarget_, aprBase_ × (1 - risk))`.
     *      Floor protects Sr from earning below the target rate.
     */
    function _updateAprSrt(UD60x18 aprTarget_, UD60x18 aprBase_) internal {
        UD60x18 risk = _calculateRiskPremium();
        uint256 oneMinusRisk = UD60x18.unwrap(risk) >= PERCENTAGE_100 ? 0 : PERCENTAGE_100 - UD60x18.unwrap(risk);
        UD60x18 discounted = ud(Math.mulDiv(UD60x18.unwrap(aprBase_), oneMinusRisk, PERCENTAGE_100));
        UD60x18 chosen = UD60x18.unwrap(aprTarget_) >= UD60x18.unwrap(discounted) ? aprTarget_ : discounted;
        aprSrt = chosen;
    }

    // ---------------------------------------------------------------
    // Internal — split helper
    // ---------------------------------------------------------------

    /**
     * @dev Splits `residualTotal` between Jr and Mz weighted by
     *      `α × TVL`. `mzShare = residualTotal - jrShare` is computed
     *      as remainder to guarantee `jr + mz == residualTotal` exactly
     *      (otherwise rounding could break the pool-conservation invariant).
     *      When both NAVs are zero, falls back to splitting by alpha alone.
     */
    function _splitResidual(
        uint256 jrtNavT0_,
        uint256 mzNavT0_,
        uint256 residualTotal
    ) internal view returns (uint256 jrShare, uint256 mzShare) {
        if (residualTotal == 0) return (0, 0);

        uint256 jrWeight = jrtNavT0_ * alphaJr;
        uint256 mzWeight = mzNavT0_ * alphaMz;
        uint256 totalWeight = jrWeight + mzWeight;

        if (totalWeight == 0) {
            // Both NAVs zero — split by alpha alone (recovery / bootstrap).
            uint256 alphaTotal = alphaJr + alphaMz;
            jrShare = Math.mulDiv(residualTotal, alphaJr, alphaTotal);
            mzShare = residualTotal - jrShare;
            return (jrShare, mzShare);
        }

        jrShare = Math.mulDiv(residualTotal, jrWeight, totalWeight);
        mzShare = residualTotal - jrShare;
    }

    // ---------------------------------------------------------------
    // Internal — loss waterfall cascades (D11)
    // ---------------------------------------------------------------

    /**
     * @notice Cascade an absorption amount across Jr → Mz → Sr.
     * @dev    Used by the negative-delta loss path. `srHit` lets the
     *         caller decide whether to emit {SeniorImpaired}.
     * @param  jr0    Junior NAV before.
     * @param  mz0    Mezzanine NAV before.
     * @param  sr0    Senior NAV before.
     * @param  amount Total amount to remove from the stack.
     * @return jr1    Junior NAV after.
     * @return mz1    Mezzanine NAV after.
     * @return sr1    Senior NAV after.
     * @return srHit  Amount that reached Senior (0 if Jr+Mz absorbed all).
     */
    function _applyWaterfall(
        uint256 jr0,
        uint256 mz0,
        uint256 sr0,
        uint256 amount
    ) internal pure returns (uint256 jr1, uint256 mz1, uint256 sr1, uint256 srHit) {
        if (amount <= jr0) {
            return (jr0 - amount, mz0, sr0, 0);
        }
        uint256 remaining = amount - jr0;

        if (remaining <= mz0) {
            return (0, mz0 - remaining, sr0, 0);
        }
        remaining -= mz0;

        if (remaining <= sr0) {
            return (0, 0, sr0 - remaining, remaining);
        }

        // remaining > sr0 — caller guards via `LossExceedsNav`; defensive zero.
        return (0, 0, 0, sr0);
    }

    /**
     * @notice Cascade through Jr → Mz only. Sr is the recipient of the
     *         freed value (Case 2), not an absorber.
     * @dev    `mzReached` is always 0 — present for signature parity.
     *         `unfunded` is the portion Jr+Mz could not cover; Sr simply
     *         receives less than its target gain.
     */
    function _applyWaterfallNoSr(
        uint256 jr0,
        uint256 mz0,
        uint256 amount
    ) internal pure returns (uint256 jr1, uint256 mz1, uint256 mzReached, uint256 unfunded) {
        mzReached = 0;
        if (amount <= jr0) {
            return (jr0 - amount, mz0, 0, 0);
        }
        uint256 remaining = amount - jr0;
        if (remaining <= mz0) {
            return (0, mz0 - remaining, 0, 0);
        }
        return (0, 0, 0, remaining - mz0);
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    /** @dev Resolve a wired tranche address to its kind; reverts otherwise. */
    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(cdo.jrVault())) return TrancheKind.JUNIOR;
        if (tranche == address(cdo.mezzVault())) return TrancheKind.MEZZANINE;
        if (tranche == address(cdo.srVault())) return TrancheKind.SENIOR;
        revert InvalidTranche(tranche);
    }
}
