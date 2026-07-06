// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ICDO} from "../interfaces/ICDO.sol";
import {ICDOComponent} from "../interfaces/ICDOComponent.sol";

/**
 * @title  CDOComponent
 * @notice Shared base for contracts that point back at a single CDO
 *         (Tranche, Accounting, Strategy). Holds the back-reference
 *         used by `PrimeCDO.config(...)` for component wiring.
 */
abstract contract CDOComponent is ICDOComponent {
    ICDO public cdo;

    error InvalidCaller(address caller);

    uint256[49] private __gap;

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
