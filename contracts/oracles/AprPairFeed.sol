// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — AprPairFeed
//  Manages and provides APR pair (aaveBenchmarkAPR, strategyAPR) data.
//  See: docs/PV_V3_APR_ORACLE.md section 3
// ══════════════════════════════════════════════════════════════════════

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IAprPairFeed, IStrategyAprPairProvider } from "../interfaces/IAprPairFeed.sol";

/**
 * @title AprPairFeed
 * @notice Manages and provides APR pair (aaveBenchmarkAPR, strategyAPR) data.
 * @dev APR data has two sources:
 *      1. External (PUSH): APRs pushed directly by authorized observers (KEEPER_ROLE)
 *      2. Strategy (PULL): APRs fetched from on-chain provider (PrimeCDO auto-pulls on deposit/withdraw)
 *      The feed prefers PUSH/PULL cached data, but falls back to provider view if cache is stale.
 *      20-round circular buffer. Bounds [-50%, +200%]. int64 × 12 decimals.
 */
contract AprPairFeed is IAprPairFeed, AccessControl {
    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    int64 private constant APR_BOUNDARY_MAX = 2e12; // 200%
    int64 private constant APR_BOUNDARY_MIN = -0.5e12; // -50%
    uint64 private constant MAX_FUTURE_DRIFT = 60;
    uint8 public constant ROUNDS_CAP = 20;
    uint8 public constant DECIMALS = 12;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint64 public s_currentRoundId;
    uint64 public s_oldestRoundId;
    TRound public s_latestRound;
    mapping(uint256 => TRound) public s_rounds;
    uint256 public s_roundStaleAfter;
    IStrategyAprPairProvider public s_provider;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event RoundUpdated(uint64 roundId, int64 aprTarget, int64 aprBase, uint64 updatedAt);
    event ProviderSet(address newProvider);
    event StalePeriodSet(uint256 stalePeriod);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__StaleUpdate(int64 aprTarget, int64 aprBase, uint64 timestamp);
    error PrimeVaults__OutOfOrderUpdate(int64 aprTarget, int64 aprBase, uint64 timestamp);
    error PrimeVaults__InvalidApr(int64 value);
    error PrimeVaults__RoundNotAvailable(uint64 roundId);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address admin_, IStrategyAprPairProvider provider_, uint256 roundStaleAfter_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        s_provider = provider_;
        s_roundStaleAfter = roundStaleAfter_;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  READ — Accounting calls this
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get latest APR pair — cache if fresh, provider view if stale.
     * @dev Fallback calls getAprPairView() (view, no state mutation).
     */
    function latestRoundData() external view override returns (TRound memory) {
        TRound memory round = s_latestRound;

        if (round.updatedAt > 0) {
            uint256 deltaT = block.timestamp - uint256(round.updatedAt);
            if (deltaT < s_roundStaleAfter) {
                return round;
            }
        }

        // Cache stale or empty → fallback to provider view
        (int64 aprTarget, int64 aprBase, uint64 t1) = s_provider.getAprPairView();
        _ensureValid(aprTarget);
        _ensureValid(aprBase);

        return TRound({ aprTarget: aprTarget, aprBase: aprBase, updatedAt: t1, answeredInRound: s_currentRoundId + 1 });
    }

    /**
     * @notice Get historical round by ID.
     * @param roundId The round to retrieve
     */
    function getRoundData(uint64 roundId) external view override returns (TRound memory) {
        if (roundId == 0 || roundId < s_oldestRoundId || roundId > s_currentRoundId) {
            revert PrimeVaults__RoundNotAvailable(roundId);
        }
        uint256 idx = (roundId - 1) % ROUNDS_CAP;
        return s_rounds[idx];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UPDATE — PULL (from on-chain provider)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Pull APR from provider — shifts snapshots + caches result.
     * @dev Called by PrimeCDO on every deposit/withdraw (auto-pull), or by keeper.
     *      Provider.getAprPair() is state-changing (shifts sUSDai rate snapshots).
     */
    function updateRoundData() external override onlyRole(KEEPER_ROLE) {
        (int64 aprTarget, int64 aprBase, uint64 t) = s_provider.getAprPair();
        _storeRound(aprTarget, aprBase, t);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _storeRound(int64 aprTarget, int64 aprBase, uint64 t) internal {
        if (uint256(t) < block.timestamp - s_roundStaleAfter) {
            revert PrimeVaults__StaleUpdate(aprTarget, aprBase, t);
        }
        if (
            s_latestRound.updatedAt > 0 &&
            (t <= s_latestRound.updatedAt || uint256(t) > block.timestamp + MAX_FUTURE_DRIFT)
        ) {
            revert PrimeVaults__OutOfOrderUpdate(aprTarget, aprBase, t);
        }
        _ensureValid(aprTarget);
        _ensureValid(aprBase);

        s_currentRoundId++;
        uint256 idx = (s_currentRoundId - 1) % ROUNDS_CAP;

        TRound memory round = TRound({
            aprTarget: aprTarget,
            aprBase: aprBase,
            updatedAt: t,
            answeredInRound: s_currentRoundId
        });

        s_latestRound = round;
        s_rounds[idx] = round;

        if (s_currentRoundId > uint64(ROUNDS_CAP)) {
            s_oldestRoundId = s_currentRoundId - uint64(ROUNDS_CAP) + 1;
        } else if (s_oldestRoundId == 0) {
            s_oldestRoundId = 1;
        }

        emit RoundUpdated(s_currentRoundId, aprTarget, aprBase, t);
    }

    function _ensureValid(int64 answer) internal pure {
        if (answer < APR_BOUNDARY_MIN || answer > APR_BOUNDARY_MAX) {
            revert PrimeVaults__InvalidApr(answer);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set a new provider. Calls getAprPairView() for compat check (view, no side effect).
     */
    function setProvider(IStrategyAprPairProvider provider_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (int64 aprTarget, int64 aprBase, ) = provider_.getAprPairView();
        _ensureValid(aprTarget);
        _ensureValid(aprBase);
        s_provider = provider_;
        emit ProviderSet(address(provider_));
    }

    /**
     * @notice Update the staleness threshold.
     */
    function setRoundStaleAfter(uint256 roundStaleAfter_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        s_roundStaleAfter = roundStaleAfter_;
        emit StalePeriodSet(roundStaleAfter_);
    }
}
