// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IPrimeVault} from "./IPrimeVault.sol";
import {ICDOComponent} from "./ICDOComponent.sol";
import {TExitMode} from "./ICDO.sol";

/**
 * @title ITranche
 * @notice Tranche vault interface extending the ERC4626 standard.
 */
interface ITranche is ICDOComponent, IPrimeVault {
    /**
     * @notice User-side guard against mode slippage between submission
     *         and execution. Set `exitMode = TExitMode.Dynamic` to opt
     *         out of validation entirely (the default carried by the
     *         four-arg `withdraw`/`redeem` overloads).
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
     * @notice Approves every Strategy-supported token from this tranche
     *         to the Strategy (unlimited), so the Strategy can pull
     *         deposit assets during {ICDO.deposit}.
     * @dev    Must be callable only by the CDO. Idempotent — safe to
     *         re-call after the Strategy's supported-token list changes.
     */
    function configure() external;

    /**
     * @notice Burns `shares` from `owner` and records the corresponding
     *         assets as an accrued protocol fee.
     * @dev    Permissionless caller; allowance spent when caller != owner.
     */
    function burnSharesAsFee(uint256 shares, address owner) external returns (uint256 assets);

    /**
     * @notice Maximum withdrawal denominated in `token` for `owner`.
     * @dev    Meta-token mirror of the standard ERC4626
     *         {maxWithdraw(address)}; uses the strategy's
     *         `convertToTokens` with ceil rounding.
     */
    function maxWithdraw(address token, address owner) external view returns (uint256);

    /**
     * @notice Token-routed withdraw with explicit mode-slippage guard.
     * @dev    `params.exitMode == TExitMode.Dynamic` opts out of
     *         validation. Otherwise all three fields must equal the
     *         CDO's live `calculateExitMode` result for this caller.
     */
    function withdraw(
        address token,
        uint256 tokenAmount,
        address receiver,
        address owner,
        TRedemptionParams memory params
    ) external returns (uint256);

    /**
     * @notice Token-routed redeem with explicit mode-slippage guard.
     */
    function redeem(
        address token,
        uint256 shares,
        address receiver,
        address owner,
        TRedemptionParams memory params
    ) external returns (uint256);

    /**
     * @notice Shares to burn (gross) to receive `assetsNet` at fee rate `fee`.
     */
    function quoteWithdraw(uint256 assetsNet, uint256 fee)
        external view returns (uint256 sharesGross);

    /**
     * @notice Assets received (net) for burning `sharesGross` at fee rate `fee`.
     */
    function quoteRedeem(uint256 sharesGross, uint256 fee)
        external view returns (uint256 assetsNet);

    /**
     * @notice Meta-token preview — gross shares burned to receive
     *         `tokenAmount` of `token`. Applies the public exit fee
     *         from `calculateExitMode(this, address(0))`.
     */
    function previewWithdraw(address token, uint256 tokenAmount)
        external view returns (uint256 sharesGross);

    /**
     * @notice Meta-token preview — token assets received (net) for
     *         burning `shares`. Applies the public exit fee.
     */
    function previewRedeem(address token, uint256 shares)
        external view returns (uint256 tokenAssetsNet);
}
