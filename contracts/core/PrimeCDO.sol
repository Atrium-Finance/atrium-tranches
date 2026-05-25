// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AccessControlled } from "../governance/AccessControlled.sol";

import { ICDO } from "../interfaces/ICDO.sol";
import { ICDOComponent } from "../interfaces/ICDOComponent.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";

/**
 * @title PrimeCDO
 * @dev Storage layout (own tail):
 *      - _jrVault, _mezzVault, _srVault              (3 slots)
 *      - _accounting, _strategy, sharesCooldown      (3 slots)
 *      - actionsJr, actionsMezz, actionsSr           (3 packed-bool slots)
 *      - __gap[46]                                   (46 slots reserved)
 *      Total reserved tail: 9 slots + __gap[46] = 55 (was 8 + __gap[47]).
 *      `sharesCooldown` is appended adjacent to the other external-component
 *      pointers; never reorder or remove.
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
    address public sharesCooldown;

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

    error NotImplemented();
    error InvalidComponent(address component, address expectedCDO, address actualCDO);
    error UnauthorizedTranche(address caller);
    error TokenNotSupported(address token);
    error InvalidTranche(address tranche);
    error DepositsDisabled(address tranche);
    error WithdrawalsDisabled(address tranche);
    error CoverageBelowMinimum(uint256 current, uint256 postAction);
    error SharesCooldownUnchanged();

    /**
     * @dev See https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable#storage-gaps
     */
    uint256[46] private __gap;

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
     * @notice Route a tranche-originated withdrawal through the coverage-aware exit path.
     * @dev    Stub. Pause and coverage gates are wired; the real exit body lands later.
     */
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner_,
        address receiver
    ) external override onlyTranche {
        if (!_actionsOf(msg.sender).isWithdrawEnabled) {
            revert WithdrawalsDisabled(msg.sender);
        }

        TrancheKind kind = _kindOf(msg.sender);
        if (kind != TrancheKind.SENIOR) {
            // Jr or Mz: enforce shared coverage buffer.
            if (baseAssets > _maxWithdraw(msg.sender)) {
                revert CoverageBelowMinimum(_coverage(), _projectedCoverageAfterSubWithdraw(baseAssets));
            }
        }

        tranche; token; tokenAmount; owner_; receiver;
        revert NotImplemented();
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
     * @dev `owner` is reserved for future SharesCooldown integration.
     */
    function maxWithdraw(address tranche, address /*owner*/) external view returns (uint256) {
        // `owner` is reserved for future SharesCooldown integration.
        return _maxWithdraw(tranche);
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
        return pool * 1e18 / sr;
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
        uint256 srFloor = sr * (MIN_COVERAGE - 1e18) / 1e18;
        uint256 subordinate = jr + mz;
        if (subordinate <= srFloor) {
            // Coverage already at or below the minimum — no Sr deposit allowed.
            return 0;
        }
        uint256 headroom = subordinate - srFloor;
        // X = headroom / (MIN_COVERAGE - 1).  With MIN_COVERAGE = 1.05e18,
        // divisor = 0.05e18 → X = headroom × 1e18 / 0.05e18 = headroom × 20.
        return headroom * 1e18 / (MIN_COVERAGE - 1e18);
    }

    function _maxWithdraw(address tranche) internal view returns (uint256) {
        TrancheKind kind = _kindOf(tranche);
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();

        if (kind == TrancheKind.SENIOR) {
            return sr;
        }

        // Jr/Mz shared buffer:
        // maxWithdraw_combined = (jr + mz) - sr × (MIN_COVERAGE - 1) / 1e18
        uint256 srFloor = sr * (MIN_COVERAGE - 1e18) / 1e18;
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
        return newPool * 1e18 / newSr;
    }

    function _projectedCoverageAfterSubWithdraw(uint256 amount) internal view returns (uint256) {
        (uint256 jr, uint256 mz, uint256 sr) = _tvls();
        if (sr == 0) return type(uint256).max;
        uint256 pool = jr + mz + sr;
        uint256 newPool = pool > amount ? pool - amount : 0;
        return newPool * 1e18 / sr;
    }
}
