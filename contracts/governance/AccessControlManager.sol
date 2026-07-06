// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { AccessControlUpgradeable }
    from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable }
    from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable }
    from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";

/**
 * @title  AccessControlManager
 * @notice Role registry for the Atrium protocol. Backs both
 *         `onlyRole(bytes32)` (role-based ACL) and
 *         `_checkAccessAllowed(bytes4)` (call-based ACL) on every
 *         consumer contract.
 */
contract AccessControlManager is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    IAccessControlManager
{
    // @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function grantCall(address contractAddress, bytes4 sel, address accountToPermit)
        external override
    {
        bytes32 role = _roleFor(contractAddress, sel);
        grantRole(role, accountToPermit);
        emit PermissionGranted(accountToPermit, contractAddress, sel);
    }

    function revokeCall(address contractAddress, bytes4 sel, address accountToRevoke)
        external override
    {
        bytes32 role = _roleFor(contractAddress, sel);
        revokeRole(role, accountToRevoke);
        emit PermissionRevoked(accountToRevoke, contractAddress, sel);
    }

    function isAllowedToCall(address account, bytes4 sel)
        external view override returns (bool)
    {
        // Consumer contract is `msg.sender`; check contract-specific
        // first, then fall back to the global wildcard.
        if (hasRole(_roleFor(msg.sender, sel), account)) return true;
        return hasRole(_roleForGlobal(sel), account);
    }

    function hasPermission(address account, address contractAddress, bytes4 sel)
        external view override returns (bool)
    {
        return hasRole(_roleFor(contractAddress, sel), account);
    }

    /**
     * @dev `role = (contractAddress << 96) | uint32(sel)`. Reverts on
     *      zero inputs so `grantCall(0, 0, x)` cannot collapse into
     *      the role-based namespace.
     */
    function _roleFor(address contractAddress, bytes4 sel)
        internal pure returns (bytes32 role)
    {
        if (contractAddress == address(0) || sel == bytes4(0)) {
            revert StrictPermissionOnly();
        }
        role = (bytes32(uint256(uint160(contractAddress))) << 96)
             | bytes32(uint256(uint32(sel)));
    }

    /**
     * @dev Wildcard namespace: same packing with `contractAddress == 0`.
     *      Internal-only; bypasses the degenerate-input check used by
     *      {_roleFor}.
     */
    function _roleForGlobal(bytes4 sel) internal pure returns (bytes32 role) {
        if (sel == bytes4(0)) revert StrictPermissionOnly();
        role = bytes32(uint256(uint32(sel)));
    }

    function _authorizeUpgrade(address newImplementation)
        internal override onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    uint256[50] private __gap;
}
