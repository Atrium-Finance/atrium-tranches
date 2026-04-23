// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — PrimeCDO
//  Core orchestrator for a PrimeVaults market (1 CDO = 1 Strategy)
//  See: docs/PV_V3_FINAL_v34.md section 18
// ══════════════════════════════════════════════════════════════════════

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IPrimeCDO, TrancheId, CooldownType, CDOWithdrawResult } from "../interfaces/IPrimeCDO.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { IStrategy, WithdrawResult, WithdrawType } from "../interfaces/IStrategy.sol";
import { ICooldownHandler, CooldownRequest } from "../interfaces/ICooldownHandler.sol";
import { IAprPairFeed } from "../interfaces/IAprPairFeed.sol";
import { RedemptionPolicy } from "../cooldown/RedemptionPolicy.sol";

/** @dev Minimal interface to burn shares on TrancheVault after SHARES_LOCK claim. */
interface ITrancheVaultBurn {
    function burnSharesFrom(address account, uint256 shares) external;
}

/**
 * @title PrimeCDO
 * @notice Core orchestrator connecting TrancheVaults to a single Strategy via Accounting.
 * @dev Handles deposit routing, coverage gates, and cooldown management.
 *      All three tranches are base-asset only. 1 CDO = 1 Strategy (Strata model).
 *      See docs/PV_V3_COVERAGE_GATE.md for coverage gate logic.
 */
