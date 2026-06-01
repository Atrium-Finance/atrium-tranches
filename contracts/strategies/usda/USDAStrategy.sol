// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Strategy } from "../../core/Strategy.sol";
import { ICDO } from "../../interfaces/ICDO.sol";
import { TrancheKind } from "../../interfaces/IAccounting.sol";
import { IStrategy } from "../../interfaces/IStrategy.sol";
import { IERC20Cooldown } from "../../interfaces/cooldown/IERC20Cooldown.sol";
import { IsUSDai } from "../../interfaces/external/IsUSDai.sol";
import { IUSDAStrategy } from "./IUSDAStrategy.sol";

/**
 * @title  USDAStrategy
 * @notice Atrium Strategy integrating USD.AI's sUSDai yield vault.
 *         - Deposit accepts USDai (auto-stake into sUSDai) and sUSDai (hold).
 *         - Withdraw releases sUSDai ONLY. Users wanting USDai call
 *           `sUSDai.redeem()` themselves downstream (Atrium intentionally
 *           does not couple to USD.AI's async USDai redemption queue).
 *         - All user-facing transfers route through the ERC20Cooldown
 *           silo. Per-tranche cooldown durations are admin-configurable.
 *         - APR is owned by an external `AaveAprPairProvider` wired into
 *           the AprPairFeed. This contract is APR-stateless.
 */
