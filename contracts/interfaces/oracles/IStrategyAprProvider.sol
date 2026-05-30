// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IStrategyAprProvider {
    /**
     * @notice Strategy's spot APR pair, 12-decimal int64.
     * @return aprBase   Annualized yield estimate (market data).
     * @return aprTarget Senior floor APR (strategy-specific policy).
     * @return updatedAt Timestamp of the observation.
     */
    function getApr() external view returns (
        int64 aprBase,
        int64 aprTarget,
        uint64 updatedAt
    );
}
