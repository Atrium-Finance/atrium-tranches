// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — TrancheVault
//  Generic ERC-4626 vault. Same bytecode deployed 3× per market.
//  See: docs/PV_V3_FINAL_v34.md section 19
// ══════════════════════════════════════════════════════════════════════

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPrimeCDO, TrancheId, CooldownType, CDOWithdrawResult } from "../interfaces/IPrimeCDO.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";

/**
 * @title TrancheVault
 * @notice Generic ERC-4626 vault for a single tranche (Senior, Mezzanine, or Junior).
 * @dev Same bytecode deployed 3× per market. Junior mode detected via i_trancheId == JUNIOR.
 *      totalAssets() reads from Accounting (not token balance).
 *      Deposits route through PrimeCDO. Standard withdraw/redeem disabled — use requestWithdraw.
 *      See MATH_REFERENCE §A1-A3 for share price invariants.
 */
contract TrancheVault is ERC4626 {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IPrimeCDO public immutable i_cdo;
    TrancheId public immutable i_trancheId;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event WithdrawRequested(
        address indexed owner,
        address indexed receiver,
        uint256 shares,
        uint256 baseAmount,
        CDOWithdrawResult result
    );

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__UseRequestWithdraw();
    error PrimeVaults__ZeroShares();

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param cdo_ Address of the paired PrimeCDO
     * @param trancheId_ Tranche this vault represents (SENIOR, MEZZ, or JUNIOR)
     * @param asset_ Base asset token (e.g., USDai)
     * @param name_ Vault share token name (e.g., "PrimeVaults Senior")
     * @param symbol_ Vault share token symbol (e.g., "pvSENIOR")
     */
    constructor(
        address cdo_,
        TrancheId trancheId_,
        address asset_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(IERC20(asset_)) {
        i_cdo = IPrimeCDO(cdo_);
        i_trancheId = trancheId_;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 OVERRIDES — totalAssets
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Total assets for this tranche, read from Accounting.
     * @dev See MATH_REFERENCE §A1. Not based on token balance — Accounting is the source of truth.
     *      Returns 0 when no shares outstanding to prevent ERC4626 share inflation from
     *      dust TVL residuals (Accounting may have tiny non-zero TVL after all shares burned).
     */
    function totalAssets() public view override returns (uint256) {
        if (totalSupply() == 0) return 0;
        return IAccounting(i_cdo.accounting()).getTrancheTVL(i_trancheId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 OVERRIDES — deposit (all tranches)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit base asset into any tranche.
     * @dev Overrides ERC4626.deposit to route through CDO.
     *      Share price invariant: sharePrice_before == sharePrice_after (see MATH_REFERENCE §A2).
     */
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        uint256 shares = previewDeposit(assets);

        // 1. Pull base asset from depositor to vault
        SafeERC20.safeTransferFrom(IERC20(asset()), _msgSender(), address(this), assets);

        // 2. Approve CDO and route deposit
        IERC20(asset()).forceApprove(address(i_cdo), assets);
        i_cdo.deposit(i_trancheId, asset(), assets);

        // 3. Mint shares
        _mint(receiver, shares);

        emit Deposit(_msgSender(), receiver, assets, shares);
        return shares;
    }

    /**
     * @notice Mint exact shares by depositing the required base assets.
     */
    function mint(uint256 shares, address receiver) public override returns (uint256) {

        uint256 assets = previewMint(shares);

        SafeERC20.safeTransferFrom(IERC20(asset()), _msgSender(), address(this), assets);
        IERC20(asset()).forceApprove(address(i_cdo), assets);
        i_cdo.deposit(i_trancheId, asset(), assets);

        _mint(receiver, shares);

        emit Deposit(_msgSender(), receiver, assets, shares);
        return assets;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 OVERRIDES — withdraw/redeem DISABLED
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Standard ERC-4626 withdraw disabled. Use requestWithdraw() instead.
     *      Withdrawals may involve cooldown periods incompatible with sync ERC-4626.
     */
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert PrimeVaults__UseRequestWithdraw();
    }

    /**
     * @dev Standard ERC-4626 redeem disabled. Use requestWithdraw() instead.
     */
    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert PrimeVaults__UseRequestWithdraw();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW — requestWithdraw (all tranches)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request withdrawal by redeeming vault shares.
     * @dev Burns shares for NONE/ASSETS_LOCK mechanisms. Escrows shares for SHARES_LOCK.
     *      All tranches route to CDO.requestWithdraw.
     *      Always withdraws the underlying yield token (sUSDai) — no outputToken selection.
     * @param shares Number of vault shares to redeem
     * @param receiver Address to receive withdrawn tokens
     * @return result CDO withdrawal result with mechanism details
     */
    function requestWithdraw(
        uint256 shares,
        address receiver
    ) external returns (CDOWithdrawResult memory result) {
        if (shares == 0) revert PrimeVaults__ZeroShares();

        address owner = _msgSender();

        // Full drain: use exact TVL to prevent dust residual from ERC4626 virtual shares
        uint256 baseAmount = shares == totalSupply() ? totalAssets() : convertToAssets(shares);

        // Transfer shares from owner to vault (for CDO to potentially pull in SharesLock)
        _transfer(owner, address(this), shares);
        _approve(address(this), address(i_cdo), shares);

        result = i_cdo.requestWithdraw(i_trancheId, baseAmount, receiver, shares);

        // SHARES_LOCK (type 3): CDO already pulled shares for escrow — do NOT burn
        // All other types: CDO did not pull shares — burn them
        if (result.appliedCooldownType != CooldownType.SHARES_LOCK) {
            _burn(address(this), shares);
        }

        emit WithdrawRequested(owner, receiver, shares, baseAmount, result);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CLAIM — pass-through to CDO
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim a completed ERC20Cooldown (ASSETS_LOCK) withdrawal.
     * @dev Delegates to CDO.claimWithdraw. Callable by anyone.
     * @param cooldownId The cooldown request ID
     * @param cooldownHandler Address of the cooldown handler
     * @return amountOut Tokens transferred to beneficiary
     */
    function claimWithdraw(uint256 cooldownId, address cooldownHandler) external returns (uint256 amountOut) {
        return i_cdo.claimWithdraw(cooldownId, cooldownHandler);
    }

    /**
     * @notice Claim a completed SharesCooldown (SHARES_LOCK) withdrawal.
     * @dev Delegates to CDO.claimSharesWithdraw. Callable by anyone.
     *      Always withdraws the underlying yield token (sUSDai).
     *      CDO burns the returned shares via burnSharesFrom after processing.
     * @param cooldownId The SharesCooldown request ID
     * @return amountOut Tokens transferred to beneficiary
     */
    function claimSharesWithdraw(uint256 cooldownId) external returns (uint256 amountOut) {
        return i_cdo.claimSharesWithdraw(cooldownId);
    }

    /**
     * @notice Burn shares held by an address. Only callable by the paired CDO.
     * @dev Used by CDO.claimSharesWithdraw to burn shares returned from SharesCooldown.
     * @param account Address holding the shares to burn
     * @param shares Number of shares to burn
     */
    function burnSharesFrom(address account, uint256 shares) external {
        if (msg.sender != address(i_cdo)) revert PrimeVaults__UseRequestWithdraw();
        _burn(account, shares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — maxDeposit / maxWithdraw overrides
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Returns 0 for withdraw/redeem since standard ERC-4626 path is disabled.
     */
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    /**
     * @dev Returns 0 for redeem since standard ERC-4626 path is disabled.
     */
    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }
}
