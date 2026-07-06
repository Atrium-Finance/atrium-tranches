// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { UD60x18 } from "@prb/math/src/ud60x18/ValueType.sol";

import { IAPRFeed } from "./IAPRFeed.sol";

/**
 * @notice Tranche classification shared across every contract that
 *         touches per-tranche accounting.
 */
enum TrancheKind { JUNIOR, MEZZANINE, SENIOR }

/**
 * @title  IAccounting
 * @notice Pure-calculation contract owning tranche TVLs, reserve,
 *         APR pipeline, and the Senior compounding index. Driven by
 *         the CDO; holds no funds.
 */
interface IAccounting {
    event AccountingUpdated(
        uint256 totalStrategyAssets,
        uint256 jrTvl,
        uint256 mzTvl,
        uint256 srTvl,
        uint256 reserveTvl
    );

    event AprDataChangedViaPush(UD60x18 aprTarget, UD60x18 aprBase);
    event AprPairFeedChanged(address feed);
    event RiskParametersChanged(UD60x18 riskX, UD60x18 riskY, UD60x18 riskK);
    event AlphaWeightsChanged(uint256 alphaJr, uint256 alphaMz);
    event ReservePercentageChanged(uint256 reserveBps);
    event ReserveReduced(uint256 baseAssets);
    event BalanceFlowUpdated(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    );
    event FeeAccrued(address indexed tranche, uint256 assets);
    event SeniorImpaired(uint256 lossToSenior, uint256 seniorNavAfter);
    event LossAbsorbed(
        uint256 totalLoss,
        uint256 jrAbsorbed,
        uint256 mzAbsorbed,
        uint256 srAbsorbed
    );

    /**
     * @notice Refresh accounting using `totalStrategyAssets` as the
     *         freshest strategy NAV. Allocates `netGain` per the
     *         yield-split / loss-waterfall rules and advances the
     *         Senior target index.
     */
    function updateAccounting(uint256 totalStrategyAssets) external;

    // @notice Record per-tranche deposit / withdraw flows.
    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external;

    // @notice NAV-only refresh; no balance deltas to record.
    function updateBalanceFlow() external;

    /**
     * @notice Move accrued fees from `tranche`'s TVL into reserve.
     * @param  tranche The tranche address; kind resolved via CDO.
     * @param  assets  Fee amount in base-asset units.
     */
    function accrueFee(address tranche, uint256 assets) external;

    /**
     * @notice Decrement the reserve bucket by `baseAssets` for
     *         treasury drain. No redistribution.
     */
    function reduceReserve(uint256 baseAssets) external;

    /**
     * @notice Refresh accounting and pull the latest
     *         `(aprTarget, aprBase)` pair from the wired feed.
     */
    function onAprChanged() external;

    // @notice Set the APR pair-feed contract. Validates feed decimals.
    function setAprPairFeed(IAPRFeed aprPairFeed_) external;

    /**
     * @notice Set the Senior risk-premium parameters in
     *         `risk = x + y × tvlRatio^k`.
     */
    function setRiskParameters(UD60x18 riskX_, UD60x18 riskY_, UD60x18 riskK_) external;

    /**
     * @notice Set the residual-split alpha weights for Jr/Mz, encoded
     *         in 1e18. Both must be non-zero and `<= 10e18`.
     */
    function setAlphaWeights(uint256 jr, uint256 mz) external;

    /**
     * @notice Set the share of positive delta routed to reserve, in
     *         1e18. Capped at `RESERVE_BPS_MAX` (20%).
     */
    function setReserveBps(uint256 bps) external;

    // @notice Compute tranche assets given a fresh strategy TVL.
    function totalAssets(uint256 totalStrategyAssets)
        external view
        returns (
            uint256 jrAssets,
            uint256 mzAssets,
            uint256 srAssets,
            uint256 reserveAssets
        );

    // @notice Snapshot of the last-recorded TVLs (no fresh calc).
    function totalAssetsT0()
        external view
        returns (
            uint256 jrTvl,
            uint256 mzTvl,
            uint256 srTvl,
            uint256 reserveTvl
        );

    // @notice TVL of a single tranche. Reverts on unwired addresses.
    function totalAssets(address tranche) external view returns (uint256);

    function aprPairFeed() external view returns (IAPRFeed);

    function aprTarget() external view returns (UD60x18);
    function aprBase() external view returns (UD60x18);
    function aprSrt() external view returns (UD60x18);

    function riskX() external view returns (UD60x18);
    function riskY() external view returns (UD60x18);
    function riskK() external view returns (UD60x18);

    function alphaJr() external view returns (uint256);
    function alphaMz() external view returns (uint256);
    function reserveBps() external view returns (uint256);

    function srtTargetIndex() external view returns (uint256);
    function lastUpdateTime() external view returns (uint256);
}
