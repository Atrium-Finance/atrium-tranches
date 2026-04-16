// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V2 — PrimeLock
//  Governance timelock with fixed 24-hour delay.
//  See: docs/PV_V2_GOVERNANCE.md for deployment and configuration.
// ══════════════════════════════════════════════════════════════════════

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title PrimeLock
 * @notice Governance timelock for PrimeVaults V3. Wraps OpenZeppelin TimelockController
 *         with a fixed 24-hour minimum delay.
 * @dev Deployed via deploy/06_deploy_primelock.ts. Owns all Ownable2Step contracts at Stage 3.
 *      All parameter changes delayed by 24 hours.
 *      See docs/PV_V2_GOVERNANCE.md for rollout stages and emergency procedures.
 */
contract PrimeLock is TimelockController {
    uint256 public constant MIN_DELAY = 24 hours;

    constructor(
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(MIN_DELAY, proposers, executors, admin) {}
}
