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
 * @title PrimeCDO
 * @dev Storage layout (own tail):
 *      - _jrVault, _mezzVault, _srVault              (3 slots)
 *      - _accounting, _strategy, sharesCooldown      (3 slots)
 *      - exitFeeJr, exitFeeMz, exitFeeSr, treasury   (4 slots)
 *      - actionsJr, actionsMezz, actionsSr           (3 packed-bool slots)
 *      - __gap[42]                                   (42 slots reserved)
 *      Total reserved tail: 13 slots + __gap[42] = 55. `treasury`
 *      appended adjacent to the `exitFee*` group; never reorder or
 *      remove.
 */
contract PrimeCDO is AccessControlled, ICDO {
    /**
     * @notice Per-tranche enable flags for the two action categories.
     * @dev    Both bool fields pack into a single storage slot.
     */
    struct TActionState {
        bool isDepositEnabled;
        bool isWithdrawEnabled;
    }

    /**
     * @notice Minimum acceptable coverage ratio: pool / srNav.
     * @dev    Encoded in 1e18 precision. 1.05e18 = 5% subordinate buffer.
     */
    uint256 public constant MIN_COVERAGE = 1.05e18;

    /**
     * @notice Hard cap on the per-tranche fallback exit fee.
     * @dev    Encoded in 1e18 precision. 0.1e18 = 10%. Anti-confiscation.
     */
    uint256 public constant MAX_EXIT_FEE = 0.1e18;

    // --- Tranche vaults ---
    ITranche internal _jrVault;
    ITranche internal _mezzVault;
    ITranche internal _srVault;

    // --- External components ---
    IAccounting internal _accounting;
    IStrategy internal _strategy;

    /**
     * @notice External SharesCooldown silo. May be `address(0)` —
     *         `_totalAssetsUnlocked` then falls back to raw TVL.
     */
    address public override sharesCooldown;

    // --- Per-tranche fallback exit fees ---
    /** @notice Junior fallback fee (1e18) when no silo range applies. */
    uint256 public override exitFeeJr;
    /** @notice Mezzanine fallback fee (1e18) when no silo range applies. */
    uint256 public override exitFeeMz;
    /** @notice Senior fallback fee (1e18) when no silo range applies. */
    uint256 public override exitFeeSr;

    /** @notice Recipient wallet for reserve outflows. */
    address public override treasury;

    // --- Pause state ---
    /** @notice Junior tranche action-enable flags. */
    TActionState public actionsJr;
    /** @notice Mezzanine tranche action-enable flags. */
    TActionState public actionsMezz;
    /** @notice Senior tranche action-enable flags. */
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

    error NotImplemented();
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

    /**
     * @dev See https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable#storage-gaps
     */
    uint256[42] private __gap;

    /**
     * @notice Initializes the PrimeCDO proxy. Components are wired separately via {config}.
     */
    function initialize(address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
    }

    /** @dev Restricts a function to one of the three wired tranche vaults. */
    modifier onlyTranche() {
        if (msg.sender != address(_jrVault) && msg.sender != address(_mezzVault) && msg.sender != address(_srVault)) {
            revert UnauthorizedTranche(msg.sender);
        }
        _;
    }

    /**
     * @notice Atomically wires the five core components to this CDO.
     * @dev    Each component must report this CDO via {ICDOComponent.getCDOAddress};
     *         re-callable to re-wire.
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

        // `_strategy` must be set first — `Tranche.configure()` reads `cdo.strategy()`.
        _jrVault.configure();
        _mezzVault.configure();
        _srVault.configure();

        emit Configured(jr, mz, sr, accounting_, strategy_);
    }

    /** @notice Junior tranche vault — absorbs losses first. */
    function jrVault() external view returns (ITranche) {
        return _jrVault;
    }

    /** @notice Mezzanine tranche vault — absorbs losses after Junior. */
    function mezzVault() external view returns (ITranche) {
        return _mezzVault;
    }

    /** @notice Senior tranche vault — protected principal and target yield. */
    function srVault() external view returns (ITranche) {
        return _srVault;
    }

    /** @notice Underlying strategy responsible for staking and token conversions. */
    function strategy() external view returns (IStrategy) {
        return _strategy;
    }

    /** @notice Accounting contract holding TVL and yield-split state. */
    function accounting() external view returns (IAccounting) {
        return _accounting;
    }

    /** @notice Tranche-level total assets. Stub — implementation deferred. */
    function totalAssets(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc ICDO
     * @dev Only tranche-originated user flows should trigger an accounting refresh.
     */
    function updateAccounting() external onlyTranche {
        _accounting.updateAccounting(_strategy.totalAssets());
    }

    /**
     * @inheritdoc ICDO
     * @dev Strategy pulls `tokenAmount` directly from `msg.sender` via the
     *      allowance primed in `Tranche.configure()`.
     */
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets
    ) external override onlyTranche nonReentrant {
        tranche;
        baseAssets;

        _requireSupported(token);

        if (!_actionsOf(msg.sender).isDepositEnabled) {
            revert DepositsDisabled(msg.sender);
        }

        if (_kindOf(msg.sender) == TrancheKind.SENIOR) {
            // Use baseAssets here, not tokenAmount. The coverage gate
            // operates on accounting units, not raw token amounts.
            if (baseAssets > _maxSrDeposit()) {
                revert CoverageBelowMinimum(_coverage(), _projectedCoverageAfterSrDeposit(baseAssets));
            }
        }

        // Pattern B/3: Strategy pulls from the calling Tranche.
        // `tranche` and `owner` both resolve to `msg.sender` (the wired tranche).
        _strategy.deposit(msg.sender, token, tokenAmount, baseAssets, msg.sender);
    }

    /**
     * @inheritdoc ICDO
     * @dev Order: zero-amount guard -> pause -> coverage -> Strategy -> Accounting.
     *      `owner_ == sharesCooldown` means the silo is finalising — the user has
     *      already served the lock on the SharesCooldown side, so Strategy's own
     *      cooldown is skipped.
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

    /**
     * @inheritdoc ICDO
     * @dev Silo-as-owner short-circuits to `ERC4626` so finalisation
     *      doesn't re-lock. Otherwise consult the silo's coverage range;
     *      if no lock applies, fall through to the per-tranche fallback.
     *      Never reverts.
     */
    function calculateExitMode(
        address tranche,
        address owner
    ) external view override returns (TExitMode mode, uint256 fee, uint32 cooldownSeconds) {
        address silo = sharesCooldown;
        if (silo != address(0)) {
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
     * @dev Tranche transfers shares into the silo BEFORE calling this method.
     *      No coverage gate: low coverage already routes through the silo's
     *      harshest range — a second hard gate would block users from the
     *      throttle that exists for that exact case.
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

    /**
     * @inheritdoc ICDO
     * @dev No `tranche == msg.sender` check — Tranche is a protocol-owned
     *      contract trusted as a unit.
     */
    function accrueFee(address tranche, uint256 assets) external override onlyTranche {
        _accounting.accrueFee(tranche, assets);
    }

    /**
     * @inheritdoc ICDO
     */
    function updateBalanceFlow() external override onlyTranche {
        _accounting.updateBalanceFlow();
    }

    /**
     * @inheritdoc ICDO
     */
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

    /**
     * @inheritdoc ICDO
     * @dev Atomic three-field setter. Each value must be `<= MAX_EXIT_FEE`.
     */
    function setExitFees(uint256 jr, uint256 mz, uint256 sr) external override onlyOwner {
        if (jr > MAX_EXIT_FEE) revert InvalidExitFee(jr);
        if (mz > MAX_EXIT_FEE) revert InvalidExitFee(mz);
        if (sr > MAX_EXIT_FEE) revert InvalidExitFee(sr);
        exitFeeJr = jr;
        exitFeeMz = mz;
        exitFeeSr = sr;
        emit ExitFeesSet(jr, mz, sr);
    }

    /**
     * @inheritdoc ICDO
     * @dev Owner-only. Zero rejected to keep the `treasury == address(0)`
     *      precondition in {reduceReserve} meaningful.
     */
    function setReserveTreasury(address treasury_) external override onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /**
     * @inheritdoc ICDO
     * @dev Order: precondition checks -> conversion -> accounting
     *      decrement -> physical transfer. `Math.Rounding.Floor` favours
     *      protocol when converting `tokenAmount -> baseAssets`.
     */
    function reduceReserve(address token, uint256 amount) external override onlyRole(RESERVE_MANAGER_ROLE) {
        if (treasury == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 baseAssets = _strategy.convertToAssets(token, amount, Math.Rounding.Floor);

        _accounting.reduceReserve(baseAssets, 0, 0, 0);

        _strategy.reduceReserve(token, amount, treasury);

        emit ReserveReduced(token, amount);
    }

    function _recordWithdraw(TrancheKind kind, uint256 baseAssets) internal {
        uint256 jrOut = kind == TrancheKind.JUNIOR ? baseAssets : 0;
        uint256 mzOut = kind == TrancheKind.MEZZANINE ? baseAssets : 0;
        uint256 srOut = kind == TrancheKind.SENIOR ? baseAssets : 0;
        _accounting.updateBalanceFlow(0, jrOut, 0, mzOut, 0, srOut);
    }

    /**
     * @inheritdoc ICDO
     * @dev Senior: unrestricted (withdrawing Sr increases coverage).
     *      Junior/Mezzanine: shared buffer — both see the same available
     *      amount. First-come-first-served on actual withdrawal.
     *      Per-owner limits enforced by the Tranche vault's share balance,
     *      not here.
     */
    function maxWithdraw(address tranche) external view returns (uint256) {
        return _maxWithdraw(tranche);
    }

    /**
     * @inheritdoc ICDO
     * @dev Silo-as-owner bypasses the coverage gate and returns the
     *      silo's locked balance for the tranche. All other owners go
     *      through the standard coverage-gated path.
     */
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

    /**
     * @inheritdoc ICDO
     * @dev Junior and Mezzanine: unlimited (`type(uint256).max`).
     *      Senior: capped to keep coverage `≥ MIN_COVERAGE` post-deposit.
     */
    function maxDeposit(address tranche) external view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        if (kind != TrancheKind.SENIOR) {
            return type(uint256).max;
        }
        return _maxSrDeposit();
    }

    /**
     * @notice Returns the current protocol coverage ratio:
     *         `(jrUnlocked + mzUnlocked + srUnlocked) / srUnlocked`.
     * @dev    Encoded in 1e18 precision. Excludes shares parked in the
     *         SharesCooldown silo (when wired). Returns
     *         `type(uint256).max` when unlocked Senior TVL is zero.
     *         Uses `accounting.totalAssetsT0()` (last-recorded TVL);
     *         no fresh strategy fetch.
     */
    function coverage() external view returns (uint256) {
        return _coverage();
    }

    /** @notice External counterpart to `_totalAssetsUnlocked`. */
    function totalAssetsUnlocked() external view returns (uint256 jr, uint256 mz, uint256 sr) {
        return _totalAssetsUnlocked();
    }

    /**
     * @notice Wire (or rewire) the SharesCooldown silo.
     * @dev    Owner-only. Pass `address(0)` to disable silo-aware
     *         coverage entirely.
     */
    function setSharesCooldown(address sharesCooldown_) external onlyOwner {
        if (sharesCooldown_ == sharesCooldown) {
            revert SharesCooldownUnchanged();
        }
        sharesCooldown = sharesCooldown_;
        emit SharesCooldownChanged(sharesCooldown_);
    }

    /**
     * @notice Sets the deposit/withdraw enable flags for a tranche.
     * @dev    `tranche == address(0)` fans out to all three vaults. Idempotent —
     *         unchanged flags are not re-written and emit no event.
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

    /** @dev Resolves a wired tranche address to its kind; reverts otherwise. */
    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(_jrVault)) return TrancheKind.JUNIOR;
        if (tranche == address(_mezzVault)) return TrancheKind.MEZZANINE;
        if (tranche == address(_srVault)) return TrancheKind.SENIOR;
        revert InvalidTranche(tranche);
    }

    /** @dev Storage ref to the action-state struct for a wired tranche. */
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
        // `i` bounded by `len`; `len` bounded by Strategy admin.
        for (uint256 i; i < len; ) {
            if (address(tokens[i]) == token) return;
            unchecked {
                ++i;
            }
        }
        revert TokenNotSupported(token);
    }

    function _coverage() internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _totalAssetsUnlocked();
        if (sr == 0) return type(uint256).max;
        uint256 pool = jr + mz + sr;
        return (pool * 1e18) / sr;
    }

    function _tvls() internal view returns (uint256 jr, uint256 mz, uint256 sr) {
        return _totalAssetsUnlocked();
    }

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

    function _maxSrDeposit() internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        // Coverage floor in absolute units: (MIN_COVERAGE - 1e18) × sr / 1e18.
        uint256 srFloor = (sr * (MIN_COVERAGE - 1e18)) / 1e18;
        uint256 subordinate = jr + mz;
        if (subordinate <= srFloor) {
            // Coverage already at or below the minimum — no Sr deposit allowed.
            return 0;
        }
        uint256 headroom = subordinate - srFloor;
        // X = headroom / (MIN_COVERAGE - 1).  With MIN_COVERAGE = 1.05e18,
        // divisor = 0.05e18 → X = headroom × 1e18 / 0.05e18 = headroom × 20.
        return (headroom * 1e18) / (MIN_COVERAGE - 1e18);
    }

    function _maxWithdraw(address tranche) internal view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();

        if (kind == TrancheKind.SENIOR) {
            return sr;
        }

        // Jr/Mz shared buffer:
        // maxWithdraw_combined = (jr + mz) - sr × (MIN_COVERAGE - 1) / 1e18
        uint256 srFloor = (sr * (MIN_COVERAGE - 1e18)) / 1e18;
        uint256 subordinate = jr + mz;
        if (subordinate <= srFloor) {
            return 0;
        }
        return subordinate - srFloor;
    }

    function _projectedCoverageAfterSrDeposit(uint256 amount) internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        uint256 newSr = sr + amount;
        uint256 newPool = jr + mz + newSr;
        if (newSr == 0) return type(uint256).max;
        return (newPool * 1e18) / newSr;
    }

    function _projectedCoverageAfterSubWithdraw(uint256 amount) internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        if (sr == 0) return type(uint256).max;
        uint256 pool = jr + mz + sr;
        uint256 newPool = pool > amount ? pool - amount : 0;
        return (newPool * 1e18) / sr;
    }
}
