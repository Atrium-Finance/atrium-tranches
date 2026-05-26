// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IStrategy } from "../interfaces/IStrategy.sol";
import { CDOComponent } from "../base/CDOComponent.sol";
import { AccessControlled } from "../governance/AccessControlled.sol";

/**
 * @title  Strategy
 * @notice Abstract base contract for CDO investment strategies.
 * @dev    Concrete strategies extend this and implement every
 *         {IStrategy} method. The base contract intentionally holds
 *         no storage and exposes no helpers — concrete contracts
 *         own:
 *           - The supported-token registry and base-asset reference.
 *           - The integration with the underlying yield protocol.
 *           - The cooldown infrastructure (typically an
 *             `IERC20Cooldown` silo) used by `withdraw` and
 *             `reduceReserve`.
 *         Inheriting `AccessControlled` here gives subclasses the
 *         shared role vocabulary (`onlyRole(...)`, `onlyOwner`) used
 *         for admin setters (cooldown durations, supported tokens).
 *         `CDOComponent` provides `onlyCDO` for the user-flow
 *         entry points (deposit/withdraw/reduceReserve).
 */
abstract contract Strategy is AccessControlled, CDOComponent, IStrategy {
}
