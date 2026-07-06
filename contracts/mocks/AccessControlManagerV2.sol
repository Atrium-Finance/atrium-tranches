// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { AccessControlManager } from "../governance/AccessControlManager.sol";

/**
 * @notice V2 of AccessControlManager used to verify UUPS upgrade safety.
 *         Adds a new external getter without changing storage layout.
 */
contract AccessControlManagerV2 is AccessControlManager {
    function version() external pure returns (uint256) {
        return 2;
    }
}
