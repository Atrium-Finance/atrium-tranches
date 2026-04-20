// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IStrategy, WithdrawResult, WithdrawType} from "../../interfaces/IStrategy.sol";

/**
 * @dev Mock strategy that supports instant deposits and withdrawals for testing.
 *      Holds base asset directly (no yield source). 1:1 deposit/withdraw.
 */
contract MockStrategy is IStrategy {
    using SafeERC20 for IERC20;

    address public immutable i_primeCDO;
    address public immutable i_baseAsset;
    bool public s_active;
    address public s_outputToken;

    error PrimeVaults__Unauthorized(address caller);

    modifier onlyCDO() {
        if (msg.sender != i_primeCDO) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    constructor(address primeCDO_, address baseAsset_) {
        i_primeCDO = primeCDO_;
        i_baseAsset = baseAsset_;
        s_active = true;
    }

    function deposit(uint256 amount) external override onlyCDO returns (uint256 shares) {
        IERC20(i_baseAsset).safeTransferFrom(msg.sender, address(this), amount);
        shares = amount;
        emit Deposited(i_baseAsset, amount, shares);
    }

    function depositToken(address token, uint256 amount) external override onlyCDO returns (uint256 shares) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        shares = amount;
        emit Deposited(token, amount, shares);
    }

    function withdraw(uint256 amount, address, address beneficiary) external override onlyCDO returns (WithdrawResult memory result) {
        uint256 available = IERC20(i_baseAsset).balanceOf(address(this));
        uint256 amountOut = amount > available ? available : amount;
        IERC20(i_baseAsset).safeTransfer(beneficiary, amountOut);
        result = WithdrawResult({wType: WithdrawType.INSTANT, amountOut: amountOut, cooldownId: 0, cooldownHandler: address(0), unlockTime: 0});
        emit Withdrawn(i_baseAsset, amountOut, amountOut);
    }

    function emergencyWithdraw() external override onlyCDO returns (uint256 amountOut) {
        amountOut = IERC20(i_baseAsset).balanceOf(address(this));
        IERC20(i_baseAsset).safeTransfer(i_primeCDO, amountOut);
        emit EmergencyWithdrawn(amountOut);
    }

    function totalAssets() external view override returns (uint256) {
        uint256 total = IERC20(i_baseAsset).balanceOf(address(this));
        if (s_outputToken != address(0)) {
            uint256 outputBal = IERC20(s_outputToken).balanceOf(address(this));
            if (outputBal > 0) total += IERC4626(s_outputToken).convertToAssets(outputBal);
        }
        return total;
    }

    function setOutputToken(address token) external {
        s_outputToken = token;
    }

    function baseAsset() external view override returns (address) {
        return i_baseAsset;
    }

    function supportedTokens() external view override returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = i_baseAsset;
    }

    function predictWithdrawType(address) external pure override returns (WithdrawType) {
        return WithdrawType.INSTANT;
    }

    function getCooldownHandlers() external pure override returns (address[] memory) {
        return new address[](0);
    }

    function name() external pure override returns (string memory) {
        return "Mock Strategy";
    }

    function isActive() external view override returns (bool) {
        return s_active;
    }
}
