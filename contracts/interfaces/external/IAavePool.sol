// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title  IAavePool
 * @notice Minimal Aave V3 Pool reader. Only {getReserveData} is used,
 *         to read the per-reserve supply APR (`currentLiquidityRate`,
 *         RAY = 1e27) and the `aTokenAddress` whose `totalSupply()`
 *         weights the rate.
 * @dev    `ReserveData` MUST mirror Aave V3's struct layout exactly —
 *         field names and order are part of the ABI contract.
 */
interface IAavePool {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40  lastUpdateTimestamp;
        uint16  id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);
}
