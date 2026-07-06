// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IAprPairFeed {
    /**
     * @notice One APR observation. `aprBase` is market data,
     *         `aprTarget` is Senior floor policy. Both encoded SD7x12
     *         (`int64`, 12 decimals).
     */
    struct TRound {
        int64  aprBase;
        int64  aprTarget;
        uint64 updatedAt;
        uint64 answeredInRound;
    }

    function latestRoundData() external view returns (TRound memory);
    function getRoundData(uint64 roundId) external view returns (TRound memory);

    // @notice PUSH update — observer writes a round directly.
    function updateRoundData(int64 aprBase, int64 aprTarget, uint64 timestamp) external;

    // @notice PULL update — pulls from the wired provider.
    function updateRoundData() external;

    function decimals() external view returns (uint8);
}
