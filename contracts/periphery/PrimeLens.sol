// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — PrimeLens
//  Read-only aggregator for frontend. No state changes.
//  See: docs/PV_V3_MVP_PLAN.md Step 21
// ══════════════════════════════════════════════════════════════════════

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { TrancheId } from "../interfaces/IPrimeCDO.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { ICooldownHandler, CooldownRequest, CooldownStatus } from "../interfaces/ICooldownHandler.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
import { RedemptionPolicy } from "../cooldown/RedemptionPolicy.sol";

/**
 * @dev Minimal interface for reading PrimeCDO public state.
 */
interface IPrimeCDOLens {
    function i_accounting() external view returns (IAccounting);
    function i_strategy() external view returns (IStrategy);
    function i_redemptionPolicy() external view returns (RedemptionPolicy);
    function i_erc20Cooldown() external view returns (ICooldownHandler);
    function i_sharesCooldown() external view returns (ICooldownHandler);
    function s_tranches(TrancheId id) external view returns (address);
    function s_minCoverageForDeposit() external view returns (uint256);
    function s_juniorShortfallPausePrice() external view returns (uint256);
    function s_shortfallPaused() external view returns (bool);
}

/**
 * @dev Minimal interface for reading TrancheVault ERC-4626 state.
 */
interface ITrancheVaultLens {
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

/**
 * @title PrimeLens
 * @notice Read-only aggregator for frontend. No state changes.
 * @dev Aggregates data from PrimeCDO, Accounting, TrancheVaults,
 *      RedemptionPolicy, and CooldownHandlers into convenient view functions.
 */
contract PrimeLens {
    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 private constant PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IPrimeCDOLens public immutable i_cdo;
    IAccounting public immutable i_accounting;
    IStrategy public immutable i_strategy;
    RedemptionPolicy public immutable i_redemptionPolicy;
    ICooldownHandler public immutable i_erc20Cooldown;
    ICooldownHandler public immutable i_sharesCooldown;
    address public immutable i_seniorVault;
    address public immutable i_mezzVault;
    address public immutable i_juniorVault;

    // ═══════════════════════════════════════════════════════════════════
    //  RETURN TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct TrancheInfo {
        TrancheId trancheId;
        address vault;
        string name;
        string symbol;
        uint256 totalAssets;
        uint256 totalSupply;
        uint256 sharePrice; // 18 decimals (1e18 = 1:1)
        uint256 apy; // 18 decimals
    }

    struct ProtocolHealth {
        uint256 seniorTVL;
        uint256 seniorPrincipal; // tracked sum of net Senior deposits (no accrued yield)
        uint256 seniorYield; // seniorTVL - seniorPrincipal (loss waterfall absorbs this before principal)
        uint256 mezzTVL;
        uint256 juniorTVL;
        uint256 totalTVL;
        uint256 coverageSenior; // cs = (Sr+Mz+Jr)/Sr
        uint256 coverageMezz; // cm = (Mz+Jr)/Mz
        uint256 minCoverageForDeposit;
        bool shortfallPaused;
        uint256 juniorShortfallPausePrice;
        uint256 strategyTVL;
    }

    struct PendingWithdraw {
        uint256 requestId;
        address handler;
        address beneficiary;
        address token;
        uint256 amount;
        uint256 unlockTime;
        CooldownStatus status;
        bool isClaimable;
        uint256 timeRemaining;
    }

