// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/**
 * @title  IAPRFeed
 * @notice Oracle-style feed contract exposing the latest Senior target APR
 *         and base APR pair. Consumed by Accounting via
 *         {Accounting.onAprChanged}.
 * @dev    Implementation is deferred to a future spec (08b'). Accounting
 *         tolerates `address(0)` as "feed disabled" — pulls become no-ops.
 */
interface IAPRFeed {
    /**
     * @notice Single round of feed data.
     * @dev    `aprTarget` and `aprBase` are encoded as signed 12-decimal
     *         compact integers (SD7x12); Accounting normalises them to
     *         UD60x18 via {Accounting._normalizeAprFromFeed}.
     */
    struct Round {
        uint80 roundId;
        int64 aprTarget;
        int64 aprBase;
        uint256 updatedAt;
    }

    /** @notice Returns the most recent round published by the feed. */
    function latestRoundData() external view returns (Round memory);

    /** @notice Returns the feed's APR decimal precision (always `12` for SD7x12). */
    function decimals() external view returns (uint8);
}
