// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IAavePool } from "../interfaces/external/IAavePool.sol";

/**
 * @notice Minimal mock of Aave V3 Pool.
 *         Tests pre-seed per-asset reserve data via `setReserve`.
 */
contract MockAavePool is IAavePool {
    mapping(address => ReserveData) private _reserves;

    function setReserve(
        address asset,
        uint128 currentLiquidityRate,
        address aTokenAddress
    ) external {
        ReserveData storage data = _reserves[asset];
        data.currentLiquidityRate = currentLiquidityRate;
        data.aTokenAddress = aTokenAddress;
    }

    function getReserveData(address asset) external view override returns (ReserveData memory) {
        return _reserves[asset];
    }
}
