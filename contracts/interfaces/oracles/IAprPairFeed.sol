// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IAprPairFeed {
    /**
     * @notice One APR observation.
     * @dev    Carries both `aprBase` (market data) and `aprTarget` (Senior
     *         floor policy). Per-strategy floor is sourced from the
     *         provider on PULL and from the off-chain observer on PUSH.
     */
    struct TRound {
        int64  aprBase;
        int64  aprTarget;
        uint64 updatedAt;
        uint64 answeredInRound;
    }

    function latestRoundData() external view returns (TRound memory);
    function getRoundData(uint64 roundId) external view returns (TRound memory);

    function updateRoundData(int64 aprBase, int64 aprTarget, uint64 timestamp) external;
    function updateRoundData() external;

    function decimals() external view returns (uint8);
}
