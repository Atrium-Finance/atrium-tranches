// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AccessControlled } from "../governance/AccessControlled.sol";

import { ICDO } from "../interfaces/ICDO.sol";
import { ICDOComponent } from "../interfaces/ICDOComponent.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { IStrategy } from "../interfaces/IStrategy.sol";

/**
 * @title PrimeCDO
 * @notice Central orchestrator that components (Tranches, Accounting,
 *         Strategy) reference back to. This contract holds the canonical
 *         wiring between all five protocol components and is the single
 *         entrypoint for tranche-originated deposit/withdraw routing.
 * @dev    State-changing entrypoints and accounting-dependent views revert
 *         with `NotImplemented()` until later specs replace them.
 * @dev    Storage layout (post 07b baseline):
 *           [Initializable]                  – 1 packed slot
 *           [Ownable]                        – _owner (1 slot) + __gap[50]
 *           [Ownable2Step]                   – _pendingOwner (1 slot) + __gap[49]
 *           [ReentrancyGuard]                – non-upgradeable (ERC-7201 namespaced storage; no sequential slots)
 *           [AccessControlled]               – acm + twoStepConfigManager (2 slots) + __gap[48]
 *           [PrimeCDO own]                   – _jrVault, _mezzVault, _srVault,
 *                                              _accounting, _strategy (5 slots)
 *                                              + actionsJr, actionsMezz, actionsSr (3 slots, 2 bools packed each)
 *                                              + __gap[47]
 *
 *         This layout is the upgrade baseline. Future versions must be
 *         append-only relative to this layout.
 */
