// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IPrimeVault} from "./IPrimeVault.sol";
import {ICDOComponent} from "./ICDOComponent.sol";
import {TExitMode} from "./ICDO.sol";

/**
 * @title  ITranche
 * @notice Tranche vault extending the ERC-4626 standard with meta-token
 *         routing and mode-aware exit semantics.
 */
interface ITranche is ICDOComponent, IPrimeVault {
    /**
     * @notice User guard against mode slippage between submission and
     *         execution. `exitMode == TExitMode.Dynamic` opts out.
     */
    struct TRedemptionParams {
        TExitMode exitMode;
        uint256 exitFee;
        uint32 cooldownSeconds;
    }

    error RedemptionParamsMismatch(
        TRedemptionParams requested,
        TRedemptionParams current
    );
    error MinSharesViolation();

    /**
     * @notice Approve every Strategy-supported token from this tranche
     *         to Strategy (unlimited) so Strategy can pull on deposit.
     *         CDO-only; idempotent.
     */
    function configure() external;

    /**
     * @notice Burn `shares` from `owner` and record the corresponding
     *         assets as protocol fee. Permissionless; allowance spent
     *         when `caller != owner`.
     */
    function burnSharesAsFee(uint256 shares, address owner) external returns (uint256 assets);

    // @notice Maximum withdrawal denominated in `token` for `owner`.
    function maxWithdraw(address token, address owner) external view returns (uint256);

    // @notice Token-routed withdraw with explicit mode-slippage guard.
    function withdraw(
        address token,
        uint256 tokenAmount,
        address receiver,
        address owner,
        TRedemptionParams memory params
    ) external returns (uint256);

    // @notice Token-routed redeem with explicit mode-slippage guard.
    function redeem(
        address token,
        uint256 shares,
        address receiver,
        address owner,
        TRedemptionParams memory params
    ) external returns (uint256);

    /**
     * @notice Gross shares to burn to receive `assetsNet` at fee rate
     *         `fee` (1e18).
     */
    function quoteWithdraw(uint256 assetsNet, uint256 fee)
        external view returns (uint256 sharesGross);

    /**
     * @notice Net assets received for burning `sharesGross` at fee
     *         rate `fee` (1e18).
     */
    function quoteRedeem(uint256 sharesGross, uint256 fee)
        external view returns (uint256 assetsNet);

    /**
     * @notice Meta-token preview — gross shares burned to receive
     *         `tokenAmount` of `token`. Applies the public exit fee.
     */
    function previewWithdraw(address token, uint256 tokenAmount)
        external view returns (uint256 sharesGross);

    /**
     * @notice Meta-token preview — net token assets received for
     *         burning `shares`. Applies the public exit fee.
     */
    function previewRedeem(address token, uint256 shares)
        external view returns (uint256 tokenAssetsNet);
}
