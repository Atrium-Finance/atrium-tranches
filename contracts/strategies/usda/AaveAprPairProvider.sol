// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AccessControlled } from "../../governance/AccessControlled.sol";
import { IStrategyAprProvider } from "../../interfaces/oracles/IStrategyAprProvider.sol";
import { IsUSDai } from "../../interfaces/external/IsUSDai.sol";
import { IAavePool } from "../../interfaces/external/IAavePool.sol";

/**
 * @title  AaveAprPairProvider
 * @notice Spot APR provider wired into {AprPairFeed} as the PULL
 *         fallback. `aprTarget` is the supply-weighted Aave V3
 *         supply-APR across a curated benchmark basket; `aprBase` is
 *         derived from sUSDai's `depositSharePrice` growth between
 *         keeper-driven samples.
 * @dev    APR encoding: int64, 12 decimals.
 */
contract AaveAprPairProvider is IStrategyAprProvider, AccessControlled {
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // @notice Sr floor APR ceiling — 40% (SD7x12).
    int64 public constant APR_TARGET_MAX = 0.4e12;

    // @notice Aave supply APR is non-negative.
    int64 public constant APR_TARGET_MIN = 0;

    /**
     * @notice Upper clamp on aprBase before the int64 cast: +200% in
     *         18-dec. Matches the {AprPairFeed} `_ensureValid` window.
     */
    int256 public constant APR_BASE_CLAMP_18 = 2e18;

    /**
     * @notice Lower clamp on aprBase: -50% in 18-dec. A sUSDai
     *         write-down (loan default, NAV revision) yields a real
     *         negative growth rate that must propagate to the feed.
     */
    int256 public constant APR_BASE_FLOOR_18 = -0.5e18;

    // @notice Cap on the benchmark basket size.
    uint256 public constant MAX_BENCHMARK_TOKENS = 8;

    IsUSDai public immutable sUSDai;
    IAavePool public immutable aave;

    IERC20[] private _benchmarkTokens;

    /**
     * @notice Last sUSDai `depositSharePrice` snapshot. `0` means
     *         "no sample yet" — aprBase returns 0 until first sample.
     */
    uint256 public lastSample;

    /**
     * @notice Timestamp paired with {lastSample} to compute the
     *         annualised growth rate in {_computeAprBase}.
     */
    uint64 public lastSampleAt;

    uint256[47] private __gap;

    event BenchmarkTokensSet(IERC20[] tokens);
    event SampleRecorded(uint256 sample, uint64 atTimestamp);

    error InvalidAprAvg(int64 value);
    error EmptyBenchmark();
    error InvalidBenchmarkToken(address token);
    error TooManyBenchmarkTokens(uint256 given);

    // @custom:oz-upgrades-unsafe-allow constructor
    constructor(IsUSDai sUSDai_, IAavePool aave_) {
        if (address(sUSDai_) == address(0) || address(aave_) == address(0)) {
            revert ZeroAddress();
        }
        sUSDai = sUSDai_;
        aave = aave_;
    }

    function initialize(address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
        // Bootstrap a baseline sample so the very first PULL doesn't
        // return zero. Skipped (no revert) when sUSDai returns 0 at
        // deploy time, so the keeper must explicitly call `sampleRate()`
        // before APR readings become meaningful.
        uint256 price = sUSDai.depositSharePrice();
        if (price > 0) {
            lastSample = price;
            lastSampleAt = uint64(block.timestamp);
            emit SampleRecorded(price, uint64(block.timestamp));
        }
    }

    /**
     * @inheritdoc IStrategyAprProvider
     * @dev    `aprTarget` is policy (not market data) and is always
     *         evaluated, even when `aprBase == 0`.
     */
    function getApr() external view override returns (int64 aprBase, int64 aprTarget, uint64 updatedAt) {
        aprTarget = _computeAprTarget();
        aprBase = _computeAprBase();
        updatedAt = uint64(block.timestamp);
    }

    /**
     * @notice Atomically replace the benchmark basket. Each token
     *         must have a valid Aave V3 reserve. Gated by
     *         `UPDATER_STRAT_CONFIG_ROLE`.
     */
    function setBenchmarkTokens(IERC20[] calldata tokens) external onlyRole(UPDATER_STRAT_CONFIG_ROLE) {
        uint256 len = tokens.length;
        if (len == 0) revert EmptyBenchmark();
        if (len > MAX_BENCHMARK_TOKENS) revert TooManyBenchmarkTokens(len);

        for (uint256 i; i < len; ) {
            IAavePool.ReserveData memory data = aave.getReserveData(address(tokens[i]));
            if (data.aTokenAddress == address(0)) {
                revert InvalidBenchmarkToken(address(tokens[i]));
            }
            unchecked {
                ++i;
            }
        }

        delete _benchmarkTokens;
        for (uint256 i; i < len; ) {
            _benchmarkTokens.push(tokens[i]);
            unchecked {
                ++i;
            }
        }

        emit BenchmarkTokensSet(tokens);
    }

    function benchmarkTokens() external view returns (IERC20[] memory) {
        return _benchmarkTokens;
    }

    function benchmarkTokensLength() external view returns (uint256) {
        return _benchmarkTokens.length;
    }

    /**
     * @dev Supply-weighted average across the benchmark basket:
     *        apr_i    = aave.getReserveData(token_i).currentLiquidityRate / 1e15  // RAY → 12-dec
     *        supply_i = aToken_i.totalSupply()
     *        aprAvg   = Σ(apr_i × supply_i) / Σ(supply_i)
     */
    function _computeAprTarget() internal view returns (int64) {
        uint256 len = _benchmarkTokens.length;
        if (len == 0) revert EmptyBenchmark();

        uint256 weightedSum;
        uint256 totalWeight;

        for (uint256 i; i < len; ) {
            IAavePool.ReserveData memory data = aave.getReserveData(address(_benchmarkTokens[i]));

            uint256 apr12 = uint256(data.currentLiquidityRate) / 1e15;
            uint256 supply = IERC20(data.aTokenAddress).totalSupply();

            weightedSum += apr12 * supply;
            totalWeight += supply;

            unchecked {
                ++i;
            }
        }

        if (totalWeight == 0) revert InvalidAprAvg(0);

        uint256 aprAvg = weightedSum / totalWeight;

        if (aprAvg > uint256(uint64(APR_TARGET_MAX))) {
            revert InvalidAprAvg(int64(int256(aprAvg)));
        }

        return int64(int256(aprAvg));
    }

    /**
     * @notice Snapshot sUSDai's current `depositSharePrice` for the
     *         next aprBase calculation. Keeper-driven cadence: faster
     *         reacts to short-term moves, slower damps noise.
     */
    function sampleRate() external onlyRole(UPDATER_STRAT_CONFIG_ROLE) {
        uint256 price = sUSDai.depositSharePrice();
        uint64 nowTs = uint64(block.timestamp);
        lastSample = price;
        lastSampleAt = nowTs;
        emit SampleRecorded(price, nowTs);
    }

    /**
     * @dev Continuous yield model — sUSDai rebases continuously, so
     *      the average growth rate between two snapshots annualises
     *      linearly to the realised APR:
     *
     *        apr18 = (priceNow - priceSample) × SECONDS_PER_YEAR × 1e18
     *                / priceSample / dt              // signed
     *        apr12 = apr18 / 1e6                     // SD7x12
     *
     *      Signed: a price decrease (sUSDai write-down) is a real
     *      signal — reported as negative APR. Clamped to
     *      `[APR_BASE_FLOOR_18, APR_BASE_CLAMP_18]` = [-50%, +200%]
     *      so the int64 cast is safe and pathological one-block
     *      spikes don't propagate to Senior pricing.
     *
     *      Returns 0 when no sample exists yet or `dt == 0`.
     */
    function _computeAprBase() internal view returns (int64) {
        if (lastSampleAt == 0 || lastSample == 0) return 0;

        uint256 dt = block.timestamp - uint256(lastSampleAt);
        if (dt == 0) return 0;

        uint256 priceNow = sUSDai.depositSharePrice();

        int256 delta = int256(priceNow) - int256(lastSample);
        int256 apr18 = (delta * int256(SECONDS_PER_YEAR) * 1e18) / int256(lastSample) / int256(dt);

        if (apr18 > APR_BASE_CLAMP_18) apr18 = APR_BASE_CLAMP_18;
        if (apr18 < APR_BASE_FLOOR_18) apr18 = APR_BASE_FLOOR_18;

        return int64(apr18 / 1e6);
    }
}
