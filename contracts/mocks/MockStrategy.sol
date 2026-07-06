// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Strategy } from "../core/Strategy.sol";
import { ICDO } from "../interfaces/ICDO.sol";

/**
 * @notice Minimal concrete Strategy for unit tests. Trivial 1:1 conversion,
 *         settable totalAssets, and no real token movement.
 */
contract MockStrategy is Strategy {
    IERC20[] private _tokens;
    uint256 private _totalAssets;

    function initialize(address cdo_, address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
        cdo = ICDO(cdo_);
    }

    function setSupportedTokens(IERC20[] memory tokens) external {
        delete _tokens;
        for (uint256 i; i < tokens.length; i++) {
            _tokens.push(tokens[i]);
        }
    }

    function setTotalAssets(uint256 v) external { _totalAssets = v; }

    function totalAssets() external view override returns (uint256) {
        return _totalAssets;
    }

    function getSupportedTokens() external view override returns (IERC20[] memory) {
        return _tokens;
    }

    function deposit(
        address /*tranche*/,
        address /*token*/,
        uint256 /*tokenAmount*/,
        uint256 baseAssets,
        address /*owner*/
    ) external view override onlyCDO returns (uint256) {
        return baseAssets;
    }

    function withdraw(
        address, address, uint256 tokenAmount, uint256, address, address
    ) external view override onlyCDO returns (uint256) {
        return tokenAmount;
    }

    function withdraw(
        address, address, uint256 tokenAmount, uint256, address, address, bool
    ) external view override onlyCDO returns (uint256) {
        return tokenAmount;
    }

    function reduceReserve(address, uint256, address) external override onlyCDO {}

    function convertToAssets(address, uint256 a, Math.Rounding) external pure override returns (uint256) {
        return a;
    }

    function convertToTokens(address, uint256 b, Math.Rounding) external pure override returns (uint256) {
        return b;
    }
}
