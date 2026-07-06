// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IStrategyAprProvider } from "../interfaces/oracles/IStrategyAprProvider.sol";

/**
 * @notice Mock provider for `AprPairFeed` PULL-path tests.
 */
contract MockSharesAprProvider is IStrategyAprProvider {
    int64 public aprBaseValue;
    int64 public aprTargetValue;
    uint64 public updatedAtValue;

    function setApr(int64 aprBase_, int64 aprTarget_, uint64 updatedAt_) external {
        aprBaseValue = aprBase_;
        aprTargetValue = aprTarget_;
        updatedAtValue = updatedAt_;
    }

    function getApr() external view override returns (int64, int64, uint64) {
        return (aprBaseValue, aprTargetValue, updatedAtValue);
    }
}