    struct WithdrawCondition {
        RedemptionPolicy.CooldownMechanism mechanism;
        uint256 feeBps;
        uint256 cooldownDuration;
        uint256 coverageSenior;
        uint256 coverageMezz;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address cdo_,
        address seniorVault_,
        address mezzVault_,
        address juniorVault_
    ) {
        i_cdo = IPrimeCDOLens(cdo_);
        i_accounting = IPrimeCDOLens(cdo_).i_accounting();
        i_strategy = IPrimeCDOLens(cdo_).i_strategy();
        i_redemptionPolicy = IPrimeCDOLens(cdo_).i_redemptionPolicy();
        i_erc20Cooldown = IPrimeCDOLens(cdo_).i_erc20Cooldown();
        i_sharesCooldown = IPrimeCDOLens(cdo_).i_sharesCooldown();
        i_seniorVault = seniorVault_;
        i_mezzVault = mezzVault_;
        i_juniorVault = juniorVault_;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getTrancheInfo
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get detailed info for a single tranche.
     * @param tranche The tranche to query
     * @return info Struct with vault address, TVL, supply, share price
     */
    function getTrancheInfo(TrancheId tranche) external view returns (TrancheInfo memory info) {
        address vault = _getVault(tranche);
        info = _buildTrancheInfo(tranche, vault);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getAllTranches
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get info for all three tranches in one call.
     * @return senior Senior tranche info
     * @return mezz Mezzanine tranche info
     * @return junior Junior tranche info
     */
    function getAllTranches()
        external
        view
        returns (TrancheInfo memory senior, TrancheInfo memory mezz, TrancheInfo memory junior)
    {
        senior = _buildTrancheInfo(TrancheId.SENIOR, i_seniorVault);
        mezz = _buildTrancheInfo(TrancheId.MEZZ, i_mezzVault);
        junior = _buildTrancheInfo(TrancheId.JUNIOR, i_juniorVault);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getProtocolHealth
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get protocol-wide health metrics including coverage ratios.
     * @return health Struct with TVLs, coverage ratios, pause state
     */
    function getProtocolHealth() external view returns (ProtocolHealth memory health) {
        (uint256 sr, uint256 mz, uint256 jr) = i_accounting.getAllTVLs();
        health.seniorTVL = sr;
        uint256 srPrincipal = i_accounting.getSeniorPrincipal();
        health.seniorPrincipal = srPrincipal;
        health.seniorYield = sr > srPrincipal ? sr - srPrincipal : 0;
        health.mezzTVL = mz;
        health.juniorTVL = jr;
        health.totalTVL = sr + mz + jr;

        // cs = (Sr+Mz+Jr)/Sr — type(uint256).max if Sr == 0
        health.coverageSenior = sr > 0 ? ((sr + mz + jr) * PRECISION) / sr : type(uint256).max;
        // cm = (Mz+Jr)/Mz — type(uint256).max if Mz == 0
        health.coverageMezz = mz > 0 ? ((mz + jr) * PRECISION) / mz : type(uint256).max;

        health.minCoverageForDeposit = i_cdo.s_minCoverageForDeposit();
        health.shortfallPaused = i_cdo.s_shortfallPaused();
        health.juniorShortfallPausePrice = i_cdo.s_juniorShortfallPausePrice();
        health.strategyTVL = i_strategy.totalAssets();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getUserPendingWithdraws
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get all pending withdrawal requests for a user across both cooldown handlers.
     * @param user Address to query
     * @return withdraws Array of pending withdraw details
     */
    function getUserPendingWithdraws(address user) external view returns (PendingWithdraw[] memory withdraws) {
        uint256[] memory erc20Ids = _safeGetPendingRequests(i_erc20Cooldown, user);
        uint256[] memory sharesIds = _safeGetPendingRequests(i_sharesCooldown, user);

        uint256 total = erc20Ids.length + sharesIds.length;
        withdraws = new PendingWithdraw[](total);

        for (uint256 i = 0; i < erc20Ids.length; i++) {
            withdraws[i] = _buildPendingWithdraw(i_erc20Cooldown, erc20Ids[i]);
        }
        for (uint256 i = 0; i < sharesIds.length; i++) {
            withdraws[erc20Ids.length + i] = _buildPendingWithdraw(i_sharesCooldown, sharesIds[i]);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — previewWithdrawCondition
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Preview what cooldown mechanism, fee, and duration a withdrawal would face.
     * @param tranche Tranche to preview
     * @return cond Struct with mechanism, fee, duration, and current coverages
     */
    function previewWithdrawCondition(TrancheId tranche) external view returns (WithdrawCondition memory cond) {
        RedemptionPolicy.PolicyResult memory policy = i_redemptionPolicy.evaluate(tranche);
        cond.mechanism = policy.mechanism;
        cond.feeBps = policy.feeBps;
        cond.cooldownDuration = policy.cooldownDuration;

        (uint256 cs, uint256 cm) = i_redemptionPolicy.getCoverages();
        cond.coverageSenior = cs;
        cond.coverageMezz = cm;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getClaimableWithdraws
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get all claimable (ready-to-claim) withdrawal requests for a user.
     * @param user Address to query
     * @return claimable Array of claimable withdraw details
     */
    function getClaimableWithdraws(address user) external view returns (PendingWithdraw[] memory claimable) {
        uint256[] memory erc20Ids = _safeGetPendingRequests(i_erc20Cooldown, user);
        uint256[] memory sharesIds = _safeGetPendingRequests(i_sharesCooldown, user);

        // Count claimable
        uint256 count = 0;
        for (uint256 i = 0; i < erc20Ids.length; i++) {
            if (_safeIsClaimable(i_erc20Cooldown, erc20Ids[i])) count++;
        }
        for (uint256 i = 0; i < sharesIds.length; i++) {
            if (_safeIsClaimable(i_sharesCooldown, sharesIds[i])) count++;
        }

        claimable = new PendingWithdraw[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < erc20Ids.length; i++) {
            if (_safeIsClaimable(i_erc20Cooldown, erc20Ids[i])) {
                claimable[idx++] = _buildPendingWithdraw(i_erc20Cooldown, erc20Ids[i]);
            }
        }
        for (uint256 i = 0; i < sharesIds.length; i++) {
            if (_safeIsClaimable(i_sharesCooldown, sharesIds[i])) {
                claimable[idx++] = _buildPendingWithdraw(i_sharesCooldown, sharesIds[i]);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _getVault(TrancheId tranche) internal view returns (address) {
        if (tranche == TrancheId.SENIOR) return i_seniorVault;
        if (tranche == TrancheId.MEZZ) return i_mezzVault;
        return i_juniorVault;
    }

    function _buildTrancheInfo(TrancheId tranche, address vault) internal view returns (TrancheInfo memory info) {
        ITrancheVaultLens v = ITrancheVaultLens(vault);
        info.trancheId = tranche;
        info.vault = vault;
        info.name = v.name();
        info.symbol = v.symbol();
        info.totalAssets = v.totalAssets();
        info.totalSupply = v.totalSupply();
        info.sharePrice = info.totalSupply > 0
            ? (info.totalAssets * PRECISION) / info.totalSupply
            : PRECISION;
        info.apy = _getAPY(tranche);
    }

    function _getAPY(TrancheId tranche) internal view returns (uint256) {
        if (tranche == TrancheId.SENIOR) return i_accounting.getSeniorAPY();
        if (tranche == TrancheId.MEZZ) return i_accounting.getMezzAPY();
        return i_accounting.getJuniorAPY();
    }

    function _buildPendingWithdraw(
        ICooldownHandler handler,
        uint256 requestId
    ) internal view returns (PendingWithdraw memory pw) {
        CooldownRequest memory req = handler.getRequest(requestId);
        pw.requestId = requestId;
        pw.handler = address(handler);
        pw.beneficiary = req.beneficiary;
        pw.token = req.token;
        pw.amount = req.amount;
        pw.unlockTime = req.unlockTime;
        pw.status = req.status;
        pw.isClaimable = _safeIsClaimable(handler, requestId);
        pw.timeRemaining = handler.timeRemaining(requestId);
    }

    function _safeGetPendingRequests(
        ICooldownHandler handler,
        address user
    ) internal view returns (uint256[] memory) {
        if (address(handler) == address(0)) return new uint256[](0);
        try handler.getPendingRequests(user) returns (uint256[] memory ids) {
            return ids;
        } catch {
            return new uint256[](0);
        }
    }

    function _safeIsClaimable(ICooldownHandler handler, uint256 requestId) internal view returns (bool) {
        try handler.isClaimable(requestId) returns (bool result) {
            return result;
        } catch {
            return false;
        }
    }
}
