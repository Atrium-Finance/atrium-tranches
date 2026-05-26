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
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        // NOTE: spec calls for `__UUPSUpgradeable_init()` — that initializer
        // does NOT exist in OZ 5.x (UUPSUpgradeable is implementation-only,
        // no init step needed). Same OZ 5.x substitution pattern as the
        // missing `ReentrancyGuardUpgradeable` documented in specs 06/07a.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // -------------------------------------------------------------
    // Call-based permissions
    // -------------------------------------------------------------

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
        // `msg.sender` is the consumer contract performing the check.
        // First try contract-specific permission, then fall back to
        // the global wildcard (contractAddress == 0).
        if (hasRole(_roleFor(msg.sender, sel), account)) return true;
        return hasRole(_roleForGlobal(sel), account);
    }

    function hasPermission(address account, address contractAddress, bytes4 sel)
        external view override returns (bool)
    {
        return hasRole(_roleFor(contractAddress, sel), account);
    }

    // -------------------------------------------------------------
    // Internal — role encoding
    // -------------------------------------------------------------

    /**
     * @dev Pack `(contractAddress: 20B, padding: 8B, sel: 4B)` into a
     *      bytes32. Reverts on degenerate inputs to keep
     *      `grantCall(zero, zero, x)` from collapsing into the
     *      role-based namespace.
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
     * @dev Global permission slot — same packing with
     *      `contractAddress == address(0)` reserved for the wildcard
     *      namespace. Internal-only entry that bypasses the
     *      degenerate-input check.
     */
    function _roleForGlobal(bytes4 sel) internal pure returns (bytes32 role) {
        if (sel == bytes4(0)) revert StrictPermissionOnly();
        role = bytes32(uint256(uint32(sel)));
    }

    // -------------------------------------------------------------
    // UUPS upgrade gating
    // -------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation)
        internal override onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    // Reserved storage gap for future upgrades.
    uint256[50] private __gap;
}
