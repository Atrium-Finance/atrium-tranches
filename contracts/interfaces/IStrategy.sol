// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICDOComponent } from "./ICDOComponent.sol";

/**
 * @title  IStrategy
 * @notice Investment strategy holding protocol funds, converting
 *         between supported tokens and the base asset, and reporting
 *         total assets in base-asset units.
 */
interface IStrategy is ICDOComponent {
    /**
     * @notice Pull `tokenAmount` of `token` from `owner` and integrate
     *         into the strategy's holdings.
     * @param  tranche     Initiating tranche (informational).
     * @param  token       Deposited token. Must be supported.
     * @param  tokenAmount Amount to pull from `owner`.
     * @param  baseAssets  Pre-computed base-asset equivalent.
     * @param  owner       Source of `safeTransferFrom`.
     */
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner
    ) external returns (uint256);

    /**
     * @notice Release holdings to `receiver` in `token`. Applies the
     *         strategy's configured per-tranche cooldown.
     */
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver
    ) external returns (uint256);

    /**
     * @notice Same as {withdraw}, with an explicit flag to bypass the
     *         cooldown — set when the user has already served their
     *         lock elsewhere (e.g. SharesCooldown silo).
     */
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver,
        bool shouldSkipCooldown
    ) external returns (uint256);

    /**
     * @notice Transfer `tokenAmount` of `token` to `receiver`. Used
     *         by `CDO.reduceReserve` for treasury drain.
     */
    function reduceReserve(
        address token,
        uint256 tokenAmount,
        address receiver
    ) external;

    // @notice Total assets controlled, in base-asset units.
    function totalAssets() external view returns (uint256);

    /**
     * @notice Convert `tokenAmount` of `token` into base-asset units
     *         with the requested rounding direction.
     */
    function convertToAssets(
        address token,
        uint256 tokenAmount,
        Math.Rounding rounding
    ) external view returns (uint256 baseAssets);

    // @notice Inverse of {convertToAssets}.
    function convertToTokens(
        address token,
        uint256 baseAssets,
        Math.Rounding rounding
    ) external view returns (uint256 tokenAmount);

    // @notice Tokens the strategy accepts on deposit.
    function getSupportedTokens() external view returns (IERC20[] memory);
}