contract USDAStrategy is Strategy, IUSDAStrategy {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /// @notice Upper bound on per-tranche cooldown duration.
    uint32 public constant override MAX_COOLDOWN = 7 days;

    // ---------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------

    IsUSDai public immutable override sUSDai;
    IERC20 public immutable override USDai;
    IERC20Cooldown public immutable override erc20Cooldown;

    // ---------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------

    /// @dev Three uint32 cooldowns pack into one slot (12 of 32 bytes used).
    uint32 public override cooldownJr;
    uint32 public override cooldownMz;
    uint32 public override cooldownSr;

    uint256[44] private __gap;

    // ---------------------------------------------------------------
    // Initialiser
    // ---------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IsUSDai sUSDai_, IERC20Cooldown erc20Cooldown_) {
        if (address(sUSDai_) == address(0) || address(erc20Cooldown_) == address(0)) {
            revert ZeroAddress();
        }
        sUSDai = sUSDai_;
        USDai = IERC20(sUSDai_.asset());
        erc20Cooldown = erc20Cooldown_;
    }

    /**
     * @notice One-shot initializer. Seeds access control then primes the
     *         allowances Strategy needs at steady state: sUSDai → silo
     *         (so the silo can pull on `transfer`) and USDai → sUSDai
     *         (so auto-stake can deposit).
     */
    function initialize(address cdo_, address owner_, address acm_) external initializer {
        if (cdo_ == address(0)) revert ZeroAddress();
        AccessControlled_init(owner_, acm_);
        cdo = ICDO(cdo_);

        IERC20(address(sUSDai)).forceApprove(address(erc20Cooldown), type(uint256).max);
        USDai.forceApprove(address(sUSDai), type(uint256).max);
    }

    // ---------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IStrategy
     * @dev Pattern B/3: pulls `tokenAmount` from the calling tranche
     *      (Tranche pre-approves Strategy unlimited via its own
     *      `configure()`). USDai is auto-staked into sUSDai; sUSDai is
     *      held as-is.
     */
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address /* owner */
    ) external override onlyCDO nonReentrant returns (uint256) {
        if (token != address(USDai) && token != address(sUSDai)) {
            revert UnsupportedToken(token);
        }

        IERC20(token).safeTransferFrom(tranche, address(this), tokenAmount);

        if (token == address(USDai)) {
            sUSDai.deposit(tokenAmount, address(this));
        }

        return baseAssets;
    }

    // ---------------------------------------------------------------
    // Withdraw (sUSDai only)
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IStrategy
     * @dev Defaults to applying the per-tranche cooldown. PrimeCDO uses
     *      the 7-arg overload directly; this entry is here for interface
     *      completeness.
     */
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver
    ) external override onlyCDO nonReentrant returns (uint256) {
        return _withdraw(tranche, token, tokenAmount, baseAssets, sender, receiver, false);
    }

    /**
     * @inheritdoc IStrategy
     * @dev `shouldSkipCooldown` is set by PrimeCDO when the caller
     *      finalises out of the SharesCooldown silo — the user has
     *      already served their lock on the CDO side.
     */
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver,
        bool shouldSkipCooldown
    ) external override onlyCDO nonReentrant returns (uint256) {
        return _withdraw(tranche, token, tokenAmount, baseAssets, sender, receiver, shouldSkipCooldown);
    }

    function _withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 /* baseAssets */,
        address sender,
        address receiver,
        bool shouldSkipCooldown
    ) internal returns (uint256) {
        if (token != address(sUSDai)) revert UnsupportedToken(token);

        uint32 cooldown = shouldSkipCooldown ? 0 : _cooldownFor(tranche);
        erc20Cooldown.transfer(IERC20(token), sender, receiver, tokenAmount, cooldown);

        return tokenAmount;
    }

    // ---------------------------------------------------------------
    // Reserve drain (bypasses silo)
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IStrategy
     * @dev Reserve drain is a protocol operation, not a user withdrawal —
     *      it goes directly to treasury with no cooldown wrap.
     */
    function reduceReserve(
        address token,
        uint256 tokenAmount,
        address receiver
    ) external override onlyCDO nonReentrant {
        if (receiver == address(0)) revert ZeroAddress();
        if (token != address(sUSDai)) revert UnsupportedToken(token);

        IERC20(token).safeTransfer(receiver, tokenAmount);
    }

    // ---------------------------------------------------------------
    // Reporting
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IStrategy
     * @dev Returns USDai-equivalent value of all sUSDai held, valued at
     *      sUSDai's conservative NAV via {IsUSDai.convertToAssets}.
     *      ERC-7540 disables preview methods on sUSDai. Idle USDai (if
     *      any) is added on top in case a partial mid-transaction state
     *      ever holds it.
     */
    function totalAssets() external view override returns (uint256) {
        uint256 sUSDaiBalance = IERC20(address(sUSDai)).balanceOf(address(this));
        uint256 staked = sUSDaiBalance == 0 ? 0 : sUSDai.convertToAssets(sUSDaiBalance);
        uint256 idle = USDai.balanceOf(address(this));
        return staked + idle;
    }

    /**
     * @inheritdoc IStrategy
     * @dev USDai is 1:1 with the base asset. For sUSDai, uses the
     *      non-binding hint from {IsUSDai.convertToAssets}. ERC-7540
     *      does not expose rounding control — the `rounding` argument is
     *      accepted for ABI compatibility but ignored.
     */
    function convertToAssets(
        address token,
        uint256 tokenAmount,
        Math.Rounding /* rounding */
    ) external view override returns (uint256) {
        if (token == address(USDai)) return tokenAmount;
        if (token == address(sUSDai)) return sUSDai.convertToAssets(tokenAmount);
        revert UnsupportedToken(token);
    }

    /**
     * @inheritdoc IStrategy
     * @dev Mirror of {convertToAssets}: rounding ignored for sUSDai
     *      because ERC-7540's {IsUSDai.convertToShares} does not accept
     *      a rounding direction.
     */
    function convertToTokens(
        address token,
        uint256 baseAssets,
        Math.Rounding /* rounding */
    ) external view override returns (uint256) {
        if (token == address(USDai)) return baseAssets;
        if (token == address(sUSDai)) return sUSDai.convertToShares(baseAssets);
        revert UnsupportedToken(token);
    }

    /**
     * @inheritdoc IStrategy
     * @dev Order is `[sUSDai, USDai]` so Tranche's configure() loop
     *      pre-approves the yield-bearing form first.
     */
    function getSupportedTokens() external view override returns (IERC20[] memory tokens) {
        tokens = new IERC20[](2);
        tokens[0] = IERC20(address(sUSDai));
        tokens[1] = USDai;
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IUSDAStrategy
     */
    function setCooldowns(uint32 jr, uint32 mz, uint32 sr) external override onlyRole(UPDATER_STRAT_CONFIG_ROLE) {
        if (jr > MAX_COOLDOWN) revert CooldownTooLong(MAX_COOLDOWN, jr);
        if (mz > MAX_COOLDOWN) revert CooldownTooLong(MAX_COOLDOWN, mz);
        if (sr > MAX_COOLDOWN) revert CooldownTooLong(MAX_COOLDOWN, sr);

        cooldownJr = jr;
        cooldownMz = mz;
        cooldownSr = sr;

        bool allZero = (jr == 0 && mz == 0 && sr == 0);
        erc20Cooldown.setCooldownDisabled(IERC20(address(sUSDai)), allZero);

        emit CooldownsChanged(jr, mz, sr);
    }

    // ---------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------

    function _cooldownFor(address tranche) internal view returns (uint32) {
        TrancheKind kind = cdo.kindOf(tranche);
        if (kind == TrancheKind.JUNIOR) return cooldownJr;
        if (kind == TrancheKind.MEZZANINE) return cooldownMz;
        return cooldownSr;
    }
}
