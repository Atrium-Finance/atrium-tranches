// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — BaseStrategy
//  Abstract base for all yield source strategy adapters
//  See: docs/PV_V3_FINAL_v34.md section 16
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IStrategy, WithdrawResult, WithdrawType} from "../interfaces/IStrategy.sol";

/**
 * @title BaseStrategy
 * @notice Abstract base for yield source strategy adapters.
 * @dev Concrete strategies implement _deposit, _depositToken, _withdraw, _isSupported.
 *      Provides onlyCDO modifier, pause/unpause, and common deposit/withdraw routing.
 */
abstract contract BaseStrategy is Ownable2Step, Pausable, IStrategy {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    address public immutable i_primeCDO;
    address public immutable i_baseAsset;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — Emergency Guardian
    // ═══════════════════════════════════════════════════════════════════

    address public s_guardian;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event GuardianSet(address indexed guardian);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__UnsupportedToken(address token);
    error PrimeVaults__ZeroAmount();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyCDO() {
        if (msg.sender != i_primeCDO) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != s_guardian) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address primeCDO_, address baseAsset_, address owner_) Ownable(owner_) {
        i_primeCDO = primeCDO_;
        i_baseAsset = baseAsset_;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  IStrategy — MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Deposit base asset into the yield source. */
    function deposit(uint256 amount) external override onlyCDO whenNotPaused returns (uint256 shares) {
        if (amount == 0) revert PrimeVaults__ZeroAmount();
        IERC20(i_baseAsset).safeTransferFrom(msg.sender, address(this), amount);
        shares = _deposit(amount);
        emit Deposited(i_baseAsset, amount, shares);
    }

    /** @notice Deposit a supported token (may differ from base asset). */
    function depositToken(address token, uint256 amount) external override onlyCDO whenNotPaused returns (uint256 shares) {
        if (amount == 0) revert PrimeVaults__ZeroAmount();
        if (!_isSupported(token)) revert PrimeVaults__UnsupportedToken(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        shares = _depositToken(token, amount);
        emit Deposited(token, amount, shares);
    }

    /** @notice Withdraw from the yield source. */
    function withdraw(uint256 amount, address outputToken, address beneficiary) external override onlyCDO whenNotPaused returns (WithdrawResult memory result) {
        if (amount == 0) revert PrimeVaults__ZeroAmount();
        result = _withdraw(amount, outputToken, beneficiary);
    }

    /** @notice Emergency withdrawal of all assets back to the CDO. */
    function emergencyWithdraw() external override onlyCDO returns (uint256 amountOut) {
        amountOut = _emergencyWithdraw();
        emit EmergencyWithdrawn(amountOut);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  IStrategy — VIEW
    // ═══════════════════════════════════════════════════════════════════

    function baseAsset() external view override returns (address) {
        return i_baseAsset;
    }

    function isActive() external view override returns (bool) {
        return !paused();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function pause() external onlyOwnerOrGuardian {
        _pause();
    }

    function unpause() external onlyOwnerOrGuardian {
        _unpause();
    }

    /**
     * @notice Set the emergency guardian address. Only callable by owner.
     * @param guardian_ New guardian address (zero address disables guardian)
     */
    function setGuardian(address guardian_) external onlyOwner {
        s_guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ABSTRACT — implemented by concrete strategies
    // ═══════════════════════════════════════════════════════════════════

    function _deposit(uint256 amount) internal virtual returns (uint256 shares);
    function _depositToken(address token, uint256 amount) internal virtual returns (uint256 shares);
    function _withdraw(uint256 amount, address outputToken, address beneficiary) internal virtual returns (WithdrawResult memory);
    function _emergencyWithdraw() internal virtual returns (uint256 amountOut);
    function _isSupported(address token) internal view virtual returns (bool);
}
