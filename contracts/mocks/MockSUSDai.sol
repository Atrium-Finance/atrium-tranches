// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IsUSDai } from "../interfaces/external/IsUSDai.sol";

/**
 * @notice ERC4626-backed sUSDai mock matching the real ERC-7540 surface.
 *         `totalAssets()` and `depositSharePrice()` are overridable so
 *         tests can pin valuations without funding the contract.
 */
contract MockSUSDai is ERC4626, IsUSDai {
    uint256 private _totalAssetsOverride;
    bool private _useTotalAssetsOverride;

    uint256 private _depositSharePrice;
    uint256 private _redemptionSharePrice;

    constructor(IERC20 underlying_) ERC4626(underlying_) ERC20("sUSDai", "sUSDai") {
        // Default share prices to 1.0 (1e18) — overridable via setters.
        _depositSharePrice = 1e18;
        _redemptionSharePrice = 1e18;
    }

    // ---------------------------------------------------------------
    // Test setters
    // ---------------------------------------------------------------

    function setTotalAssets(uint256 v) external {
        _useTotalAssetsOverride = true;
        _totalAssetsOverride = v;
    }

    function clearTotalAssets() external {
        _useTotalAssetsOverride = false;
    }

    function setDepositSharePrice(uint256 v) external {
        _depositSharePrice = v;
    }

    function setRedemptionSharePrice(uint256 v) external {
        _redemptionSharePrice = v;
    }

    // ---------------------------------------------------------------
    // IsUSDai (matches real ERC-7540 surface)
    // ---------------------------------------------------------------

    function asset() public view override(ERC4626, IsUSDai) returns (address) {
        return super.asset();
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override(ERC4626, IsUSDai) returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function convertToAssets(
        uint256 shares
    ) public view override(ERC4626, IsUSDai) returns (uint256) {
        return super.convertToAssets(shares);
    }

    function convertToShares(
        uint256 assets
    ) public view override(ERC4626, IsUSDai) returns (uint256) {
        return super.convertToShares(assets);
    }

    function totalAssets() public view override(ERC4626, IsUSDai) returns (uint256) {
        if (_useTotalAssetsOverride) return _totalAssetsOverride;
        return super.totalAssets();
    }

    function depositSharePrice() external view override returns (uint256) {
        return _depositSharePrice;
    }

    function redemptionSharePrice() external view override returns (uint256) {
        return _redemptionSharePrice;
    }

    function nav() external view override returns (uint256) {
        if (_useTotalAssetsOverride) return _totalAssetsOverride;
        return super.totalAssets();
    }
}
