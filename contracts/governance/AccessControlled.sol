// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";

/**
 * @title  AccessControlled
 * @notice Shared base for every consumer contract that needs the
 *         protocol's role registry. Delegates `onlyRole(...)` checks
 *         to the external {IAccessControlManager} so role state is
 *         not duplicated per-contract.
 */
abstract contract AccessControlled is Initializable, Ownable2StepUpgradeable, ReentrancyGuard {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPDATER_CDO_APR_ROLE = keccak256("UPDATER_CDO_APR_ROLE");
    bytes32 public constant UPDATER_FEED_ROLE = keccak256("UPDATER_FEED_ROLE");
    bytes32 public constant UPDATER_STRAT_CONFIG_ROLE = keccak256("UPDATER_STRAT_CONFIG_ROLE");
    bytes32 public constant RESERVE_MANAGER_ROLE = keccak256("RESERVE_MANAGER_ROLE");
    bytes32 public constant COOLDOWN_WORKER_ROLE = keccak256("COOLDOWN_WORKER_ROLE");
    bytes32 public constant PROPOSER_CONFIG_ROLE = keccak256("PROPOSER_CONFIG_ROLE");

    IAccessControlManager public acm;
    address public twoStepConfigManager;

    uint256[48] private __gap;

    event NewAccessControlManager(address accessControlManager);
    event NewTwoStepConfigManager(address twoStepConfigManager);

    error Unauthorized(address sender, address calledContract, bytes4 sel);
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
    error ZeroAddress();

    // @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyRole(bytes32 role) {
        _checkRole(role, _msgSender());
        _;
    }

    modifier onlyTwoStepConfigManager() {
        require(twoStepConfigManager == _msgSender(), "ConfigManagerOnly");
        _;
    }

    function AccessControlled_init(address owner, address accessControlManager) internal onlyInitializing {
        __Ownable_init_unchained(owner);
        __AccessControlled_init_unchained(accessControlManager);
        // OZ 5.x ships ReentrancyGuard as a non-upgradeable contract with
        // ERC-7201 namespaced storage — no initializer, zero slot is "not
        // entered".
    }

    function __AccessControlled_init_unchained(address accessControlManager) internal onlyInitializing {
        setAccessControlManagerInner(accessControlManager);
    }

    // @notice Set the AccessControlManager registry.
    function setAccessControlManager(address accessControlManager_) external onlyOwner {
        setAccessControlManagerInner(accessControlManager_);
    }

    // @notice Set the two-step config manager.
    function setTwoStepConfigManager(address twoStepConfigManager_) external onlyOwner {
        if (twoStepConfigManager_ == address(0)) {
            revert ZeroAddress();
        }
        twoStepConfigManager = twoStepConfigManager_;
        emit NewTwoStepConfigManager(twoStepConfigManager_);
    }

    function setAccessControlManagerInner(address accessControlManager) internal {
        if (accessControlManager == address(0)) {
            revert ZeroAddress();
        }
        acm = IAccessControlManager(accessControlManager);
        emit NewAccessControlManager(accessControlManager);
    }

    /**
     * @notice Reverts when the registry rejects the call-based
     *         permission for `sel`.
     */
    function _checkAccessAllowed(bytes4 sel) internal view {
        bool isAllowedToCall = acm.isAllowedToCall(msg.sender, sel);

        if (!isAllowedToCall) {
            revert Unauthorized(msg.sender, address(this), sel);
        }
    }

    function _checkRole(bytes32 role, address account) internal view virtual {
        if (!acm.hasRole(role, account)) {
            revert AccessControlUnauthorizedAccount(account, role);
        }
    }
}
