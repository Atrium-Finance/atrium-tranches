// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IPrimeCDO
//  Core orchestrator interface (1 CDO = 1 Strategy)
//  See: docs/PV_V3_FINAL_v34.md section 18
// ══════════════════════════════════════════════════════════════════════

/** @notice Identifies which tranche a vault belongs to */
enum TrancheId {
    SENIOR,
    MEZZ,
    JUNIOR
}

/** @notice Cooldown mechanism applied to a withdrawal */
enum CooldownType {
    NONE,         // 0 — instant withdrawal
    ASSETS_LOCK,  // 1 — sUSDai locked in ERC20Cooldown
    SHARES_LOCK   // 2 — vault shares escrowed in SharesCooldown
}

/** @notice Result returned by CDO withdrawal operations */
struct CDOWithdrawResult {
    bool isInstant;
    uint256 amountOut;
    uint256 cooldownId;
    address cooldownHandler;
    uint256 unlockTime;
    uint256 feeAmount;
    CooldownType appliedCooldownType;
}

/**
 * @title IPrimeCDO
 * @notice Interface for the PrimeCDO orchestrator contract
 * @dev Core contract connecting TrancheVaults to a single Strategy via Accounting.
 *      Handles deposit routing, withdrawal with coverage gates, and cooldown management.
 */
interface IPrimeCDO {
    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit base asset into any tranche
     * @dev Only callable by the registered TrancheVault for the given tranche.
     *      Updates accounting, routes tokens directly to strategy, records deposit.
     *      Reverts if coverage < 105% for Senior/Mezz (coverage gate).
     *      Reverts if protocol is shortfall-paused.
     * @param tranche Target tranche (SENIOR, MEZZ, or JUNIOR)
     * @param token Deposit token address (must be in strategy.supportedTokens())
     * @param amount Token amount to deposit
     * @return baseAmount Base-asset-equivalent value deposited (used for share calculation)
     */
    function deposit(TrancheId tranche, address token, uint256 amount) external returns (uint256 baseAmount);

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request withdrawal from any tranche
     * @dev Only callable by the registered TrancheVault. Queries RedemptionPolicy for
     *      cooldown type, applies fees if any, routes through appropriate cooldown handler.
     *      Always withdraws the underlying yield token (sUSDai) — no outputToken selection.
     *      See docs/PV_V3_COVERAGE_GATE.md for coverage-dependent mechanism selection.
     * @param tranche Tranche to withdraw from (SENIOR, MEZZ, or JUNIOR)
     * @param baseAmount Base-equivalent amount to withdraw
     * @param beneficiary Address that will receive withdrawn tokens
     * @param vaultShares Vault shares being redeemed (for SharesLock accounting)
     * @return result Struct with withdrawal outcome, cooldown details, and fees
     */
    function requestWithdraw(TrancheId tranche, uint256 baseAmount, address beneficiary, uint256 vaultShares) external returns (CDOWithdrawResult memory result);

    /**
     * @notice Claim a completed ERC20Cooldown (ASSETS_LOCK) withdrawal
     * @dev Callable by anyone (beneficiary or on their behalf).
     * @param cooldownId The cooldown request ID to claim
     * @param cooldownHandler Address of the cooldown handler contract holding the request
     * @return amountOut Amount of tokens transferred to the beneficiary
     */
    function claimWithdraw(uint256 cooldownId, address cooldownHandler) external returns (uint256 amountOut);

    /**
     * @notice Claim a completed SharesCooldown (SHARES_LOCK) withdrawal
     * @dev Callable by anyone. Claims shares from SharesCooldown → CDO receives shares →
     *      CDO converts to base amount at current exchange rate → withdraws from strategy → sends to beneficiary.
     *      User benefits from yield accrued during the cooldown period.
     *      Always withdraws the underlying yield token (sUSDai).
     * @param cooldownId The SharesCooldown request ID to claim
     * @return amountOut Amount of sUSDai transferred to the beneficiary
     */
    function claimSharesWithdraw(uint256 cooldownId) external returns (uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Address of the Accounting contract for this market
     * @return The Accounting contract address
     */
    function accounting() external view returns (address);

    /**
     * @notice Address of the Strategy contract for this market
     * @return The Strategy contract address
     */
    function strategy() external view returns (address);

    /**
     * @notice Address of the output token (e.g. sUSDai) for this market
     * @return The output token address
     */
    function i_outputToken() external view returns (address);
}
