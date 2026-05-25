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
 * @title  Tranche
 * @notice Upgradeable ERC4626 tranche vault. Custom withdrawal mechanics
 *         layered on top in a later spec.
 */
contract Tranche is CDOComponent, ERC4626Upgradeable, ITranche {
    error NotImplemented();

    event OnPrimeDeposit(address indexed receiver, address indexed token, uint256 tokenAssets, uint256 shares);

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

    /**
     * @notice Deposit `assets` and mint shares to `receiver`.
     * @dev    Syncs CDO accounting first so share price reflects fresh TVLs.
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
     * @dev    Syncs CDO accounting first so share price reflects fresh TVLs.
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
     * @dev    Syncs CDO accounting first so share price reflects fresh TVLs.
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
     * @dev    Syncs CDO accounting first so share price reflects fresh TVLs.
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        cdo.updateAccounting();
        assets = super.redeem(shares, receiver, owner);
    }

    /** @dev Forward freshly-deposited assets to the CDO after ERC4626 finalises. */
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        cdo.deposit(address(this), asset(), assets, assets);
    }

    /**
     * @notice Token-routed deposit. Native asset → ERC4626 path; alt token → meta-vault path.
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
     * @notice Token-routed mint. Native asset → ERC4626 path; alt token → meta-vault path.
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

    /** @notice Token-routed withdraw. Stub — deferred to a future spec. */
    function withdraw(address, uint256, address, address) external override returns (uint256) {
        revert NotImplemented();
    }

    /** @notice Token-routed redeem. Stub — deferred to a future spec. */
    function redeem(address, uint256, address, address) external override returns (uint256) {
        revert NotImplemented();
    }

    /** @notice Burn shares and accrue fee. Stub — deferred to a future spec. */
    function burnSharesAsFee(uint256, address) external pure override {
        revert NotImplemented();
    }
}
