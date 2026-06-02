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
 * @notice Upgradeable ERC4626 tranche vault. Every exit converges on
 *         {_withdraw} and branches by `TExitMode`
 *         (ERC4626 / SharesLock / Fee).
 */
contract Tranche is CDOComponent, ERC4626Upgradeable, ITranche {
    /**
     * @notice Minimum non-zero share supply. Donation-attack
     *         mitigation — `_onAfterWithdrawalChecks` reverts when
     *         `totalSupply` is non-zero but below this floor.
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

    // @notice Initialise the vault and bind it to its CDO.
    function initialize(IERC20 asset_, string memory name_, string memory symbol_, ICDO cdo_) public initializer {
        __ERC20_init_unchained(name_, symbol_);
        __ERC4626_init_unchained(asset_);

        cdo = cdo_;
    }

    // @inheritdoc ITranche
    function configure() external onlyCDO {
        address strategy = address(cdo.strategy());
        IERC20[] memory tokens = IStrategy(strategy).getSupportedTokens();
        uint256 len = tokens.length;
        for (uint256 i; i < len;) {
            SafeERC20.forceApprove(tokens[i], strategy, type(uint256).max);
            unchecked { ++i; }
        }
    }

    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return cdo.totalAssets(address(this));
    }

    function maxDeposit(address) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return cdo.maxDeposit(address(this));
    }

    function maxMint(address) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        uint256 assets = cdo.maxDeposit(address(this));
        if (assets == type(uint256).max) return type(uint256).max;
        return convertToShares(assets);
    }

    function maxWithdraw(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return cdo.maxWithdraw(address(this), owner);
    }

    function maxRedeem(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        uint256 assets = cdo.maxWithdraw(address(this), owner);
        return convertToShares(assets);
    }

    // @inheritdoc ITranche
    function maxWithdraw(address token, address owner) public view returns (uint256) {
        uint256 baseAssets = cdo.maxWithdraw(address(this), owner);
        return cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);
    }

    /**
     * @notice Net assets received for burning `sharesGross`, after
     *         the public exit fee discount.
     * @dev    sharesFee = floor(sharesGross × fee / 1e18)
     *         assetsNet = super.previewRedeem(sharesGross - sharesFee)
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
     * @notice Gross shares burned to receive `assetsNet`.
     * @dev    Inverse of {previewRedeem}:
     *           sharesNet  = super.previewWithdraw(assetsNet)
     *           sharesFee  = floor(sharesNet × fee / (1e18 - fee))
     *           sharesGross = sharesNet + sharesFee
     */
    function previewWithdraw(uint256 assetsNet)
        public view override(ERC4626Upgradeable, IERC4626) returns (uint256 sharesGross)
    {
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        if (fee == 0) return super.previewWithdraw(assetsNet);
        uint256 sharesNet = super.previewWithdraw(assetsNet);
        uint256 sharesFee = Math.mulDiv(sharesNet, fee, 1e18 - fee, Math.Rounding.Floor);
        sharesGross = sharesNet + sharesFee;
    }

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

    /**
     * @dev Hook fires after `super._deposit` pulled assets + minted
     *      shares; forward the assets to CDO for staking.
     */
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        cdo.deposit(address(this), asset(), assets, assets);
    }

    /**
     * @notice Meta-token deposit. `token == asset()` delegates to the
     *         standard ERC4626 path; otherwise converts via Strategy.
     */
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

    /**
     * @notice Meta-token mint. `token == asset()` delegates to the
     *         standard ERC4626 path; otherwise converts via Strategy.
     */
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

    function withdraw(uint256 assets, address receiver, address owner)
        public override(ERC4626Upgradeable, IERC4626) returns (uint256)
    {
        return withdraw(asset(), assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public override(ERC4626Upgradeable, IERC4626) returns (uint256)
    {
        return redeem(asset(), shares, receiver, owner);
    }

    /**
     * @notice Token-routed withdraw. Forwards to the 5-arg overload
     *         with `Dynamic` — caller opts out of mode-slippage
     *         validation.
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

    // @inheritdoc ITranche
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
     * @notice Token-routed redeem. Forwards to the 5-arg overload
     *         with `Dynamic`.
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

    // @inheritdoc ITranche
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

    // @dev sharesGross = sharesNet + floor(sharesNet × fee / (1e18 - fee)).
    function _quoteWithdrawShares(uint256 assetsNet, uint256 fee) internal view returns (uint256 sharesGross) {
        uint256 sharesNet = super.previewWithdraw(assetsNet);
        if (fee == 0) return sharesNet;
        uint256 sharesFee = Math.mulDiv(sharesNet, fee, 1e18 - fee, Math.Rounding.Floor);
        sharesGross = sharesNet + sharesFee;
    }

    // @dev assetsNet = super.previewRedeem(sharesGross - floor(sharesGross × fee / 1e18)).
    function _quoteRedeemAssets(uint256 sharesGross, uint256 fee) internal view returns (uint256 assetsNet) {
        if (fee == 0) return super.previewRedeem(sharesGross);
        uint256 sharesFee = Math.mulDiv(sharesGross, fee, 1e18, Math.Rounding.Floor);
        assetsNet = super.previewRedeem(sharesGross - sharesFee);
    }

    /**
     * @dev Mode-branch router. Order: spend allowance → branch.
     *      SharesLock moves shares into the silo (burn deferred to
     *      silo finalisation). ERC4626/Fee burns now and forwards;
     *      Fee path additionally accrues the gross-vs-net delta into
     *      the reserve.
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
            address silo = address(cdo.sharesCooldown());
            _transfer(owner, silo, sharesGross);

            // External receiver heuristic for the silo's slot accounting.
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

        // fee = baseAssetsGross - baseAssets (delta between fee-free quote
        // and the net entitlement the caller asked to receive).
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
     * @dev Uses fee-free `super.previewRedeem` to avoid double-discount
     *      — this entry IS the fee accrual.
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

    /**
     * @dev Skipped when `params.exitMode == Dynamic` (caller-side
     *      opt-out sentinel).
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
     * @dev Allow `totalSupply == 0` (clean drain) but reject a
     *      residual dust holder below `MIN_SHARES`.
     */
    function _onAfterWithdrawalChecks() internal view {
        uint256 supply = totalSupply();
        if (supply > 0 && supply < MIN_SHARES) {
            revert MinSharesViolation();
        }
    }

    // @inheritdoc ITranche
    function quoteWithdraw(uint256 assetsNet, uint256 fee)
        public view returns (uint256 sharesGross)
    {
        return _quoteWithdrawShares(assetsNet, fee);
    }

    // @inheritdoc ITranche
    function quoteRedeem(uint256 sharesGross, uint256 fee)
        public view returns (uint256 assetsNet)
    {
        return _quoteRedeemAssets(sharesGross, fee);
    }

    // @inheritdoc ITranche
    function previewWithdraw(address token, uint256 tokenAmount)
        public view override returns (uint256 sharesGross)
    {
        uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        sharesGross = _quoteWithdrawShares(baseAssets, fee);
    }

    // @inheritdoc ITranche
    function previewRedeem(address token, uint256 shares)
        public view override returns (uint256 tokenAssetsNet)
    {
        (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
        uint256 baseAssetsNet = _quoteRedeemAssets(shares, fee);
        tokenAssetsNet = cdo.strategy().convertToTokens(token, baseAssetsNet, Math.Rounding.Floor);
    }
}
