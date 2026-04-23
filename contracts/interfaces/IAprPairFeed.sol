// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IAprPairFeed
//  Strata-compatible APR oracle interfaces (int64 × 12 decimals)
//  See: docs/PV_V3_APR_ORACLE.md
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IStrategyAprPairProvider
 * @notice Interface for strategy-specific APR pair providers (Strata-compatible).
 * @dev Returns (aprTarget, aprBase) in int64 with 12 decimals.
 *      1% = 0.01 × 1e12 = 1e10. Supports negative APR (yield decrease).
 *      Two entry points:
 *        getAprPair()     — state-changing (shifts snapshots). Called by Feed updateRoundData().
 *        getAprPairView() — pure view (reads existing snapshots). Called by Feed latestRoundData() fallback.
 */
interface IStrategyAprPairProvider {
    /** @notice Shift snapshots + compute APRs (state-changing). Called by AprPairFeed.updateRoundData(). */
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp);

    /** @notice Read APRs from existing snapshots (pure view, no shift). Called by AprPairFeed.latestRoundData() fallback. */
    function getAprPairView() external view returns (int64 aprTarget, int64 aprBase, uint64 timestamp);
}

/**
 * @title IAprPairFeed
 * @notice Supports PULL (from provider) and PUSH (from keeper).
 * @dev Caches APR pair from provider. 20-round circular buffer.
 *      Accounting reads latestRoundData() to get current APR pair.
 */
interface IAprPairFeed {
    struct TRound {
        int64 aprTarget;
        int64 aprBase;
        uint64 updatedAt;
        uint64 answeredInRound;
    }

    function latestRoundData() external view returns (TRound memory);

    function getRoundData(uint64 roundId) external view returns (TRound memory);

    function updateRoundData() external;

    function pushRoundData(int64 aprTarget, int64 aprBase, uint64 timestamp) external;
}
