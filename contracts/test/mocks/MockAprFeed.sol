// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAprPairFeed} from "../../interfaces/IAprPairFeed.sol";
import {TrancheId} from "../../interfaces/IPrimeCDO.sol";

/**
 * @dev Mock APR feed for unit testing. Returns configurable per-tranche APR values.
 */
contract MockAprFeed is IAprPairFeed {
    int64 private _aprTargetSenior;
    int64 private _aprTargetMezz;
    int64 private _aprBase;

    constructor(int64 aprTarget_, int64 aprBase_) {
        _aprTargetSenior = aprTarget_;
        _aprTargetMezz = aprTarget_;
        _aprBase = aprBase_;
    }

    function setAprs(int64 aprTarget_, int64 aprBase_) external {
        _aprTargetSenior = aprTarget_;
        _aprTargetMezz = aprTarget_;
        _aprBase = aprBase_;
    }

    function setAprsPerTranche(int64 aprTargetSenior_, int64 aprTargetMezz_, int64 aprBase_) external {
        _aprTargetSenior = aprTargetSenior_;
        _aprTargetMezz = aprTargetMezz_;
        _aprBase = aprBase_;
    }

    function latestRoundData() external view override returns (TRound memory) {
        return TRound({
            aprTargetSenior: _aprTargetSenior,
            aprTargetMezz: _aprTargetMezz,
            aprBase: _aprBase,
            updatedAt: uint64(block.timestamp),
            answeredInRound: 1
        });
    }

    function getRoundData(uint64) external view override returns (TRound memory) {
        return TRound({
            aprTargetSenior: _aprTargetSenior,
            aprTargetMezz: _aprTargetMezz,
            aprBase: _aprBase,
            updatedAt: uint64(block.timestamp),
            answeredInRound: 1
        });
    }

    function updateRoundData() external override {}

    function pushAprTarget(TrancheId tranche, int64 value, uint64) external override {
        if (tranche == TrancheId.SENIOR) {
            _aprTargetSenior = value;
        } else if (tranche == TrancheId.MEZZ) {
            _aprTargetMezz = value;
        }
    }

    function pushAprBase(int64 value, uint64) external override {
        _aprBase = value;
    }
}
