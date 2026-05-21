// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

interface IAccessControlManager is IAccessControl {
    function grantCall(address contractAddress, bytes4 sel, address accountToPermit) external;

    function revokeCall(
        address contractAddress,
        bytes4 sel,
        address accountToRevoke
    ) external;

    function isAllowedToCall(address account, bytes4 sel) external view returns (bool);

    function hasPermission(
        address account,
        address contractAddress,
        bytes4 sel
    ) external view returns (bool);
}
