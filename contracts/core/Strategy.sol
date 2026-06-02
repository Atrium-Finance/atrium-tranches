// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IStrategy } from "../interfaces/IStrategy.sol";
import { CDOComponent } from "../base/CDOComponent.sol";
import { AccessControlled } from "../governance/AccessControlled.sol";

/**
 * @title  Strategy
 * @notice Abstract base for CDO investment strategies. Concretes own
 *         their supported-token registry, the integration with the
 *         underlying yield protocol, and the cooldown infrastructure.
 *         `AccessControlled` provides the shared role vocabulary for
 *         admin setters; `CDOComponent` provides `onlyCDO` for the
 *         user-flow entry points.
 */
abstract contract Strategy is AccessControlled, CDOComponent, IStrategy {
}