contract PrimeCDO is AccessControlled, ICDO {
    /// @notice Identifies which of the three tranches a function refers to.
    enum TrancheKind {
        JUNIOR,
        MEZZANINE,
        SENIOR
    }

    /**
     * @notice Per-tranche enable flags for the two action categories.
     * @dev    Both bool fields pack into a single storage slot.
     */
    struct TActionState {
        bool isDepositEnabled;
        bool isWithdrawEnabled;
    }

    // --- Tranche vaults ---
    ITranche internal _jrVault;
    ITranche internal _mezzVault;
    ITranche internal _srVault;

    // --- External components ---
    IAccounting internal _accounting;
    IStrategy internal _strategy;

    // --- Pause state ---
    /// @notice Junior tranche action-enable flags.
    TActionState public actionsJr;
    /// @notice Mezzanine tranche action-enable flags.
    TActionState public actionsMezz;
    /// @notice Senior tranche action-enable flags.
    TActionState public actionsSr;

    /**
     * @notice Emitted when {config} atomically wires all five components.
     */
    event Configured(
        address indexed jrVault,
        address indexed mezzVault,
        address indexed srVault,
        address accounting,
        address strategy
    );

    /**
     * @notice Emitted when a tranche's deposit-enable flag flips.
     * @param tranche The tranche whose flag changed.
     * @param enabled The new flag value.
     */
    event DepositsStateChanged(address indexed tranche, bool enabled);

    /**
     * @notice Emitted when a tranche's withdraw-enable flag flips.
     * @param tranche The tranche whose flag changed.
     * @param enabled The new flag value.
     */
    event WithdrawalsStateChanged(address indexed tranche, bool enabled);

    /**
     * @notice Thrown by entrypoints whose implementation is deferred.
     */
    error NotImplemented();

    /**
     * @notice Thrown when a component's back-reference does not equal this CDO.
     * @param component   The component address that was rejected.
     * @param expectedCDO Always `address(this)`.
     * @param actualCDO   The CDO address reported by `component.getCDOAddress()`.
     */
    error InvalidComponent(address component, address expectedCDO, address actualCDO);

    /**
     * @notice Thrown when the deposit caller is not one of the wired tranches.
     * @param caller The unauthorized caller.
     */
    error UnauthorizedTranche(address caller);

    /**
     * @notice Thrown when the deposit `token` is not in the Strategy's supported set.
     * @param token The rejected token.
     */
    error TokenNotSupported(address token);

    /**
     * @notice Thrown when `_kindOf` / `_actionsOf` receive an address that is
     *         not one of the three wired tranche vaults.
     * @param tranche The rejected address.
     */
    error InvalidTranche(address tranche);

    /**
     * @notice Thrown when a tranche attempts to deposit while its
     *         `isDepositEnabled` flag is false.
     * @param tranche The tranche whose deposits are disabled.
     */
    error DepositsDisabled(address tranche);

    /**
     * @notice Thrown when a tranche attempts to withdraw while its
     *         `isWithdrawEnabled` flag is false.
     * @param tranche The tranche whose withdrawals are disabled.
     */
    error WithdrawalsDisabled(address tranche);

    /**
     * @dev See https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable#storage-gaps
     */
    uint256[47] private __gap;

    /**
     * @notice Initializes the PrimeCDO proxy.
     * @param owner_ The initial owner (admin) of the CDO. Must be non-zero.
     * @param acm_   The shared AccessControlManager that role checks are
     *               delegated to. Must be non-zero — AccessControlled
     *               reverts otherwise.
     * @dev    Components are wired separately via {config}.
     */
    function initialize(address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
    }

    /**
     * @dev Restricts a function to one of the three wired tranche vaults.
     */
    modifier onlyTranche() {
        if (msg.sender != address(_jrVault) && msg.sender != address(_mezzVault) && msg.sender != address(_srVault)) {
            revert UnauthorizedTranche(msg.sender);
        }
        _;
    }

    /**
     * @notice Atomically wires the five core components to this CDO.
     * @dev    Owner-gated. Every component must already point back to this
     *         CDO via its `getCDOAddress()` view, otherwise reverts with
     *         `InvalidComponent`. May be called multiple times to re-wire.
     * @param  jr          Junior tranche vault.
     * @param  mz          Mezzanine tranche vault.
     * @param  sr          Senior tranche vault.
     * @param  accounting_ Accounting contract.
     * @param  strategy_   Strategy contract.
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

        // Prime tranche → strategy allowances. Order matters: `_strategy`
        // must be set first because `Tranche.configure()` reads `cdo.strategy()`.
        _jrVault.configure();
        _mezzVault.configure();
        _srVault.configure();

        emit Configured(jr, mz, sr, accounting_, strategy_);
    }

    /**
     * @notice Junior tranche vault — absorbs losses first.
     */
    function jrVault() external view returns (ITranche) {
        return _jrVault;
    }

    /**
     * @notice Mezzanine tranche vault — absorbs losses after Junior.
     */
    function mezzVault() external view returns (ITranche) {
        return _mezzVault;
    }

    /**
     * @notice Senior tranche vault — protected principal and target yield.
     */
    function srVault() external view returns (ITranche) {
        return _srVault;
    }

    /**
     * @notice Underlying strategy responsible for staking and token conversions.
     */
    function strategy() external view returns (IStrategy) {
        return _strategy;
    }

    /**
     * @notice Accounting contract holding TVL and yield-split state.
     */
    function accounting() external view returns (IAccounting) {
        return _accounting;
    }

    /**
     * @notice Tranche-level total assets, after applying the current accounting state.
     * @dev Stub. Implementation deferred to the accounting spec.
     */
    function totalAssets(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @notice Settle yield, losses, and senior target index up to the current block.
     * @dev Stub. Implementation deferred to the accounting spec.
     */
    function updateAccounting() external {
        revert NotImplemented();
    }

    /**
     * @inheritdoc ICDO
     * @dev `tranche` and `baseAssets` are accepted but unused in this spec.
     *      `tranche` is informational (authority comes from `onlyTranche` on
     *      `msg.sender`); `baseAssets` will be consumed by the Accounting hook
     *      in a future spec. The Strategy pulls `tokenAmount` of `token`
     *      directly from `msg.sender` (the tranche) using the unlimited
     *      allowance set during `Tranche.configure()`.
     */
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets
    ) external override onlyTranche nonReentrant {
        tranche; // silence unused-param warning
        baseAssets; // silence unused-param warning

        _requireSupported(token);

        if (!_actionsOf(msg.sender).isDepositEnabled) {
            revert DepositsDisabled(msg.sender);
        }

        _strategy.deposit(msg.sender, token, tokenAmount);
    }

    /**
     * @notice Route a tranche-originated withdrawal through the coverage-aware exit path.
     * @dev Stub. Body still reverts `NotImplemented()` until the withdraw spec
     *      lands, but the pause gate is wired now so the future body inherits
     *      it. `nonReentrant` will be added alongside the real body.
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

        tranche;
        token;
        tokenAmount;
        baseAssets;
        owner_;
        receiver;
        revert NotImplemented();
    }

    /**
     * @notice Maximum base assets the tranche can currently release.
     * @dev Stub. Implementation deferred to the withdraw spec.
     */
    function maxWithdraw(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @notice Maximum base assets a specific owner can currently release from the tranche.
     * @dev Stub. Implementation deferred to the withdraw spec.
     */
    function maxWithdraw(address /*tranche*/, address /*owner*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @notice Maximum base assets that can currently be deposited into the tranche.
     * @dev Stub. Implementation deferred to the deposit spec.
     */
    function maxDeposit(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @notice Sets the deposit and withdraw enable flags for a tranche.
     * @param  tranche           The tranche to modify. Pass `address(0)` to
     *                           apply the same settings to all three
     *                           tranches at once.
     * @param  isDepositEnabled  Whether `CDO.deposit(...)` is allowed for
     *                           this tranche.
     * @param  isWithdrawEnabled Whether `CDO.withdraw(...)` is allowed for
     *                           this tranche.
     * @dev    Caller must hold `PAUSER_ROLE` per the access-control manager.
     *         Idempotent — flags that already match the requested value are
     *         not re-written, and their events are not re-emitted.
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

    /**
     * @dev Resolves a tranche address to its enum identifier. Reverts
     *      `InvalidTranche(tranche)` if the address is not one of the three
     *      wired vaults.
     */
    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(_jrVault)) return TrancheKind.JUNIOR;
        if (tranche == address(_mezzVault)) return TrancheKind.MEZZANINE;
        if (tranche == address(_srVault)) return TrancheKind.SENIOR;
        revert InvalidTranche(tranche);
    }

    /**
     * @dev Returns a storage reference to the action-state struct for the
     *      given tranche. Reverts `InvalidTranche(tranche)` for unwired
     *      addresses (via `_kindOf`).
     */
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
        // safe: i bounded by len, len bounded by Strategy admin
        for (uint256 i; i < len; ) {
            if (address(tokens[i]) == token) return;
            unchecked {
                ++i;
            }
        }
        revert TokenNotSupported(token);
    }
}
