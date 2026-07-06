// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { AccessControlled } from "../../governance/AccessControlled.sol";
import { ICooldown } from "../../interfaces/cooldown/ICooldown.sol";

/**
 * @title  CooldownBase
 * @notice Shared base for silo contracts. Defines slot-cap constants
 *         and the standard `initialize(owner, acm)` hook.
 */
abstract contract CooldownBase is ICooldown, AccessControlled {
    /**
     * @dev Maximum active requests per `(vault, account)`. Requests
     *      beyond this count merge into the last entry to keep
     *      `finalize` and `balanceOf` gas costs bounded.
     */
    uint256 internal constant MAX_ACTIVE_REQUEST_SLOTS = 70;

    /**
     * @dev Slot cap when `initialFrom != to` (request created on
     *      behalf of another address). Reached via revert, not
     *      merge — anti-spam for the external receiver.
     */
    uint256 internal constant PUBLIC_REQUEST_SLOTS_CAP = 40;

    function initialize(address owner_, address acm_) public virtual initializer {
        AccessControlled_init(owner_, acm_);
    }
}
