// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { AccessControlled } from "../governance/AccessControlled.sol";

import { ICDO, TExitMode } from "../interfaces/ICDO.sol";
import { ICDOComponent } from "../interfaces/ICDOComponent.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";
import { ISharesCooldown } from "../interfaces/cooldown/ISharesCooldown.sol";

/**
 * @title  PrimeCDO
 * @notice Primary CDO orchestrator. Owns component wiring, deposit
 *         and withdraw routing, coverage gating, the silo glue, and
 *         the treasury drain.
 * @dev    Storage layout (own tail, append-only):
 *         - `_jrVault`, `_mezzVault`, `_srVault`           (3 slots)
 *         - `_accounting`, `_strategy`, `sharesCooldown`   (3 slots)
 *         - `exitFeeJr`, `exitFeeMz`, `exitFeeSr`,
 *           `treasury`                                     (4 slots)
 *         - `actionsJr`, `actionsMezz`, `actionsSr`        (3 packed slots)
 *         - `__gap[42]`                                    (42 reserved)
 */
contract PrimeCDO is AccessControlled, ICDO {
    // @notice Per-tranche enable flags. Both bools pack into one slot.
    struct TActionState {
        bool isDepositEnabled;
        bool isWithdrawEnabled;
    }

    // @notice Minimum coverage ratio `pool / srNav`, 1e18. 5% buffer.
    uint256 public constant MIN_COVERAGE = 1.05e18;

    // @notice Hard cap on per-tranche fallback exit fee, 1e18.
    uint256 public constant MAX_EXIT_FEE = 0.1e18;

    ITranche internal _jrVault;
    ITranche internal _mezzVault;
    ITranche internal _srVault;

    IAccounting internal _accounting;
    IStrategy internal _strategy;

    /**
     * @notice SharesCooldown silo. `address(0)` disables silo-aware
     *         coverage.
     */
    address public override sharesCooldown;

    uint256 public override exitFeeJr;
    uint256 public override exitFeeMz;
    uint256 public override exitFeeSr;

    // @notice Recipient wallet for reserve outflows.
    address public override treasury;

    TActionState public actionsJr;
    TActionState public actionsMezz;
    TActionState public actionsSr;

    event Configured(
        address indexed jrVault,
        address indexed mezzVault,
        address indexed srVault,
        address accounting,
        address strategy
    );
    event DepositsStateChanged(address indexed tranche, bool enabled);
    event WithdrawalsStateChanged(address indexed tranche, bool enabled);
    event SharesCooldownChanged(address indexed sharesCooldown);
    event ExitFeesSet(uint256 jr, uint256 mz, uint256 sr);
    event TreasurySet(address treasury);
    event ReserveReduced(address token, uint256 amount);

    error InvalidComponent(address component, address expectedCDO, address actualCDO);
    error UnauthorizedTranche(address caller);
    error TokenNotSupported(address token);
    error InvalidTranche(address tranche);
    error DepositsDisabled(address tranche);
    error WithdrawalsDisabled(address tranche);
    error CoverageBelowMinimum(uint256 current, uint256 postAction);
    error SharesCooldownUnchanged();
    error ZeroAmount();
    error WithdrawalCapReached(address tranche);
    error InvalidExitFee(uint256 value);

    uint256[42] private __gap;

    /**
     * @notice Initialise the proxy. Components wired separately via
     *         {config}.
     */
    function initialize(address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
    }

    modifier onlyTranche() {
        if (msg.sender != address(_jrVault) && msg.sender != address(_mezzVault) && msg.sender != address(_srVault)) {
            revert UnauthorizedTranche(msg.sender);
        }
        _;
    }

    /**
     * @notice Atomically wire the five core components. Each must
     *         report this CDO via {ICDOComponent.getCDOAddress};
     *         re-callable to rewire.
     */
    function config(address jr, address mz, address sr, address accounting_, address strategy_) external onlyOwner {
        _requireNonZero(jr);
        _requireNonZero(mz);
        _requireNonZero(sr);
        _requireNonZero(accounting_);
        _requireNonZero(strategy_);

        _requireBackRef(jr);
        _requireBackRef(mz);
        _requireBackRef(sr);
        _requireBackRef(accounting_);
        _requireBackRef(strategy_);

        _jrVault = ITranche(jr);
        _mezzVault = ITranche(mz);
        _srVault = ITranche(sr);
        _accounting = IAccounting(accounting_);
        _strategy = IStrategy(strategy_);

        // `_strategy` must be set before `configure()` — Tranche reads
        // `cdo.strategy()` inside its allowance-priming loop.
        _jrVault.configure();
        _mezzVault.configure();
        _srVault.configure();

        emit Configured(jr, mz, sr, accounting_, strategy_);
    }

    function jrVault() external view returns (ITranche) {
        return _jrVault;
    }

    function mezzVault() external view returns (ITranche) {
        return _mezzVault;
    }

    function srVault() external view returns (ITranche) {
        return _srVault;
    }

    function strategy() external view returns (IStrategy) {
        return _strategy;
    }

    function accounting() external view returns (IAccounting) {
        return _accounting;
    }

    // @inheritdoc ICDO
    function totalAssets(address tranche) external view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        (uint256 jr, uint256 mz, uint256 sr,) = _accounting.totalAssetsT0();
        if (kind == TrancheKind.JUNIOR) return jr;
        if (kind == TrancheKind.MEZZANINE) return mz;
        return sr;
    }

    // @inheritdoc ICDO
    function kindOf(address tranche) external view returns (TrancheKind) {
        return _kindOf(tranche);
    }

    // @inheritdoc ICDO
    function updateAccounting() external onlyTranche {
        _accounting.updateAccounting(_strategy.totalAssets());
    }

    // @inheritdoc ICDO
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets
    ) external override onlyTranche nonReentrant {
        tranche;

        _requireSupported(token);

        if (!_actionsOf(msg.sender).isDepositEnabled) {
            revert DepositsDisabled(msg.sender);
        }

        if (_kindOf(msg.sender) == TrancheKind.SENIOR) {
            // Coverage gate evaluated on accounting units, not raw tokens.
            if (baseAssets > _maxSrDeposit()) {
                revert CoverageBelowMinimum(_coverage(), _projectedCoverageAfterSrDeposit(baseAssets));
            }
        }

        // Pattern B/3: Strategy pulls directly from the calling Tranche.
        _strategy.deposit(msg.sender, token, tokenAmount, baseAssets, msg.sender);

        // Record the inflow so the tranche bucket and `nav` grow by the
        // deposited principal. Without this the deposit surfaces as a
        // positive strategy delta on the next updateAccounting and is
        // mis-distributed as yield (reserve skim + cross-tranche split).
        _recordDeposit(_kindOf(msg.sender), baseAssets);
    }

    /**
     * @inheritdoc ICDO
     * @dev    `owner_ == sharesCooldown` flips `isSharesLockup = true` —
     *         the silo is finalising and the user already served the
     *         lock there, so Strategy's own cooldown is skipped.
     */
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner_,
        address receiver
    ) external override onlyTranche nonReentrant {
        tranche;
        if (tokenAmount == 0 || baseAssets == 0) revert ZeroAmount();

        if (!_actionsOf(msg.sender).isWithdrawEnabled) {
            revert WithdrawalsDisabled(msg.sender);
        }

        TrancheKind kind = _kindOf(msg.sender);
        if (kind != TrancheKind.SENIOR) {
            if (baseAssets > _maxWithdraw(msg.sender)) {
                revert CoverageBelowMinimum(_coverage(), _projectedCoverageAfterSubWithdraw(baseAssets));
            }
        }

        bool isSharesLockup = owner_ == sharesCooldown && sharesCooldown != address(0);

        _strategy.withdraw(msg.sender, token, tokenAmount, baseAssets, owner_, receiver, isSharesLockup);

        _recordWithdraw(kind, baseAssets);
    }

    // @inheritdoc ICDO
    function calculateExitMode(
        address tranche,
        address owner
    ) external view override returns (TExitMode mode, uint256 fee, uint32 cooldownSeconds) {
        address silo = sharesCooldown;
        if (silo != address(0)) {
            // Silo-as-owner short-circuits so finalisation doesn't re-lock.
            if (owner == silo) {
                return (TExitMode.ERC4626, 0, 0);
            }

            uint256 cov = _coverage();
            ISharesCooldown.TExitParams memory exit = ISharesCooldown(silo).calculateExitParams(tranche, cov);

            fee = exit.feeBps;

            if (exit.sharesLock > 0) {
                return (TExitMode.SharesLock, fee, exit.sharesLock);
            }
        }

        if (fee == 0) {
            TrancheKind kind = _kindOf(tranche);
            if (kind == TrancheKind.JUNIOR) {
                fee = exitFeeJr;
            } else if (kind == TrancheKind.MEZZANINE) {
                fee = exitFeeMz;
            } else {
                fee = exitFeeSr;
            }
        }

        return (TExitMode.Fee, fee, 0);
    }

    /**
     * @inheritdoc ICDO
     * @dev    No coverage gate: low coverage already routes through the
     *         silo's harshest range — a second hard gate would block
     *         users from the throttle that exists for that case.
     */
    function cooldownShares(
        address tranche,
        address token,
        uint256 shares,
        address sender,
        address receiver,
        uint256 fee,
        uint32 cooldownSeconds
    ) external override onlyTranche nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (!_actionsOf(msg.sender).isWithdrawEnabled) revert WithdrawalsDisabled(msg.sender);
        if (sharesCooldown == address(0)) revert SharesCooldownUnchanged();

        ISharesCooldown(sharesCooldown).requestRedeem(
            ITranche(tranche),
            token,
            sender,
            receiver,
            shares,
            fee,
            cooldownSeconds
        );
    }

    // @inheritdoc ICDO
    function accrueFee(address tranche, uint256 assets) external override onlyTranche {
        _accounting.accrueFee(tranche, assets);
    }

    // @inheritdoc ICDO
    function updateBalanceFlow() external override onlyTranche {
        _accounting.updateBalanceFlow();
    }

    // @inheritdoc ICDO
    function updateBalanceFlow(
        uint256 jrIn,
        uint256 jrOut,
        uint256 mzIn,
        uint256 mzOut,
        uint256 srIn,
        uint256 srOut
    ) external override onlyTranche {
        _accounting.updateBalanceFlow(jrIn, jrOut, mzIn, mzOut, srIn, srOut);
    }

    // @inheritdoc ICDO
    function setExitFees(uint256 jr, uint256 mz, uint256 sr) external override onlyOwner {
        if (jr > MAX_EXIT_FEE) revert InvalidExitFee(jr);
        if (mz > MAX_EXIT_FEE) revert InvalidExitFee(mz);
        if (sr > MAX_EXIT_FEE) revert InvalidExitFee(sr);
        exitFeeJr = jr;
        exitFeeMz = mz;
        exitFeeSr = sr;
        emit ExitFeesSet(jr, mz, sr);
    }

    // @inheritdoc ICDO
    function setReserveTreasury(address treasury_) external override onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /**
     * @inheritdoc ICDO
     * @dev    `Math.Rounding.Floor` favours protocol on the
     *         `tokenAmount → baseAssets` conversion: the reserve
     *         bucket is debited slightly less than the strict
     *         equivalent so rounding alone never overdrives it.
     */
    function reduceReserve(address token, uint256 amount) external override onlyRole(RESERVE_MANAGER_ROLE) {
        if (treasury == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 baseAssets = _strategy.convertToAssets(token, amount, Math.Rounding.Floor);

        _accounting.reduceReserve(baseAssets);

        _strategy.reduceReserve(token, amount, treasury);

        emit ReserveReduced(token, amount);
    }

    function _recordDeposit(TrancheKind kind, uint256 baseAssets) internal {
        uint256 jrIn = kind == TrancheKind.JUNIOR ? baseAssets : 0;
        uint256 mzIn = kind == TrancheKind.MEZZANINE ? baseAssets : 0;
        uint256 srIn = kind == TrancheKind.SENIOR ? baseAssets : 0;
        _accounting.updateBalanceFlow(jrIn, 0, mzIn, 0, srIn, 0);
    }

    function _recordWithdraw(TrancheKind kind, uint256 baseAssets) internal {
        uint256 jrOut = kind == TrancheKind.JUNIOR ? baseAssets : 0;
        uint256 mzOut = kind == TrancheKind.MEZZANINE ? baseAssets : 0;
        uint256 srOut = kind == TrancheKind.SENIOR ? baseAssets : 0;
        _accounting.updateBalanceFlow(0, jrOut, 0, mzOut, 0, srOut);
    }

    // @inheritdoc ICDO
    function maxWithdraw(address tranche) external view returns (uint256) {
        return _maxWithdraw(tranche);
    }

    // @inheritdoc ICDO
    function maxWithdraw(address tranche, address owner) external view returns (uint256) {
        if (sharesCooldown != address(0) && owner == sharesCooldown) {
            return _maxWithdrawForSilo(tranche);
        }
        return _maxWithdraw(tranche);
    }

    function _maxWithdrawForSilo(address tranche) internal view returns (uint256) {
        address silo = sharesCooldown;
        TrancheKind kind = _kindOf(tranche);

        uint256 siloShares;
        uint256 siloAssets;
        if (kind == TrancheKind.JUNIOR) {
            siloShares = _jrVault.balanceOf(silo);
            siloAssets = _jrVault.convertToAssets(siloShares);
        } else if (kind == TrancheKind.MEZZANINE) {
            siloShares = _mezzVault.balanceOf(silo);
            siloAssets = _mezzVault.convertToAssets(siloShares);
        } else {
            siloShares = _srVault.balanceOf(silo);
            siloAssets = _srVault.convertToAssets(siloShares);
        }

        return siloAssets;
    }

    // @inheritdoc ICDO
    function maxDeposit(address tranche) external view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        if (kind != TrancheKind.SENIOR) {
            return type(uint256).max;
        }
        return _maxSrDeposit();
    }

    // @inheritdoc ICDO
    function coverage() external view override returns (uint256) {
        return _coverage();
    }

    // @inheritdoc ICDO
    function totalAssetsUnlocked() external view override returns (uint256 jr, uint256 mz, uint256 sr) {
        return _totalAssetsUnlocked();
    }

    // @inheritdoc ICDO
    function setSharesCooldown(address sharesCooldown_) external override onlyOwner {
        if (sharesCooldown_ == sharesCooldown) {
            revert SharesCooldownUnchanged();
        }
        sharesCooldown = sharesCooldown_;
        emit SharesCooldownChanged(sharesCooldown_);
    }

    /**
     * @notice Set deposit/withdraw enable flags for a tranche.
     * @dev    `tranche == address(0)` fans out to all three vaults.
     *         Idempotent — unchanged flags emit no event.
     */
    function setActionStates(
        address tranche,
        bool isDepositEnabled,
        bool isWithdrawEnabled
    ) external onlyRole(PAUSER_ROLE) {
        if (tranche == address(0)) {
            _setActionStatesInner(address(_jrVault), isDepositEnabled, isWithdrawEnabled);
            _setActionStatesInner(address(_mezzVault), isDepositEnabled, isWithdrawEnabled);
            _setActionStatesInner(address(_srVault), isDepositEnabled, isWithdrawEnabled);
            return;
        }
        _setActionStatesInner(tranche, isDepositEnabled, isWithdrawEnabled);
    }

    function _setActionStatesInner(address tranche, bool isDepositEnabled, bool isWithdrawEnabled) internal {
        TActionState storage state = _actionsOf(tranche);

        if (state.isDepositEnabled != isDepositEnabled) {
            state.isDepositEnabled = isDepositEnabled;
            emit DepositsStateChanged(tranche, isDepositEnabled);
        }

        if (state.isWithdrawEnabled != isWithdrawEnabled) {
            state.isWithdrawEnabled = isWithdrawEnabled;
            emit WithdrawalsStateChanged(tranche, isWithdrawEnabled);
        }
    }

    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(_jrVault)) return TrancheKind.JUNIOR;
        if (tranche == address(_mezzVault)) return TrancheKind.MEZZANINE;
        if (tranche == address(_srVault)) return TrancheKind.SENIOR;
        revert InvalidTranche(tranche);
    }

    function _actionsOf(address tranche) internal view returns (TActionState storage) {
        TrancheKind kind = _kindOf(tranche);
        if (kind == TrancheKind.JUNIOR) return actionsJr;
        if (kind == TrancheKind.MEZZANINE) return actionsMezz;
        return actionsSr;
    }

    function _requireNonZero(address a) internal pure {
        if (a == address(0)) revert ZeroAddress();
    }

    function _requireBackRef(address component) internal view {
        address actual = ICDOComponent(component).getCDOAddress();
        if (actual != address(this)) {
            revert InvalidComponent(component, address(this), actual);
        }
    }

    function _requireSupported(address token) internal view {
        IERC20[] memory tokens = _strategy.getSupportedTokens();
        uint256 len = tokens.length;
        for (uint256 i; i < len; ) {
            if (address(tokens[i]) == token) return;
            unchecked {
                ++i;
            }
        }
        revert TokenNotSupported(token);
    }

    /**
     * @dev coverage = (jr + mz + sr) × 1e18 / sr.  Sentinel
     *      `type(uint256).max` when sr = 0 so gate comparisons trivially
     *      pass (the protocol is effectively over-collateralised).
     */
    function _coverage() internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _totalAssetsUnlocked();
        if (sr == 0) return type(uint256).max;
        uint256 pool = jr + mz + sr;
        return (pool * 1e18) / sr;
    }

    function _tvls() internal view returns (uint256 jr, uint256 mz, uint256 sr) {
        return _totalAssetsUnlocked();
    }

    /**
     * @dev Subtract silo-held assets so locked shares don't inflate
     *      Sr (which would tighten the gate against users) or subordinate
     *      (which would loosen it). Saturating to zero protects against
     *      arithmetic drift between the tranche book and the snapshot.
     */
    function _totalAssetsUnlocked() internal view returns (uint256 jr, uint256 mz, uint256 sr) {
        (jr, mz, sr, ) = _accounting.totalAssetsT0();
        address silo = sharesCooldown;
        if (silo == address(0)) {
            return (jr, mz, sr);
        }
        uint256 jrLocked = _jrVault.convertToAssets(_jrVault.balanceOf(silo));
        uint256 mzLocked = _mezzVault.convertToAssets(_mezzVault.balanceOf(silo));
        uint256 srLocked = _srVault.convertToAssets(_srVault.balanceOf(silo));
        jr = jr > jrLocked ? jr - jrLocked : 0;
        mz = mz > mzLocked ? mz - mzLocked : 0;
        sr = sr > srLocked ? sr - srLocked : 0;
    }

    /**
     * @dev Max additional Sr deposit keeping `(pool+x) / (sr+x) >= MIN_COVERAGE`.
     *      Solving for x:
     *        x  =  (subordinate - sr × (MIN_COVERAGE - 1)) / (MIN_COVERAGE - 1)
     *      where subordinate = jr + mz. With MIN_COVERAGE = 1.05e18 the
     *      divisor is 0.05e18, so headroom amplifies by 20×. Returns 0
     *      when coverage is already at or below the floor.
     */
    function _maxSrDeposit() internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        uint256 srFloor = (sr * (MIN_COVERAGE - 1e18)) / 1e18;
        uint256 subordinate = jr + mz;
        if (subordinate <= srFloor) {
            return 0;
        }
        uint256 headroom = subordinate - srFloor;
        return (headroom * 1e18) / (MIN_COVERAGE - 1e18);
    }

    /**
     * @dev Senior is unrestricted (withdrawing Sr raises coverage).
     *      Jr/Mz share a single buffer:
     *        maxOut  =  (jr + mz) - sr × (MIN_COVERAGE - 1) / 1e18
     *      First-come-first-served on actual withdrawal.
     */
    function _maxWithdraw(address tranche) internal view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();

        if (kind == TrancheKind.SENIOR) {
            return sr;
        }

        uint256 srFloor = (sr * (MIN_COVERAGE - 1e18)) / 1e18;
        uint256 subordinate = jr + mz;
        if (subordinate <= srFloor) {
            return 0;
        }
        return subordinate - srFloor;
    }

    // @dev coverageAfter = (pool + amount) × 1e18 / (sr + amount).
    function _projectedCoverageAfterSrDeposit(uint256 amount) internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        uint256 newSr = sr + amount;
        uint256 newPool = jr + mz + newSr;
        if (newSr == 0) return type(uint256).max;
        return (newPool * 1e18) / newSr;
    }

    /**
     * @dev coverageAfter = (pool - amount) × 1e18 / sr.  Saturating
     *      subtraction so a violating amount still produces a comparable
     *      ratio for the revert payload.
     */
    function _projectedCoverageAfterSubWithdraw(uint256 amount) internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        if (sr == 0) return type(uint256).max;
        uint256 pool = jr + mz + sr;
        uint256 newPool = pool > amount ? pool - amount : 0;
        return (newPool * 1e18) / sr;
    }
}
