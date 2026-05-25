// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICDOComponent } from "./ICDOComponent.sol";

/**
 * @title  IStrategy
 * @notice Investment strategy that holds protocol funds, converts
 *         between accepted tokens and the base asset, and reports
 *         total assets in base-asset units.
 * @dev    Concrete implementations declare their own supported-token
 *         registry; this interface does not impose a base-asset
 *         distinction at the type level.
 */
interface IStrategy is ICDOComponent {
    // ---------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------

    /**
     * @notice Pull `tokenAmount` of `token` from `owner` and integrate
     *         it into the strategy's holdings.
     * @dev    Caller must be the CDO (`onlyCDO` in the concrete
     *         implementation). `owner` is the source of the
     *         allowance — typically the Tranche vault (CDO passes
     *         the tranche address through). `baseAssets` is the
     *         pre-computed base-asset equivalent provided by the
     *         CDO for accounting purposes; the strategy may use it
     *         or recompute via {convertToAssets}.
     * @param  tranche     The tranche initiating the deposit
     *                     (informational).
     * @param  token       The deposited token. Must be supported.
     * @param  tokenAmount The amount of `token` to pull from `owner`.
     * @param  baseAssets  The base-asset equivalent of the deposit.
     * @param  owner       The source of the pull. The strategy
     *                     executes
     *                     `safeTransferFrom(token, owner, this, tokenAmount)`.
     * @return The amount of base assets credited.
     */
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner
    ) external returns (uint256);

    // ---------------------------------------------------------------
    // Withdraw (2 overloads)
    // ---------------------------------------------------------------

    /**
     * @notice Release holdings to `receiver` denominated in `token`.
     *         Defaults to applying the strategy's configured
     *         cooldown.
     * @dev    Caller must be the CDO. Returns the amount of `token`
     *         released (which may be shares of an ERC-4626 wrapper).
     * @param  tranche     The tranche initiating the withdrawal.
     * @param  token       The output token. Must be supported.
     * @param  tokenAmount The amount of `token` requested
     *                     (informational; strategy may recompute
     *                     via `convertToTokens(baseAssets)`).
     * @param  baseAssets  The base-asset equivalent to release.
     * @param  sender      The account that initiated the withdrawal
     *                     (the request originator — used to identify
     *                     SharesCooldown silo calls in future flows).
     * @param  receiver    Address receiving the output token.
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
     * @notice Same as {withdraw} above, with an explicit flag to
     *         bypass the strategy's configured cooldown.
     * @dev    Caller must be the CDO. The flag is set when the
     *         caller knows the user has already served their
     *         cooldown elsewhere (e.g. via the CDO's
     *         `SharesCooldown` silo). When `shouldSkipCooldown` is
     *         true the strategy releases tokens immediately.
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

    // ---------------------------------------------------------------
    // Reserve
    // ---------------------------------------------------------------

    /**
     * @notice Transfer `tokenAmount` of `token` to `receiver`.
     * @dev    Caller must be the CDO. Used by
     *         `CDO.reduceReserve(...)` to drain the protocol reserve
     *         into the treasury. Concrete strategies are free to
     *         re-use their cooldown infrastructure here (with a
     *         zero-cooldown transfer) — they do NOT need an extra
     *         direct path.
     */
    function reduceReserve(
        address token,
        uint256 tokenAmount,
        address receiver
    ) external;

    // ---------------------------------------------------------------
    // Reporting
    // ---------------------------------------------------------------

    /**
     * @notice Total assets the strategy controls, denominated in
     *         base-asset units.
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Convert `tokenAmount` of `token` into base-asset units.
     * @dev    For ERC-4626 alternatives, uses the vault's
     *         exchange rate with the requested rounding direction.
     */
    function convertToAssets(
        address token,
        uint256 tokenAmount,
        Math.Rounding rounding
    ) external view returns (uint256 baseAssets);

    /** @notice Inverse of {convertToAssets}. */
    function convertToTokens(
        address token,
        uint256 baseAssets,
        Math.Rounding rounding
    ) external view returns (uint256 tokenAmount);

    // ---------------------------------------------------------------
    // Registry
    // ---------------------------------------------------------------

    /**
     * @notice Returns the tokens the strategy accepts on deposit
     *         (and emits on withdrawal where the concrete policy
     *         allows it).
     */
    function getSupportedTokens() external view returns (IERC20[] memory);
}
