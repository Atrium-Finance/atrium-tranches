// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  IsUSDai
 * @notice External view + sync-deposit surface of USD.AI's sUSDai vault
 *         as actually deployed on Arbitrum mainnet. sUSDai is an
 *         ERC-7540 async vault — synchronous deposit, asynchronous
 *         redeem through a queued epoch. ERC-4626 preview methods
 *         (`previewDeposit`/`previewMint`/`previewRedeem`/`previewWithdraw`)
 *         are deliberately disabled on-chain (pure stubs reverting
 *         `DisabledImplementation()`) — Atrium MUST NOT call them.
 * @dev    Use {convertToAssets} / {convertToShares} for non-binding
 *         valuation hints, and {depositSharePrice} for APR sampling.
 *
 *         Atrium does NOT initiate the async redeem flow on sUSDai —
 *         withdraws are served from Atrium's own ERC20Cooldown silo
 *         which moves sUSDai shares to the user; users self-claim
 *         USDai through USD.AI's epoch.
 */
interface IsUSDai is IERC20 {
    /// @notice Underlying asset (USDai) of the vault.
    function asset() external view returns (address);

    /// @notice Synchronously deposit `assets` of underlying, mint shares
    ///         to `receiver`. Deposit stays synchronous under ERC-7540 —
    ///         only redeem is async.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /// @notice Convert sUSDai shares to USDai assets at the conservative
    ///         NAV (rounding direction is implementation-defined,
    ///         typically Floor). Non-binding — actual redemption goes
    ///         through the async epoch.
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /// @notice Convert USDai assets to sUSDai shares at the conservative
    ///         NAV (rounding direction is implementation-defined).
    function convertToShares(uint256 assets) external view returns (uint256 shares);

    /// @notice Total USDai under management at conservative valuation.
    ///         Used as a rough TVL signal.
    function totalAssets() external view returns (uint256);

    /// @notice Share price applied to NEW deposits (optimistic NAV).
    ///         Used by Atrium's APR provider as the sampling source —
    ///         linear delta over time annualises into the base APR.
    function depositSharePrice() external view returns (uint256);

    /// @notice Share price applied when servicing redemptions
    ///         (conservative NAV). Reported for completeness.
    function redemptionSharePrice() external view returns (uint256);

    /// @notice Net asset value of the vault, conservative valuation.
    function nav() external view returns (uint256);
}