contract PrimeCDO is Ownable2Step, IPrimeCDO {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAccounting public immutable i_accounting;
    IStrategy public immutable i_strategy;
    IAprPairFeed public immutable i_aprFeed;
    RedemptionPolicy public immutable i_redemptionPolicy;
    ICooldownHandler public immutable i_erc20Cooldown;
    ICooldownHandler public immutable i_sharesCooldown;
    address public immutable i_outputToken;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — Tranches
    // ═══════════════════════════════════════════════════════════════════

    mapping(TrancheId => address) public s_tranches;
    mapping(address => TrancheId) public s_vaultToTranche;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — Coverage Gate
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_minCoverageForDeposit; // 1.05e18
    uint256 public s_juniorShortfallPausePrice; // 0.90e18
    bool public s_shortfallPaused;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — Emergency Guardian
    // ═══════════════════════════════════════════════════════════════════

    address public s_guardian;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event ShortfallPauseTriggered(uint256 pricePerShare, uint256 threshold);
    event ShortfallUnpaused();
    event TrancheRegistered(TrancheId indexed tranche, address vault);
    event GuardianSet(address indexed guardian);
    event EmergencyPauseTriggered(address indexed guardian);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__ShortfallPaused();
    error PrimeVaults__CoverageTooLow(uint256 current, uint256 minimum);
    error PrimeVaults__ZeroAmount();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyTranche(TrancheId id) {
        if (msg.sender != s_tranches[id]) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    modifier whenNotShortfallPaused() {
        if (s_shortfallPaused) revert PrimeVaults__ShortfallPaused();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != s_guardian) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != s_guardian) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address accounting_,
        address strategy_,
        address aprFeed_,
        address redemptionPolicy_,
        address erc20Cooldown_,
        address sharesCooldown_,
        address outputToken_,
        address owner_
    ) Ownable(owner_) {
        i_accounting = IAccounting(accounting_);
        i_strategy = IStrategy(strategy_);
        i_aprFeed = IAprPairFeed(aprFeed_);
        i_redemptionPolicy = RedemptionPolicy(redemptionPolicy_);
        i_erc20Cooldown = ICooldownHandler(erc20Cooldown_);
        i_sharesCooldown = ICooldownHandler(sharesCooldown_);
        i_outputToken = outputToken_;

        // Defaults
        s_minCoverageForDeposit = 1.05e18; // 105%
        s_juniorShortfallPausePrice = 0.90e18; // 90%
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT — All tranches
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit base asset into any tranche.
     * @dev Coverage gate: reverts if coverage < 105% for Sr/Mz. Junior always allowed.
     *      See docs/PV_V3_COVERAGE_GATE.md section 3.
     */
    function deposit(
        TrancheId tranche,
        address token,
        uint256 amount
    ) external override onlyTranche(tranche) whenNotShortfallPaused returns (uint256 baseAmount) {
        if (amount == 0) revert PrimeVaults__ZeroAmount();

        // 1. Update accounting
        _updateAccounting();

        // 2. Per-tranche coverage gate (Junior always allowed — increases coverage)
        if (tranche != TrancheId.JUNIOR) {
            uint256 coverage;
            if (tranche == TrancheId.SENIOR) coverage = _getCoverageSenior();
            else coverage = _getCoverageMezz();

            if (coverage < s_minCoverageForDeposit)
                revert PrimeVaults__CoverageTooLow(coverage, s_minCoverageForDeposit);
        }

        // 3. Route tokens directly to strategy
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(i_strategy), amount);
        i_strategy.depositToken(token, amount);

        // 4. Convert to base-equivalent
        //    If depositing sUSDai (yield-bearing), convert shares → assets via current exchange rate.
        //    Otherwise (base asset USDai): 1:1.
        if (token == i_outputToken) baseAmount = IERC4626(i_outputToken).convertToAssets(amount);
        else baseAmount = amount;

        i_accounting.recordDeposit(tranche, baseAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — IPrimeCDO
    // ═══════════════════════════════════════════════════════════════════

    function accounting() external view override returns (address) {
        return address(i_accounting);
    }

    function strategy() external view override returns (address) {
        return address(i_strategy);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW — All tranches
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request withdrawal from any tranche.
     * @dev Flow: update accounting → compute fee → route to mechanism.
     *      Mechanism selected by RedemptionPolicy based on per-tranche coverage.
     */
    function requestWithdraw(
        TrancheId tranche,
        uint256 baseAmount,
        address beneficiary,
        uint256 vaultShares
    ) external override onlyTranche(tranche) whenNotShortfallPaused returns (CDOWithdrawResult memory result) {
        if (baseAmount == 0) revert PrimeVaults__ZeroAmount();
        _updateAccounting();

        // Fee from RedemptionPolicy
        RedemptionPolicy.PolicyResult memory policy = i_redemptionPolicy.evaluate(tranche);
        uint256 feeAmount = (baseAmount * policy.feeBps) / 10_000;
        uint256 netAmount = baseAmount - feeAmount;
        if (feeAmount > 0) i_accounting.recordFee(tranche, feeAmount);

        // Route to mechanism (duration from RedemptionPolicy — single source of truth)
        if (policy.mechanism == RedemptionPolicy.CooldownMechanism.NONE) {
            result = _withdrawInstant(tranche, netAmount, beneficiary, feeAmount);
        } else if (policy.mechanism == RedemptionPolicy.CooldownMechanism.ASSETS_LOCK) {
            result = _withdrawAssetsLock(tranche, netAmount, beneficiary, feeAmount, policy.cooldownDuration);
        } else {
            result = _withdrawSharesLock(tranche, beneficiary, vaultShares, feeAmount, policy.cooldownDuration);
        }
    }

    /**
     * @dev NONE mechanism: withdraw from strategy directly to beneficiary.
     *      Always withdraws sUSDai (i_outputToken) — instant transfer from strategy.
     */
    function _withdrawInstant(
        TrancheId tranche,
        uint256 netAmount,
        address beneficiary,
        uint256 feeAmount
    ) internal returns (CDOWithdrawResult memory) {
        WithdrawResult memory wr = i_strategy.withdraw(netAmount, i_outputToken, beneficiary);
        i_accounting.recordWithdraw(tranche, netAmount);

        return
            CDOWithdrawResult({
                isInstant: true,
                amountOut: wr.amountOut,
                cooldownId: 0,
                cooldownHandler: address(0),
                unlockTime: 0,
                feeAmount: feeAmount,
                appliedCooldownType: CooldownType.NONE
            });
    }

    /**
     * @dev ASSETS_LOCK mechanism: withdraw sUSDai from strategy to CDO, then lock in ERC20Cooldown.
     *      Always uses i_outputToken (sUSDai) — strategy returns INSTANT.
     */
    function _withdrawAssetsLock(
        TrancheId tranche,
        uint256 netAmount,
        address beneficiary,
        uint256 feeAmount,
        uint256 cooldownDuration
    ) internal returns (CDOWithdrawResult memory) {
        // Withdraw sUSDai to CDO (not beneficiary) so we can lock in cooldown
        WithdrawResult memory wr = i_strategy.withdraw(netAmount, i_outputToken, address(this));
        i_accounting.recordWithdraw(tranche, netAmount);

        // Strategy returned sUSDai to CDO → lock in ERC20Cooldown
        IERC20(i_outputToken).forceApprove(address(i_erc20Cooldown), wr.amountOut);
        uint256 requestId = i_erc20Cooldown.request(beneficiary, i_outputToken, wr.amountOut, cooldownDuration);

        return
            CDOWithdrawResult({
                isInstant: false,
                amountOut: 0,
                cooldownId: requestId,
                cooldownHandler: address(i_erc20Cooldown),
                unlockTime: 0,
                feeAmount: feeAmount,
                appliedCooldownType: CooldownType.ASSETS_LOCK
            });
    }

    /**
     * @dev SHARES_LOCK mechanism: escrow vault shares in SharesCooldown.
     *      Strategy NOT touched — shares stay in totalSupply → TVL preserved → coverage stable.
     *      At claim via claimSharesWithdraw(): shares return to CDO, converted at current rate.
     */
    function _withdrawSharesLock(
        TrancheId tranche,
        address beneficiary,
        uint256 vaultShares,
        uint256 feeAmount,
        uint256 cooldownDuration
    ) internal returns (CDOWithdrawResult memory) {
        address vault = s_tranches[tranche];
        IERC20(vault).safeTransferFrom(msg.sender, address(this), vaultShares);
        IERC20(vault).forceApprove(address(i_sharesCooldown), vaultShares);
        uint256 requestId = i_sharesCooldown.request(beneficiary, vault, vaultShares, cooldownDuration);

        // Do NOT recordWithdraw — shares still in totalSupply, TVL unchanged
        return
            CDOWithdrawResult({
                isInstant: false,
                amountOut: 0,
                cooldownId: requestId,
                cooldownHandler: address(i_sharesCooldown),
                unlockTime: 0,
                feeAmount: feeAmount,
                appliedCooldownType: CooldownType.SHARES_LOCK
            });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CLAIM
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim a completed ERC20Cooldown (ASSETS_LOCK) withdrawal.
     * @dev Delegates to a whitelisted cooldown handler. Callable by anyone.
     *      Tokens are released directly from the cooldown handler to the beneficiary.
     */
    function claimWithdraw(uint256 cooldownId, address cooldownHandler) external override returns (uint256 amountOut) {
        if (cooldownHandler != address(i_erc20Cooldown)) revert PrimeVaults__Unauthorized(cooldownHandler);
        amountOut = ICooldownHandler(cooldownHandler).claim(cooldownId);
    }

    /**
     * @notice Claim a completed SharesCooldown (SHARES_LOCK) withdrawal.
     * @dev Flow: claim shares from SharesCooldown → CDO receives vault shares →
     *      compute base value at current exchange rate → withdraw from strategy → send to beneficiary.
     *      User benefits from yield accrued during cooldown (shares appreciated).
     *      Callable by anyone.
     */
    function claimSharesWithdraw(uint256 cooldownId) external override returns (uint256 amountOut) {
        // 1. Claim shares from SharesCooldown → shares come back to this CDO
        CooldownRequest memory req = i_sharesCooldown.getRequest(cooldownId);
        uint256 sharesReturned = i_sharesCooldown.claim(cooldownId);

        // 2. Determine tranche from the vault token stored in the request
        address vault = req.token;
        TrancheId tranche = s_vaultToTranche[vault];

        _updateAccounting();
        uint256 totalSupply = IERC20(vault).totalSupply();

        // 3. Compute base value of shares at current exchange rate
        uint256 baseTVL = i_accounting.getTrancheTVL(tranche);
        uint256 baseAmount = totalSupply > 0 ? (sharesReturned * baseTVL) / totalSupply : 0;

        // 4. Record withdraw and withdraw from strategy to beneficiary
        i_accounting.recordWithdraw(tranche, baseAmount);
        WithdrawResult memory wr = i_strategy.withdraw(baseAmount, i_outputToken, req.beneficiary);
        amountOut = wr.amountOut;

        // 5. Burn the returned shares (were escrowed, not burned at request time)
        ITrancheVaultBurn(vault).burnSharesFrom(address(this), sharesReturned);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function registerTranche(TrancheId id, address vault) external onlyOwner {
        s_tranches[id] = vault;
        s_vaultToTranche[vault] = id;
        emit TrancheRegistered(id, vault);
    }

    function setMinCoverageForDeposit(uint256 minCoverage) external onlyOwner {
        s_minCoverageForDeposit = minCoverage;
    }

    function setJuniorShortfallPausePrice(uint256 price) external onlyOwner {
        s_juniorShortfallPausePrice = price;
    }

    function unpauseShortfall() external onlyOwnerOrGuardian {
        s_shortfallPaused = false;
        emit ShortfallUnpaused();
    }

    /**
     * @notice Manually trigger emergency pause. Only callable by guardian.
     * @dev Bypasses the automatic junior price-based trigger for emergency situations.
     */
    function triggerShortfallPause() external onlyGuardian {
        s_shortfallPaused = true;
        emit EmergencyPauseTriggered(msg.sender);
    }

    /**
     * @notice Set the emergency guardian address. Only callable by owner.
     * @param guardian_ New guardian address (zero address disables guardian)
     */
    function setGuardian(address guardian_) external onlyOwner {
        s_guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /**
     * @notice Claim accumulated reserve (fees + gain cuts) to a recipient.
     * @dev Withdraws reserve amount from strategy as sUSDai → transfers to recipient.
     * @param recipient Address that will receive the sUSDai
     * @return amountOut sUSDai amount sent to recipient
     */
    function claimReserve(address recipient) external onlyOwner returns (uint256 amountOut) {
        if (recipient == address(0)) revert PrimeVaults__ZeroAmount();
        uint256 reserveAmount = i_accounting.claimReserve();
        if (reserveAmount == 0) return 0;
        WithdrawResult memory wr = i_strategy.withdraw(reserveAmount, i_outputToken, recipient);
        amountOut = wr.amountOut;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Sync APR feed and Accounting with current strategy state.
     *      Pushes fresh APR data on every deposit/withdraw — no keeper dependency.
     */
    function _updateAccounting() internal {
        uint256 strategyTVL = i_strategy.totalAssets();
        i_accounting.updateTVL(strategyTVL);

        // Check shortfall AFTER strategy gain/loss reconciliation but BEFORE any
        // user-initiated TVL change (deposit/withdraw). This way the check sees
        // the true post-loss state, not transient mid-withdraw state.
        _checkJuniorShortfall();
    }

    /**
     * @dev Senior coverage: cs = (Sr + Mz + Jr) / Sr.
     *      If Sr=0: empty protocol → max (allow first deposit).
     */
    function _getCoverageSenior() internal view returns (uint256) {
        (uint256 sr, uint256 mz, uint256 jr) = i_accounting.getAllTVLs();
        if (sr == 0) {
            if (mz + jr > 0) return type(uint256).max; // Sr doesn't exist yet, no gate needed
            return type(uint256).max; // empty protocol → allow first deposit
        }
        return ((sr + mz + jr) * PRECISION) / sr;
    }

    /**
     * @dev Mezzanine coverage: cm = (Mz + Jr) / Mz.
     *      If Mz=0: empty → max (allow first deposit).
     */
    function _getCoverageMezz() internal view returns (uint256) {
        (, uint256 mz, uint256 jr) = i_accounting.getAllTVLs();
        if (mz == 0) {
            if (jr > 0) return type(uint256).max; // Mz doesn't exist yet
            return type(uint256).max; // empty
        }
        return ((mz + jr) * PRECISION) / mz;
    }

    /**
     * @dev Auto-pause if Junior exchange rate drops below threshold.
     *      See docs/PV_V3_COVERAGE_GATE.md section 5.
     */
    function _checkJuniorShortfall() internal {
        if (s_juniorShortfallPausePrice == 0) return;

        address juniorVault = s_tranches[TrancheId.JUNIOR];
        if (juniorVault == address(0)) return;

        uint256 totalAssets = i_accounting.getJuniorTVL();
        uint256 totalSupply = IERC20(juniorVault).totalSupply();

        if (totalSupply == 0) return;

        uint256 pricePerShare = (totalAssets * PRECISION) / totalSupply;

        if (pricePerShare < s_juniorShortfallPausePrice) {
            s_shortfallPaused = true;
            emit ShortfallPauseTriggered(pricePerShare, s_juniorShortfallPausePrice);
        }
    }
}
