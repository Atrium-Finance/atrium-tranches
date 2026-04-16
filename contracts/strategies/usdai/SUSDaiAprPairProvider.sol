// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SUSDaiAprPairProvider
//  Strata-compatible APR pair provider for sUSDai market (Arbitrum)
//  See: docs/PV_V3_APR_ORACLE.md section 3
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IStrategyAprPairProvider} from "../../interfaces/IAprPairFeed.sol";

/**
 * @dev Minimal Aave v3 Pool interface — aTokenAddress read from getReserveData (not hardcoded).
 */
interface IAavePool {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
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

/**
 * @title SUSDaiAprPairProvider
 * @notice Computes (aprTarget, aprBase) for sUSDai market in Strata-compatible format.
 * @dev Design fixes vs naive Strata copy:
 *      #1 TWO entry points: getAprPair() (mutate) + getAprPairView() (view)
 *      #2 aTokenAddress read from Aave getReserveData(), not hardcoded
 *      #3 Benchmark APR capped at BENCHMARK_MAX (40%)
 *      #4 Strategy APR clamped to [APR_MIN, APR_MAX] before int64 cast
 *      Returns int64 × 12 decimals. 1% = 1e10.
 */
contract SUSDaiAprPairProvider is IStrategyAprPairProvider {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct RateSnapshot {
        uint256 rate;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 private constant RAY_TO_12DEC = 1e15;       // 1e27 → 1e12
    uint256 private constant PRECISION = 1e12;
    uint256 private constant YEAR = 365 days;
    int256 private constant APR_MIN = -500_000_000_000;  // -50% in 12dec
    int256 private constant APR_MAX = 2_000_000_000_000; // +200% in 12dec
    int64 public constant BENCHMARK_MAX = 400_000_000_000; // 40% in 12dec

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAavePool public immutable i_aavePool;
    IERC4626 public immutable i_vault;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    address[] public s_benchmarkTokens;
    RateSnapshot public s_prevSnapshot;
    RateSnapshot public s_latestSnapshot;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event SnapshotShifted(uint256 prevRate, uint256 newRate, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param aavePool_ Aave v3 Pool address
     * @param benchmarkTokens_ Array of underlying tokens for benchmark (e.g., [USDC, USDT])
     * @param vault_ ERC-4626 vault address (e.g., sUSDai)
     */
    constructor(address aavePool_, address[] memory benchmarkTokens_, address vault_) {
        i_aavePool = IAavePool(aavePool_);
        i_vault = IERC4626(vault_);

        for (uint256 i = 0; i < benchmarkTokens_.length; i++) {
            s_benchmarkTokens.push(benchmarkTokens_[i]);
        }

        // Seed first snapshot
        uint256 currentRate = IERC4626(vault_).convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});
    }

    // ═══════════════════════════════════════════════════════════════════
    //  getAprPair — STATE-CHANGING (shifts snapshots)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Compute APR pair and shift snapshots. Called by AprPairFeed PULL update.
     * @dev Shifts prev ← latest, latest ← current live rate.
     */
    function getAprPair() external override returns (int64 aprTarget, int64 aprBase, uint64 timestamp) {
        aprTarget = _computeBenchmarkApr();

        // Shift snapshots
        uint256 prevRate = s_latestSnapshot.rate;
        uint256 prevTimestamp = s_latestSnapshot.timestamp;

        s_prevSnapshot = s_latestSnapshot;
        uint256 currentRate = i_vault.convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});

        emit SnapshotShifted(prevRate, currentRate, block.timestamp);

        aprBase = _computeStrategyApr(currentRate, prevRate, prevTimestamp);
        timestamp = uint64(block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  getAprPairView — PURE VIEW (no snapshot shift)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Read current APR pair without modifying state.
     * @dev Uses existing s_prevSnapshot and s_latestSnapshot. No shift.
     *      Called by AprPairFeed.latestRoundData() fallback and setProvider() compat check.
     */
    function getAprPairView() external view override returns (int64 aprTarget, int64 aprBase, uint64 timestamp) {
        aprTarget = _computeBenchmarkApr();
        aprBase = _computeStrategyApr(s_latestSnapshot.rate, s_prevSnapshot.rate, s_prevSnapshot.timestamp);
        timestamp = uint64(s_latestSnapshot.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — Benchmark APR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Compute Aave supply-weighted average APR from benchmarkTokens[].
     *      aTokenAddress read from getReserveData (fix #2). Capped at BENCHMARK_MAX (fix #3).
     */
    function _computeBenchmarkApr() internal view returns (int64) {
        uint256 weightedSum;
        uint256 totalSupply;

        for (uint256 i = 0; i < s_benchmarkTokens.length; i++) {
            address token = s_benchmarkTokens[i];
            IAavePool.ReserveData memory data = i_aavePool.getReserveData(token);

            uint256 rate = uint256(data.currentLiquidityRate) / RAY_TO_12DEC;
            uint256 supply = IERC20(data.aTokenAddress).totalSupply();

            weightedSum += supply * rate;
            totalSupply += supply;
        }

        if (totalSupply == 0) return 0;

        int64 apr = int64(int256(weightedSum / totalSupply));

        // Cap at BENCHMARK_MAX (fix #3)
        if (apr > BENCHMARK_MAX) apr = BENCHMARK_MAX;

        return apr;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — Strategy APR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Compute annualized growth between two rate points.
     *      Supports negative APR. Clamped to [APR_MIN, APR_MAX] before int64 cast (fix #4).
     */
    function _computeStrategyApr(uint256 currentRate, uint256 prevRate, uint256 prevTimestamp) internal view returns (int64) {
        if (prevTimestamp == 0 || prevRate == 0) return 0;

        uint256 deltaT;
        // For view path: compare latest vs prev snapshot timestamps
        if (currentRate == s_latestSnapshot.rate && s_latestSnapshot.timestamp > prevTimestamp) {
            deltaT = s_latestSnapshot.timestamp - prevTimestamp;
        } else {
            // For mutate path: compare block.timestamp vs prevTimestamp
            deltaT = block.timestamp - prevTimestamp;
        }

        if (deltaT == 0) return 0;

        // Growth = (currentRate - prevRate) * PRECISION / prevRate (supports negative)
        int256 growth = (int256(currentRate) - int256(prevRate)) * int256(PRECISION) / int256(prevRate);
        // APR = growth × YEAR / deltaT
        int256 apr = growth * int256(YEAR) / int256(deltaT);

        // Clamp to bounds before int64 cast (fix #4 — prevents silent overflow)
        if (apr < APR_MIN) apr = APR_MIN;
        if (apr > APR_MAX) apr = APR_MAX;

        return int64(apr);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Number of benchmark tokens configured. */
    function benchmarkTokenCount() external view returns (uint256) {
        return s_benchmarkTokens.length;
    }
}
