// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ICDO} from "../interfaces/ICDO.sol";
import {ICDOComponent} from "../interfaces/ICDOComponent.sol";

/// @title CDOComponent
/// @notice Abstract base contract for CDO components (Tranches, Accounting, Strategy)
/// @dev Provides common functionality and access control for CDO-related contracts
abstract contract CDOComponent is ICDOComponent {
    ICDO public cdo;

    error InvalidCaller(address caller);

    /**
     * @dev See https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable#storage-gaps
     */
    uint256[49] private __gap;

    /// @notice ensure cooldownDuration is zero
    modifier onlyCDO() {
        if (msg.sender != address(cdo)) {
            revert InvalidCaller(msg.sender);
        }
        _;
    }

    function getCDOAddress() external view returns (address) {
        return address(cdo);
    }
}
