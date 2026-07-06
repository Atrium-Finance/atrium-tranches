// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { UD60x18 } from "@prb/math/src/ud60x18/ValueType.sol";

import { IAccounting } from "../interfaces/IAccounting.sol";
import { IAPRFeed } from "../interfaces/IAPRFeed.sol";

/**
 * @notice Stand-in for Accounting in CDO-side tests. Records the most
 *         recent inputs so tests can assert the CDO forwarded them.
 */
contract MockAccounting is IAccounting {
    uint256 public lastNavT1;
    bool public updateAccountingCalled;

    uint256 public tvlJr_;
    uint256 public tvlMz_;
    uint256 public tvlSr_;
    uint256 public tvlReserve_;

    uint256 public lastJrIn; uint256 public lastJrOut;
    uint256 public lastMzIn; uint256 public lastMzOut;
    uint256 public lastSrIn; uint256 public lastSrOut;
    bool public noArgFlowCalled;

    address public lastFeeTranche;
    uint256 public lastFeeAssets;
    uint256 public lastReserveReduce;

    function setT0(uint256 jr, uint256 mz, uint256 sr, uint256 res) external {
        tvlJr_ = jr; tvlMz_ = mz; tvlSr_ = sr; tvlReserve_ = res;
    }

    // IAccounting state-changing -----------------------------------

    function updateAccounting(uint256 navT1) external override {
        updateAccountingCalled = true;
        lastNavT1 = navT1;
    }
    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external override {
        lastJrIn = jrIn; lastJrOut = jrOut;
        lastMzIn = mzIn; lastMzOut = mzOut;
        lastSrIn = srIn; lastSrOut = srOut;
    }
    function updateBalanceFlow() external override { noArgFlowCalled = true; }
    function accrueFee(address tranche, uint256 assets) external override {
        lastFeeTranche = tranche; lastFeeAssets = assets;
    }
    function reduceReserve(uint256 baseAssets) external override {
        lastReserveReduce = baseAssets;
    }
    function onAprChanged() external override {}
    function setAprPairFeed(IAPRFeed) external override {}
    function setRiskParameters(UD60x18, UD60x18, UD60x18) external override {}
    function setAlphaWeights(uint256, uint256) external override {}
    function setReserveBps(uint256) external override {}

    // IAccounting views --------------------------------------------

    function totalAssets(uint256)
        external view override returns (uint256, uint256, uint256, uint256)
    {
        return (tvlJr_, tvlMz_, tvlSr_, tvlReserve_);
    }
    function totalAssetsT0()
        external view override returns (uint256, uint256, uint256, uint256)
    {
        return (tvlJr_, tvlMz_, tvlSr_, tvlReserve_);
    }
    function totalAssets(address) external view override returns (uint256) {
        return tvlJr_;
    }

    // Stubbed config getters ---------------------------------------

    function aprPairFeed() external pure override returns (IAPRFeed) { return IAPRFeed(address(0)); }
    function aprTarget() external pure override returns (UD60x18) { return UD60x18.wrap(0); }
    function aprBase() external pure override returns (UD60x18) { return UD60x18.wrap(0); }
    function aprSrt() external pure override returns (UD60x18) { return UD60x18.wrap(0); }
    function riskX() external pure override returns (UD60x18) { return UD60x18.wrap(0); }
    function riskY() external pure override returns (UD60x18) { return UD60x18.wrap(0); }
    function riskK() external pure override returns (UD60x18) { return UD60x18.wrap(0); }
    function alphaJr() external pure override returns (uint256) { return 0; }
    function alphaMz() external pure override returns (uint256) { return 0; }
    function reserveBps() external pure override returns (uint256) { return 0; }
    function srtTargetIndex() external pure override returns (uint256) { return 1e18; }
    function lastUpdateTime() external pure override returns (uint256) { return 0; }
}
