// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/**
 * @title  IAPRFeed
 * @notice Oracle-style feed exposing the latest `(aprTarget, aprBase)`
 *         pair consumed by Accounting via {Accounting.onAprChanged}.
 */
interface IAPRFeed {
    /**
     * @notice Single round of feed data. `aprTarget` and `aprBase` are
     *         signed 12-decimal compact integers (SD7x12); Accounting
     *         normalises to UD60x18 via `× 1e6`.
     */
    struct Round {
        uint80 roundId;
        int64 aprTarget;
        int64 aprBase;
        uint256 updatedAt;
    }

    // @notice Most recent round published by the feed.
    function latestRoundData() external view returns (Round memory);

    // @notice APR decimal precision (always `12` for SD7x12).
    function decimals() external view returns (uint8);
}
