// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { UD60x18 } from "@prb/math/src/ud60x18/ValueType.sol";

import { IAPRFeed } from "./IAPRFeed.sol";

/**
 * @notice Identifies which of the three tranches a function refers to.
 * @dev    Declared here (not in PrimeCDO) so every contract that
 *         touches per-tranche accounting shares the same vocabulary.
 */
enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }

/**
 * @title IAccounting
 * @notice Pure-calculation contract that owns the protocol's accounting
 *         state: tranche TVLs, reserve, APR pipeline (target/base/Senior
 *         target), risk-premium parameters, Senior compounding index.
 *         Driven by the CDO; holds no funds.
 * @dev    APRs are pulled from the external {IAPRFeed} via
 *         {onAprChanged}; the hot accounting path ({updateAccounting})
 *         does NOT pull on every tick.
 */
interface IAccounting {
    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /** @notice Emitted on every successful `updateAccounting` call. */
    event AccountingUpdated(
        uint256 totalStrategyAssets,
        uint256 jrTvl,
        uint256 mzTvl,
        uint256 srTvl,
        uint256 reserveTvl
    );

    /**
     * @notice Emitted by {onAprChanged} when the feed pull produced a new
     *         `(aprTarget, aprBase)` pair.
     */
    event AprDataChangedViaPush(UD60x18 aprTarget, UD60x18 aprBase);

    /** @notice Emitted when the admin rewires the APR feed. */
    event AprPairFeedChanged(address feed);

    /** @notice Emitted when admin updates the Senior risk-premium parameters. */
    event RiskParametersChanged(UD60x18 riskX, UD60x18 riskY, UD60x18 riskK);

    /** @notice Emitted when admin updates the Junior leverage factor. */
    event LeverageAlphaSet(uint256 alpha);

    /** @notice Emitted when admin updates the reserve rate. */
    event ReserveRateSet(uint256 rate);

    /** @notice Emitted on every reserve reduction. */
    event ReserveReduced(
        uint256 totalAmount,
        uint256 jrDistributed,
        uint256 mzDistributed,
        uint256 srDistributed
    );

    /** @notice Emitted whenever a tranche balance flow is recorded. */
    event BalanceFlowUpdated(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    );

    /** @notice Emitted on every fee accrual. */
    event FeeAccrued(TrancheKind kind, uint256 assets);

    // ---------------------------------------------------------------
    // State-changing — driven by CDO
    // ---------------------------------------------------------------

    /**
     * @notice Refresh accounting using the latest strategy NAV.
     * @dev    Caller (CDO) MUST pass `strategy.totalAssets()` so the
     *         accounting contract does not depend on Strategy directly.
     *         Internally: allocates `netGain` per the protocol's
     *         yield-split or loss-waterfall rules, updates each tranche
     *         TVL, advances the Senior target index.
     */
    function updateAccounting(uint256 totalStrategyAssets) external;

    /**
     * @notice Record a deposit / withdraw flow per tranche.
     * @dev    Called by CDO inside `deposit` / `withdraw` / `cooldownShares`.
     */
    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external;

    /**
     * @notice NAV-only refresh — no balance deltas to record.
     * @dev    Called by CDO after operations that change tranche NAV
     *         without an inbound/outbound user flow (e.g. `accrueFee`).
     */
    function updateBalanceFlow() external;

    /**
     * @notice Move accrued fee assets from a tranche's TVL into reserve.
     * @param  tranche The tranche address. Accounting resolves to kind via CDO.
     * @param  assets  Amount of fees, in base-asset units.
     */
    function accrueFee(address tranche, uint256 assets) external;

    /**
     * @notice Reduce the reserve, optionally distributing to tranches.
     * @dev    Driven by CDO's RESERVE_MANAGER.
     */
    function reduceReserve(
        uint256 totalAmount,
        uint256 jrDistribute,
        uint256 mzDistribute,
        uint256 srDistribute
    ) external;

    // ---------------------------------------------------------------
    // State-changing — APR pipeline
    // ---------------------------------------------------------------

    /**
     * @notice Refresh accounting and pull the latest `(aprTarget, aprBase)`
     *         from the wired feed.
     * @dev    Triggered by the oracle when the feed publishes a new round.
     */
    function onAprChanged() external;

    /**
     * @notice Admin set of the APR pair-feed contract.
     * @dev    Validates `decimals()` matches the protocol-wide SD7x12 format.
     */
    function setAprPairFeed(IAPRFeed aprPairFeed_) external;

    /**
     * @notice Admin set of the Senior risk-premium parameters.
     * @param  riskX_ Base risk-premium term `x` in `x + y × tvlRatio^k`.
     * @param  riskY_ Coefficient on the tvl-ratio term.
     * @param  riskK_ Exponent on the tvl-ratio term.
     */
    function setRiskParameters(UD60x18 riskX_, UD60x18 riskY_, UD60x18 riskK_) external;

    /** @notice Admin set of the Junior leverage factor (α). */
    function setLeverageAlpha(uint256 alpha) external;

    /**
     * @notice Admin set of the share of `netGain` routed to the reserve
     *         on each `updateAccounting` call. Encoded in 1e18 precision.
     */
    function setReserveRate(uint256 rate) external;

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /**
     * @notice Compute split assets given a fresh strategy TVL.
     * @return jrAssets   Assets attributable to Junior.
     * @return mzAssets   Assets attributable to Mezzanine.
     * @return srAssets   Assets attributable to Senior.
     * @return reserveAssets Assets attributable to the reserve.
     */
    function totalAssets(uint256 totalStrategyAssets)
        external view
        returns (
            uint256 jrAssets,
            uint256 mzAssets,
            uint256 srAssets,
            uint256 reserveAssets
        );

    /** @notice Snapshot of the last-recorded TVLs (no fresh calc). */
    function totalAssetsT0()
        external view
        returns (
            uint256 jrTvl,
            uint256 mzTvl,
            uint256 srTvl,
            uint256 reserveTvl
        );

    /**
     * @notice Per-tranche view, used by `CDO.totalAssets(tranche)`.
     * @dev    Reverts if `tranche` is not one of the three CDO vaults.
     */
    function totalAssets(address tranche) external view returns (uint256);

    /** @notice Maximum further deposit accepted by a tranche. */
    function maxDeposit(address tranche) external view returns (uint256);

    /**
     * @notice Maximum withdrawal a tranche can satisfy.
     * @param  tranche       Target tranche address.
     * @param  isSharesLockup True if the caller is the SharesCooldown silo.
     */
    function maxWithdraw(address tranche, bool isSharesLockup)
        external view returns (uint256);

    // ---------------------------------------------------------------
    // Views — configuration getters
    // ---------------------------------------------------------------

    function aprPairFeed() external view returns (IAPRFeed);

    function aprTarget() external view returns (UD60x18);
    function aprBase() external view returns (UD60x18);
    function aprSrt() external view returns (UD60x18);

    function riskX() external view returns (UD60x18);
    function riskY() external view returns (UD60x18);
    function riskK() external view returns (UD60x18);

    function leverageAlpha() external view returns (uint256);
    function reserveRate() external view returns (uint256);

    function srtTargetIndex() external view returns (uint256);
    function lastUpdateTime() external view returns (uint256);
}
