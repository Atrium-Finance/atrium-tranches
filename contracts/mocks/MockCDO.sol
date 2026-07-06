// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ICDO, TExitMode } from "../interfaces/ICDO.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Test stand-in for PrimeCDO. Lets unit tests drive `Accounting`
 *         (calls `updateAccounting` / `updateBalanceFlow` / `accrueFee`
 *         / `reduceReserve`) while pretending to be the CDO.
 */
contract MockCDO is ICDO {
    ITranche public override jrVault;
    ITranche public override mezzVault;
    ITranche public override srVault;
    IStrategy public override strategy;
    IAccounting public accounting;

    address public override sharesCooldown;
    address public override treasury;

    uint256 public override exitFeeJr;
    uint256 public override exitFeeMz;
    uint256 public override exitFeeSr;

    // Test knobs for `calculateExitMode`.
    TExitMode public modeOverride = TExitMode.ERC4626;
    uint256 public feeOverride;
    uint32 public cooldownOverride;

    function setVaults(ITranche jr, ITranche mz, ITranche sr) external {
        jrVault = jr; mezzVault = mz; srVault = sr;
    }
    function setStrategy(IStrategy s) external { strategy = s; }
    function setAccounting(IAccounting a) external { accounting = a; }
    function setSharesCooldown(address s) external override { sharesCooldown = s; }
    function setReserveTreasury(address t) external override { treasury = t; }
    function setExitFees(uint256 jr, uint256 mz, uint256 sr) external override {
        exitFeeJr = jr; exitFeeMz = mz; exitFeeSr = sr;
    }
    function setExitMode(TExitMode m, uint256 fee, uint32 cd) external {
        modeOverride = m; feeOverride = fee; cooldownOverride = cd;
    }

    // ICDO views ---------------------------------------------------

    /// @dev Returns the tranche's own ERC20 totalSupply so ERC4626 share math
    ///      stays at 1:1 in unit tests (mock accounting buckets aren't kept
    ///      in sync on deposit, so reading them would yield zero).
    function totalAssets(address tranche) external view override returns (uint256) {
        return IERC20(tranche).totalSupply();
    }
    function kindOf(address tranche) external view override returns (TrancheKind) {
        return _kindOf(tranche);
    }
    function totalAssetsUnlocked() external view override returns (uint256 jr, uint256 mz, uint256 sr) {
        (jr, mz, sr,) = accounting.totalAssetsT0();
    }
    function coverage() external view override returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr,) = accounting.totalAssetsT0();
        if (sr == 0) return type(uint256).max;
        return ((jr + mz + sr) * 1e18) / sr;
    }
    // Use a large but bounded sentinel so `convertToShares(maxWithdraw)` in
    // Tranche doesn't overflow when totalAssets is small (mock state).
    uint256 private constant MOCK_MAX = 1e30;
    function maxWithdraw(address) external pure override returns (uint256) { return MOCK_MAX; }
    function maxWithdraw(address, address) external pure override returns (uint256) { return MOCK_MAX; }
    function maxDeposit(address) external pure override returns (uint256) { return type(uint256).max; }
    function calculateExitMode(address, address)
        external view override returns (TExitMode, uint256, uint32)
    {
        return (modeOverride, feeOverride, cooldownOverride);
    }

    // ICDO state-changing (forwarded to Accounting) -----------------

    function updateAccounting() external override {
        accounting.updateAccounting(strategy.totalAssets());
    }
    function deposit(address, address, uint256, uint256) external override {}
    function withdraw(address, address, uint256, uint256, address, address) external override {}
    function cooldownShares(address, address, uint256, address, address, uint256, uint32) external override {}
    function accrueFee(address tranche, uint256 assets) external override {
        accounting.accrueFee(tranche, assets);
    }
    function updateBalanceFlow() external override {
        accounting.updateBalanceFlow();
    }
    function updateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external override {
        accounting.updateBalanceFlow(jrIn, jrOut, mzIn, mzOut, srIn, srOut);
    }
    function reduceReserve(address, uint256 amount) external override {
        accounting.reduceReserve(amount);
    }

    // Test driver helpers ------------------------------------------

    /// @notice Push initial NAV state into accounting for canned test scenarios.
    function bumpAccounting(uint256 navTotal, uint256, uint256, uint256) external {
        accounting.updateAccounting(navTotal);
    }
    function callUpdateAccounting(uint256 navT1) external {
        accounting.updateAccounting(navT1);
    }
    function callAccrueFee(address tranche, uint256 assets) external {
        accounting.accrueFee(tranche, assets);
    }
    function callReduceReserve(uint256 amount) external {
        accounting.reduceReserve(amount);
    }
    function callUpdateBalanceFlow(
        uint256 jrIn, uint256 jrOut,
        uint256 mzIn, uint256 mzOut,
        uint256 srIn, uint256 srOut
    ) external {
        accounting.updateBalanceFlow(jrIn, jrOut, mzIn, mzOut, srIn, srOut);
    }
    function callUpdateBalanceFlowNoArg() external {
        accounting.updateBalanceFlow();
    }

    // Strategy forwarders — let unit tests drive Strategy as if MockCDO is
    // the gating PrimeCDO. Real coverage / pause checks are skipped.

    function callStrategyDeposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner
    ) external returns (uint256) {
        return strategy.deposit(tranche, token, tokenAmount, baseAssets, owner);
    }

    function callStrategyWithdraw6(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver
    ) external returns (uint256) {
        return strategy.withdraw(tranche, token, tokenAmount, baseAssets, sender, receiver);
    }

    function callStrategyWithdraw7(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver,
        bool shouldSkipCooldown
    ) external returns (uint256) {
        return strategy.withdraw(tranche, token, tokenAmount, baseAssets, sender, receiver, shouldSkipCooldown);
    }

    function callStrategyReduceReserve(address token, uint256 amount, address treasuryAddr) external {
        strategy.reduceReserve(token, amount, treasuryAddr);
    }

    // Internal -----------------------------------------------------

    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(jrVault)) return TrancheKind.JUNIOR;
        if (tranche == address(mezzVault)) return TrancheKind.MEZZANINE;
        return TrancheKind.SENIOR;
    }
}
