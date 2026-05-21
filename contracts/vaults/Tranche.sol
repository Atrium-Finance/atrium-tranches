// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";

import { ITranche } from "../interfaces/ITranche.sol";
import { ICDO } from "../interfaces/ICDO.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
import { CDOComponent } from "../base/CDOComponent.sol";

/**
 * @title Tranche
 * @notice Upgradeable ERC4626 tranche vault. Withdrawal mechanics are
 *         intentionally left to subclasses or future overrides.
 */
contract Tranche is CDOComponent, ERC4626Upgradeable, ITranche {
    /**
     * @notice Thrown by token-routed entrypoints whose implementation is deferred.
     */
    error NotImplemented();

    /**
     * @notice Emitted when a prime-vault deposit completes (token-routed path).
     */
    event OnPrimeDeposit(address indexed receiver, address indexed token, uint256 tokenAssets, uint256 shares);

    /**
     * @notice Initialize the tranche vault.
     * @param asset_ Underlying ERC20 asset.
     * @param name_ Share token name.
     * @param symbol_ Share token symbol.
     */
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
        // safe: i bounded by len, len bounded by Strategy admin
        for (uint256 i; i < len;) {
            SafeERC20.forceApprove(tokens[i], strategy, type(uint256).max);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Deposit `assets` and mint shares to `receiver`.
     * @dev Synchronizes CDO accounting before executing the ERC4626 deposit.
     */
    function deposit(
        uint256 assets,
        address receiver
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        cdo.updateAccounting();
        shares = super.deposit(assets, receiver);
    }

    /**
     * @notice Mint `shares` to `receiver`, pulling the required assets.
     * @dev Synchronizes CDO accounting before executing the ERC4626 mint.
     */
    function mint(
        uint256 shares,
        address receiver
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        cdo.updateAccounting();
        assets = super.mint(shares, receiver);
    }

    /**
     * @notice Withdraw `assets` to `receiver`, burning shares from `owner`.
     * @dev Synchronizes CDO accounting before executing the ERC4626 withdraw.
     *      Custom withdrawal mechanics will be layered on top of this flow.
     */
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        cdo.updateAccounting();
        shares = super.withdraw(assets, receiver, owner);
    }

    /**
     * @notice Redeem `shares` from `owner`, sending assets to `receiver`.
     * @dev Synchronizes CDO accounting before executing the ERC4626 redeem.
     *      Custom redemption mechanics will be layered on top of this flow.
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        cdo.updateAccounting();
        assets = super.redeem(shares, receiver, owner);
    }

    /**
     * @dev Forwards the deposited assets to the CDO after the ERC4626 deposit
     *      finalizes the share mint and the asset pull.
     */
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        cdo.deposit(address(this), asset(), assets, assets);
    }

    /**
     * @notice Token-routed deposit; accepts either the native asset or a
     *         supported prime-vault token.
     * @dev When `token == asset()` delegates to the native ERC4626 flow.
     *      Otherwise synchronizes CDO accounting, converts `tokenAmount` into
     *      base assets via the strategy, previews shares, and executes the
     *      6-arg `_deposit` flow.
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
     * @notice Token-routed mint; accepts either the native asset or a
     *         supported prime-vault token.
     * @dev When `token == asset()` delegates to the native ERC4626 mint flow.
     *      Otherwise synchronizes CDO accounting, previews base assets,
     *      converts to token assets via the strategy, and executes the
     *      6-arg `_deposit` flow.
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

    /**
     * @dev Token-routed internal deposit flow used by both `deposit` and `mint`
     *      prime-vault paths. Validates withdraw capacity on the source vault,
     *      pulls the vault tokens, mints shares to `receiver`, forwards the
     *      tokens to the CDO, and emits both `Deposit` and `OnPrimeDeposit`.
     */
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

    /**
     * @notice Token-routed withdraw; uses CDO routing and coverage-aware exit logic.
     * @dev Stub. Implementation deferred to a future spec.
     */
    function withdraw(address, uint256, address, address) external override returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @notice Token-routed redeem; uses CDO routing and coverage-aware exit logic.
     * @dev Stub. Implementation deferred to a future spec.
     */
    function redeem(address, uint256, address, address) external override returns (uint256) {
        revert NotImplemented();
    }
}
