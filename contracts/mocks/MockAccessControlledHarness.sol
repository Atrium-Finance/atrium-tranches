// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { AccessControlled } from "../governance/AccessControlled.sol";

/**
 * @notice Concrete leaf of AccessControlled used to exercise its
 *         modifiers (`onlyOwner`, `onlyRole`, `_checkAccessAllowed`).
 */
contract MockAccessControlledHarness is AccessControlled {
    uint256 public flag;

    function initialize(address owner_, address acm_) external initializer {
        AccessControlled_init(owner_, acm_);
    }

    function onlyOwnerCall() external onlyOwner {
        flag += 1;
    }

    function onlyRoleCall(bytes32 role) external onlyRole(role) {
        flag += 1;
    }

    function checkAccessCall() external {
        _checkAccessAllowed(this.checkAccessCall.selector);
        flag += 1;
    }
}
