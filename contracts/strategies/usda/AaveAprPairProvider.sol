// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AccessControlled } from "../../governance/AccessControlled.sol";
import { IStrategyAprProvider } from "../../interfaces/oracles/IStrategyAprProvider.sol";
import { IsUSDai } from "../../interfaces/external/IsUSDai.sol";
import { IAavePool } from "../../interfaces/external/IAavePool.sol";

/**
 * @title  AaveAprPairProvider
 * @notice Spot APR provider for the USDAStrategy. Wired into AprPairFeed
 *         as the PULL fallback.
 *         - `aprTarget` is the supply-weighted average of Aave V3 supply
 *           APRs across a curated benchmark basket (e.g. USDC, USDT).
 *         - `aprBase` is derived from sUSDai's active vesting window:
 *           unvested yield annualised over the remaining vesting time.
 * @dev    APR encoding: int64, 12 decimals.
 *         Strategy delegates ALL APR logic here — this is a pure
 *         provider, independent of the Strategy's own state.
 */
contract AaveAprPairProvider is IStrategyAprProvider, AccessControlled {
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice USD.AI sUSDai vesting window length. Matches the vault's
    ///         hardcoded distribution cadence.
    uint256 public constant VESTING_PERIOD = 8 hours;

    /// @notice Sr floor APR ceiling: 40% in 12-decimal SD7x12.
    int64 public constant APR_TARGET_MAX = 0.4e12;

    /// @notice Lower bound on aprTarget. Aave supply APR is non-negative.
    int64 public constant APR_TARGET_MIN = 0;

    /// @notice Clamp on aprBase before the int64 cast: 200% in 18-dec.
    ///         Output is divided by 1e6 → fits comfortably in int64.
    uint256 public constant APR_BASE_CLAMP_18 = 2e18;

    /// @notice Cap on the benchmark basket size for `setBenchmarkTokens`.
    uint256 public constant MAX_BENCHMARK_TOKENS = 8;

    // ---------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------

    IsUSDai public immutable sUSDai;
    IAavePool public immutable aave;

    // ---------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------

    IERC20[] private _benchmarkTokens;

    uint256[49] private __gap;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event BenchmarkTokensSet(IERC20[] tokens);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error InvalidAprAvg(int64 value);
    error EmptyBenchmark();
    error InvalidBenchmarkToken(address token);
    error TooManyBenchmarkTokens(uint256 given);

    // ---------------------------------------------------------------
    // Initialiser
    // ---------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IsUSDai sUSDai_, IAavePool aave_) {
        if (address(sUSDai_) == address(0) || address(aave_) == address(0)) {
            revert ZeroAddress();
        }
        sUSDai = sUSDai_;
        aave = aave_;
    }

    function initialize(address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
    }

    // ---------------------------------------------------------------
    // IStrategyAprProvider
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IStrategyAprProvider
     * @dev `aprTarget` is always evaluated — the Sr floor is policy, not
     *      market data, so it is returned unconditionally (even when
     *      `aprBase = 0` from insufficient vesting data).
     */
    function getApr() external view override returns (int64 aprBase, int64 aprTarget, uint64 updatedAt) {
        aprTarget = _computeAprTarget();
        aprBase = _computeAprBase();
        updatedAt = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /**
     * @notice Replace the benchmark basket atomically.
     * @dev    Each token must have a valid Aave V3 reserve
     *         (`aTokenAddress != 0`). Gated by
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

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function benchmarkTokens() external view returns (IERC20[] memory) {
        return _benchmarkTokens;
    }

    function benchmarkTokensLength() external view returns (uint256) {
        return _benchmarkTokens.length;
    }

    // ---------------------------------------------------------------
    // Internal — APR target (Aave weighted average)
    // ---------------------------------------------------------------

    /**
     * @dev aprAvg = Σ(apr_i × supply_i) / Σ(supply_i)
     *      apr_i  = aave.getReserveData(token_i).currentLiquidityRate / 1e15  // RAY → 12-dec
     *      supply_i = aToken.totalSupply()
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

        // aprAvg ≤ uint64(APR_TARGET_MAX) ensures the int64 cast below is
        // safe. APR_TARGET_MAX = 4e11 fits well within int64 range.
        if (aprAvg > uint256(uint64(APR_TARGET_MAX))) {
            revert InvalidAprAvg(int64(int256(aprAvg)));
        }

        return int64(int256(aprAvg));
    }

    // ---------------------------------------------------------------
    // Internal — APR base (sUSDai vesting)
    // ---------------------------------------------------------------

    /**
     * @dev apr18 = unvested × SECONDS_PER_YEAR × 1e18
     *              / (VESTING_PERIOD - elapsed)
     *              / totalAssets
     *      apr12 = apr18 / 1e6
     *
     *      Returns 0 (with aprTarget still emitted) when:
     *      - block.timestamp <= lastDistributionTimestamp (clock drift)
     *      - elapsed >= VESTING_PERIOD (fully vested)
     *      - unvested == 0
     *      - totalAssets == 0
     */
    function _computeAprBase() internal view returns (int64) {
        uint256 lastTs = sUSDai.lastDistributionTimestamp();
        if (block.timestamp <= lastTs) return 0;

        uint256 elapsed = block.timestamp - lastTs;
        if (elapsed >= VESTING_PERIOD) return 0;

        uint256 unvested = sUSDai.unvestedAmount();
        if (unvested == 0) return 0;

        uint256 totalAssets_ = sUSDai.totalAssets();
        if (totalAssets_ == 0) return 0;

        uint256 remaining = VESTING_PERIOD - elapsed;

        uint256 apr18 = (unvested * SECONDS_PER_YEAR * 1e18) / remaining / totalAssets_;

        if (apr18 > APR_BASE_CLAMP_18) apr18 = APR_BASE_CLAMP_18;

        return int64(int256(apr18 / 1e6));
    }
}
