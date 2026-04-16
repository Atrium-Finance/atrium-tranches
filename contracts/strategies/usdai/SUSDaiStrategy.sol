// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SUSDaiStrategy
//  Strategy adapter for sUSDai (ERC-4626 deposit + ERC-7540 FIFO redeem)
//  See: docs/PV_V3_APR_ORACLE.md section 9
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WithdrawResult, WithdrawType} from "../../interfaces/IStrategy.sol";
import {BaseStrategy} from "../BaseStrategy.sol";

/**
 * @dev Minimal sUSDai interface matching actual Arbiscan ABI.
 *      ERC-4626 deposit (sync) + ERC-7540 FIFO queue redeem (async).
 */
interface IStakedUSDai {
    // ERC-4626
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);

    // ERC-7540 FIFO queue
    struct Redemption {
        uint256 prev;
        uint256 next;
        uint256 pendingShares;
        uint256 redeemableShares;
        uint256 withdrawableAmount;
        address controller;
        uint64 redemptionTimestamp;
    }

    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 redemptionId);
    function redemption(uint256 redemptionId) external view returns (Redemption memory, uint256);
    function claimableRedeemRequest(uint256 redemptionId, address controller) external view returns (uint256);
    function pendingRedeemRequest(uint256 redemptionId, address controller) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address controller) external returns (uint256);
    function redemptionIds(address controller) external view returns (uint256[] memory);
}

/**
 * @title SUSDaiStrategy
 * @notice Strategy adapter for USD.AI sUSDai vault on Arbitrum.
 * @dev Deposit: USDai → sUSDai.deposit() (synchronous, ERC-4626).
 *      Deposit sUSDai directly: just holds it (already yield-bearing).
 *      Withdraw: always instant sUSDai transfer. Users convert sUSDai → USD.AI
 *      via the sUSDai ERC-7540 FIFO queue directly.
 *      sUSDai: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9 (Arbitrum)
 *      USDai:  0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF (Arbitrum)
 */
contract SUSDaiStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IStakedUSDai public immutable i_sUSDai;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address primeCDO_, address usdai_, address sUSDai_, address owner_) BaseStrategy(primeCDO_, usdai_, owner_) {
        i_sUSDai = IStakedUSDai(sUSDai_);
        IERC20(usdai_).approve(sUSDai_, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  IStrategy — VIEW
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Total base-equivalent value: sUSDai balance converted to USDai. */
    function totalAssets() external view override returns (uint256) {
        uint256 shares = i_sUSDai.balanceOf(address(this));
        return i_sUSDai.convertToAssets(shares);
    }

    /** @notice Supported deposit tokens: [USDai, sUSDai]. */
    function supportedTokens() external view override returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = i_baseAsset;
        tokens[1] = address(i_sUSDai);
    }

    /**
     * @notice Predict withdrawal type for a given output token.
     * @dev Only sUSDai is supported — always INSTANT (direct transfer).
     */
    function predictWithdrawType(address outputToken) external view override returns (WithdrawType) {
        if (outputToken == address(i_sUSDai)) return WithdrawType.INSTANT;
        revert PrimeVaults__UnsupportedToken(outputToken);
    }

    function getCooldownHandlers() external pure override returns (address[] memory) {
        return new address[](0);
    }

    function name() external pure override returns (string memory) {
        return "PrimeVaults sUSDai Strategy";
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — deposit
    // ═══════════════════════════════════════════════════════════════════

    function _deposit(uint256 amount) internal override returns (uint256 shares) {
        shares = i_sUSDai.deposit(amount, address(this));
    }

    function _depositToken(address token, uint256 amount) internal override returns (uint256 shares) {
        if (token == i_baseAsset) {
            shares = i_sUSDai.deposit(amount, address(this));
        } else if (token == address(i_sUSDai)) {
            shares = amount; // already transferred by BaseStrategy
        } else {
            revert PrimeVaults__UnsupportedToken(token);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — withdraw
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Withdraw logic: always instant sUSDai transfer.
     *      Only sUSDai output is supported — users convert sUSDai → USD.AI
     *      via the sUSDai ERC-7540 FIFO queue directly.
     */
    function _withdraw(uint256 amount, address outputToken, address beneficiary) internal override returns (WithdrawResult memory result) {
        if (outputToken != address(i_sUSDai)) revert PrimeVaults__UnsupportedToken(outputToken);

        uint256 shares = i_sUSDai.convertToShares(amount);
        i_sUSDai.transfer(beneficiary, shares);
        result = WithdrawResult({wType: WithdrawType.INSTANT, amountOut: shares, cooldownId: 0, cooldownHandler: address(0), unlockTime: 0});
        emit Withdrawn(outputToken, amount, shares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — emergency
    // ═══════════════════════════════════════════════════════════════════

    function _emergencyWithdraw() internal override returns (uint256 amountOut) {
        uint256 shares = i_sUSDai.balanceOf(address(this));
        amountOut = i_sUSDai.convertToAssets(shares);
        i_sUSDai.transfer(i_primeCDO, shares);
    }

    function _isSupported(address token) internal view override returns (bool) {
        return token == i_baseAsset || token == address(i_sUSDai);
    }
}
