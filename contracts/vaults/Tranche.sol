// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";

import { ITranche } from "../interfaces/ITranche.sol";
import { ICDO, TExitMode } from "../interfaces/ICDO.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
import { CDOComponent } from "../base/CDOComponent.sol";

/**
 * @title  Tranche
 * @notice Upgradeable ERC4626 tranche vault. Custom withdrawal mechanics
 *         routed through the CDO: every exit converges on `_withdraw`
 *         and branches by `TExitMode` (ERC4626 / SharesLock / Fee).
 */
contract Tranche is CDOComponent, ERC4626Upgradeable, ITranche {
    /**
     * @notice Minimum non-zero share supply. Donation-attack mitigation —
     *         `_onAfterWithdrawalChecks` reverts when totalSupply drops
     *         below this floor (and stays non-zero).
     */
    uint256 private constant MIN_SHARES = 0.1 ether;

    event OnPrimeDeposit(address indexed receiver, address indexed token, uint256 tokenAssets, uint256 shares);

    event OnExit(
        address indexed receiver,
        address indexed token,
        uint256 tokenAssets,
        uint256 shares,
        TExitMode exitMode,
        uint256 exitFee,
        uint32 cooldownSeconds
    );

    /** @notice Initialize the tranche vault and bind it to its CDO. */
    function initialize(IERC20 asset_, string memory name_, string memory symbol_, ICDO cdo_) public initializer {
        __ERC20_init_unchained(name_, symbol_);
        __ERC4626_init_unchained(asset_);

        cdo = cdo_;
    }

    /**
     * @inheritdoc ITranche
     */
    function configure() external onlyCDO {
        address strategy = address(cdo.strategy());
        IERC20[] memory tokens = IStrategy(strategy).getSupportedTokens();
        uint256 len = tokens.length;
        // `i` bounded by `len`; `len` bounded by Strategy admin.
        for (uint256 i; i < len;) {
            SafeERC20.forceApprove(tokens[i], strategy, type(uint256).max);
            unchecked { ++i; }
        }
    }

    // ---------------------------------------------------------------
    // Total assets / max gates — forward to CDO
    // ---------------------------------------------------------------

    /** @notice Total assets attributable to this tranche, sourced from the CDO. */
    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return cdo.totalAssets(address(this));
    }

    /** @notice Maximum deposit accepted by the CDO for this tranche. */
    function maxDeposit(address) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return cdo.maxDeposit(address(this));
    }

    /** @notice Maximum mint translated from {maxDeposit} via the standard ERC4626 conversion. */
    function maxMint(address) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        uint256 assets = cdo.maxDeposit(address(this));
        if (assets == type(uint256).max) return type(uint256).max;
        return convertToShares(assets);
    }

    /** @notice Maximum withdraw the CDO allows for `owner` (base-asset units). */
    function maxWithdraw(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return cdo.maxWithdraw(address(this), owner);
    }

    /** @notice Maximum redeem (shares) for `owner`, converted from {maxWithdraw}. */
    function maxRedeem(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        uint256 assets = cdo.maxWithdraw(address(this), owner);
        return convertToShares(assets);
    }

    /**
     * @inheritdoc ITranche
     */
    function maxWithdraw(address token, address owner) public view returns (uint256) {
        uint256 baseAssets = cdo.maxWithdraw(address(this), owner);
        return cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------
    // Fee-aware previews
    // ---------------------------------------------------------------

    /**
     * @notice Public preview of net assets received for burning `sharesGross`.
     * @dev    Discounts the public exit fee from `calculateExitMode(this, address(0))`.
     */
    function previewRedeem(uint256 sharesGross)
        public view override(ERC4626Upgradeable, IERC4626) returns (uint256 assetsNet)
    {
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        if (fee == 0) return super.previewRedeem(sharesGross);
        uint256 sharesFee = Math.mulDiv(sharesGross, fee, 1e18, Math.Rounding.Floor);
        assetsNet = super.previewRedeem(sharesGross - sharesFee);
    }

    /**
     * @notice Public preview of gross shares burned to receive `assetsNet`.
     * @dev    Inverts the fee discount applied in {previewRedeem}.
     */
    function previewWithdraw(uint256 assetsNet)
        public view override(ERC4626Upgradeable, IERC4626) returns (uint256 sharesGross)
    {
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        if (fee == 0) return super.previewWithdraw(assetsNet);
        uint256 sharesNet = super.previewWithdraw(assetsNet);
        // sharesGross = sharesNet / (1 − fee) = sharesNet + sharesNet × fee / (1e18 − fee)
        uint256 sharesFee = Math.mulDiv(sharesNet, fee, 1e18 - fee, Math.Rounding.Floor);
        sharesGross = sharesNet + sharesFee;
    }

    // ---------------------------------------------------------------
    // Deposit / mint — unchanged from prior specs
    // ---------------------------------------------------------------

    function deposit(
        uint256 assets,
        address receiver
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        cdo.updateAccounting();
        shares = super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        cdo.updateAccounting();
        assets = super.mint(shares, receiver);
    }

    /** @dev Forward freshly-deposited assets to the CDO after ERC4626 finalises. */
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        cdo.deposit(address(this), asset(), assets, assets);
    }

    function deposit(address token, uint256 tokenAmount, address receiver) public virtual override returns (uint256) {
        if (token == asset()) {
            return deposit(tokenAmount, receiver);
        }

        cdo.updateAccounting();

        uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);
        uint256 shares = previewDeposit(baseAssets);
        _deposit(token, _msgSender(), receiver, baseAssets, tokenAmount, shares);

        return shares;
    }

    function mint(address token, uint256 shares, address receiver) public virtual override returns (uint256) {
        if (token == asset()) {
            return mint(shares, receiver);
        }

        cdo.updateAccounting();

        uint256 baseAssets = previewMint(shares);

        uint256 tokenAssets = cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);

        _deposit(token, _msgSender(), receiver, baseAssets, tokenAssets, shares);

        return tokenAssets;
    }

    /** @dev Meta-vault deposit core, shared by token-routed `deposit` and `mint`. */
    function _deposit(
        address token,
        address caller,
        address receiver,
        uint256 baseAssets,
        uint256 tokenAssets,
        uint256 shares
    ) internal virtual {
        uint256 maxTokenToBaseAssetsWithdraw = IERC4626(token).maxWithdraw(caller);

        require(maxTokenToBaseAssetsWithdraw >= baseAssets, "PrimeVaultExceededMaxWithdraw");

        SafeERC20.safeTransferFrom(IERC20(token), caller, address(this), tokenAssets);

        _mint(receiver, shares);

        cdo.deposit(address(this), token, tokenAssets, baseAssets);

        emit Deposit(caller, receiver, baseAssets, shares);

        emit OnPrimeDeposit(receiver, token, tokenAssets, shares);
    }

    // ---------------------------------------------------------------
    // Withdraw — standard ERC4626 entry points delegate to token-routed
    // ---------------------------------------------------------------

    /**
     * @notice Standard ERC4626 withdraw. Delegates to the token-routed
     *         variant with `token = asset()` so every exit path routes
     *         through `_withdraw` and honours the CDO's exit mode.
     */
    function withdraw(uint256 assets, address receiver, address owner)
        public override(ERC4626Upgradeable, IERC4626) returns (uint256)
    {
        return withdraw(asset(), assets, receiver, owner);
    }

    /**
     * @notice Standard ERC4626 redeem. Delegates to the token-routed
     *         variant with `token = asset()`.
     */
    function redeem(uint256 shares, address receiver, address owner)
        public override(ERC4626Upgradeable, IERC4626) returns (uint256)
    {
        return redeem(asset(), shares, receiver, owner);
    }

    /**
     * @notice Token-routed withdraw (default). Forwards to the
     *         five-arg overload with `Dynamic` — caller opts out of
     *         mode-slippage validation.
     */
    function withdraw(address token, uint256 tokenAmount, address receiver, address owner)
        public virtual override returns (uint256)
    {
        return withdraw(
            token,
            tokenAmount,
            receiver,
            owner,
            TRedemptionParams(TExitMode.Dynamic, 0, 0)
        );
    }

    /**
     * @notice Token-routed withdraw with mode-slippage guard.
     * @dev    `params.exitMode == TExitMode.Dynamic` opts out of
     *         validation. Otherwise all three params must equal the
     *         CDO's live `calculateExitMode` result for this owner.
     */
    function withdraw(
        address token,
        uint256 tokenAmount,
        address receiver,
        address owner,
        TRedemptionParams memory params
    ) public virtual returns (uint256 shares) {
        cdo.updateAccounting();

        (TExitMode exitMode, uint256 exitFee, uint32 cooldownSec)
            = cdo.calculateExitMode(address(this), owner);
        _validateRedemptionParams(params, exitMode, exitFee, cooldownSec);

        uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);

        uint256 maxAssets = maxWithdraw(owner);
        if (baseAssets > maxAssets) {
            revert ERC4626ExceededMaxWithdraw(owner, baseAssets, maxAssets);
        }

        shares = _quoteWithdrawShares(baseAssets, exitFee);

        _withdraw(token, _msgSender(), receiver, owner, baseAssets, tokenAmount, shares, exitMode, exitFee, cooldownSec);
    }

    /**
     * @notice Token-routed redeem (default). Forwards to the five-arg
     *         overload with `Dynamic` — caller opts out of
     *         mode-slippage validation.
     */
    function redeem(address token, uint256 shares, address receiver, address owner)
        public virtual override returns (uint256)
    {
        return redeem(
            token,
            shares,
            receiver,
            owner,
            TRedemptionParams(TExitMode.Dynamic, 0, 0)
        );
    }

    /**
     * @notice Token-routed redeem with mode-slippage guard.
     */
    function redeem(
        address token,
        uint256 shares,
        address receiver,
        address owner,
        TRedemptionParams memory params
    ) public virtual returns (uint256 tokenAssets) {
        cdo.updateAccounting();

        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) {
            revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        }

        (TExitMode exitMode, uint256 exitFee, uint32 cooldownSec)
            = cdo.calculateExitMode(address(this), owner);
        _validateRedemptionParams(params, exitMode, exitFee, cooldownSec);

        uint256 baseAssets = _quoteRedeemAssets(shares, exitFee);
        tokenAssets = cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);

        _withdraw(token, _msgSender(), receiver, owner, baseAssets, tokenAssets, shares, exitMode, exitFee, cooldownSec);
    }

    /** @dev Quote helper shared with `withdraw` / `previewWithdraw`. */
    function _quoteWithdrawShares(uint256 assetsNet, uint256 fee) internal view returns (uint256 sharesGross) {
        uint256 sharesNet = super.previewWithdraw(assetsNet);
        if (fee == 0) return sharesNet;
        uint256 sharesFee = Math.mulDiv(sharesNet, fee, 1e18 - fee, Math.Rounding.Floor);
        sharesGross = sharesNet + sharesFee;
    }

    /** @dev Quote helper shared with `redeem` / `previewRedeem`. */
    function _quoteRedeemAssets(uint256 sharesGross, uint256 fee) internal view returns (uint256 assetsNet) {
        if (fee == 0) return super.previewRedeem(sharesGross);
        uint256 sharesFee = Math.mulDiv(sharesGross, fee, 1e18, Math.Rounding.Floor);
        assetsNet = super.previewRedeem(sharesGross - sharesFee);
    }

    /**
     * @dev Internal withdraw router. Order: spend allowance →
     *      branch by mode. SharesLock transfers shares into the silo
     *      (burn deferred to silo finalisation); ERC4626 / Fee burns
     *      now and forwards to the CDO. Fee path additionally accrues
     *      the gross-vs-net delta against the reserve.
     */
    function _withdraw(
        address token,
        address caller,
        address receiver,
        address owner,
        uint256 baseAssets,
        uint256 tokenAssets,
        uint256 sharesGross,
        TExitMode exitMode,
        uint256 exitFee,
        uint32 cooldownSec
    ) internal virtual {
        if (caller != owner) {
            _spendAllowance(owner, caller, sharesGross);
        }

        if (exitMode == TExitMode.SharesLock) {
            // Move shares into the silo; silo finalises on behalf of
            // the owner after cooldown. No burn here — silo redeems
            // via Tranche later, which burns then.
            address silo = address(cdo.sharesCooldown());
            _transfer(owner, silo, sharesGross);

            // Recognise external receiver for the silo's slot accounting.
            address initialFrom =
                (caller == receiver || owner == receiver) ? receiver : owner;

            cdo.cooldownShares(
                address(this),
                token,
                sharesGross,
                initialFrom,
                receiver,
                exitFee,
                cooldownSec
            );
            return;
        }

        // ERC4626 + Fee paths share the burn + forward path. Fee path
        // additionally accrues fee against the reserve.
        uint256 baseAssetsGross = super.previewRedeem(sharesGross);
        uint256 fee = baseAssetsGross > baseAssets ? baseAssetsGross - baseAssets : 0;

        _burn(owner, sharesGross);
        _onAfterWithdrawalChecks();

        if (fee > 0) {
            cdo.accrueFee(address(this), fee);
        }

        cdo.withdraw(address(this), token, tokenAssets, baseAssets, owner, receiver);

        emit Withdraw(caller, receiver, owner, baseAssets, sharesGross);
        emit OnExit(receiver, token, tokenAssets, sharesGross, exitMode, exitFee, cooldownSec);
    }

    /**
     * @inheritdoc ITranche
     * @dev Permissionless. Caller's allowance is spent when caller != owner.
     *      Uses the fee-free `super.previewRedeem` to avoid double-discount —
     *      this entry IS the fee accrual.
     */
    function burnSharesAsFee(uint256 shares, address owner) external returns (uint256 assets) {
        cdo.updateAccounting();

        address caller = _msgSender();
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }

        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) {
            revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        }

        assets = convertToShares(shares) > 0 ? super.previewRedeem(shares) : 0;
        _burn(owner, shares);
        _onAfterWithdrawalChecks();
        cdo.accrueFee(address(this), assets);
        cdo.updateBalanceFlow();
    }

    // ---------------------------------------------------------------
    // Internal helpers (16b)
    // ---------------------------------------------------------------

    /**
     * @dev Reverts `RedemptionParamsMismatch` when `params` disagree
     *      with the CDO's live mode payload. Skipped entirely when
     *      `params.exitMode == TExitMode.Dynamic` — the caller-side
     *      opt-out sentinel.
     */
    function _validateRedemptionParams(
        TRedemptionParams memory params,
        TExitMode exitMode,
        uint256 exitFee,
        uint32 cooldownSec
    ) internal pure {
        if (params.exitMode == TExitMode.Dynamic) return;
        if (
            params.exitMode != exitMode ||
            params.exitFee != exitFee ||
            params.cooldownSeconds != cooldownSec
        ) {
            revert RedemptionParamsMismatch(
                params,
                TRedemptionParams(exitMode, exitFee, cooldownSec)
            );
        }
    }

    /**
     * @dev Donation-attack mitigation. Allows a clean drain
     *      (`totalSupply == 0`) but rejects a residual dust holder
     *      below `MIN_SHARES`.
     */
    function _onAfterWithdrawalChecks() internal view {
        uint256 supply = totalSupply();
        if (supply > 0 && supply < MIN_SHARES) {
            revert MinSharesViolation();
        }
    }

    // ---------------------------------------------------------------
    // External quote helpers + meta-token previews (16b)
    // ---------------------------------------------------------------

    /**
     * @inheritdoc ITranche
     */
    function quoteWithdraw(uint256 assetsNet, uint256 fee)
        public view returns (uint256 sharesGross)
    {
        return _quoteWithdrawShares(assetsNet, fee);
    }

    /**
     * @inheritdoc ITranche
     */
    function quoteRedeem(uint256 sharesGross, uint256 fee)
        public view returns (uint256 assetsNet)
    {
        return _quoteRedeemAssets(sharesGross, fee);
    }

    /**
     * @inheritdoc ITranche
     */
    function previewWithdraw(address token, uint256 tokenAmount)
        public view override returns (uint256 sharesGross)
    {
        uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        sharesGross = _quoteWithdrawShares(baseAssets, fee);
    }

    /**
     * @inheritdoc ITranche
     */
    function previewRedeem(address token, uint256 shares)
        public view override returns (uint256 tokenAssetsNet)
    {
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        uint256 baseAssetsNet = _quoteRedeemAssets(shares, fee);
        tokenAssetsNet = cdo.strategy().convertToTokens(token, baseAssetsNet, Math.Rounding.Floor);
    }
}
