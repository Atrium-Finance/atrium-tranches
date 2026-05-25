// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IStrategy } from "../interfaces/IStrategy.sol";
import { CDOComponent } from "../base/CDOComponent.sol";

/**
 * @title  Strategy
 * @notice Abstract base contract for CDO investment strategies.
 * @dev    Concrete strategies extend this and implement every
 *         {IStrategy} method. The base contract intentionally holds
 *         no storage and exposes no helpers — concrete contracts
 *         own:
 *           - The supported-token registry and base-asset reference.
 *           - The integration with the underlying yield protocol
 *             (e.g. sUSDai / Aave / Pendle).
 *           - The cooldown infrastructure (typically an
 *             `IERC20Cooldown` silo) used by `withdraw` and
 *             `reduceReserve`.
 *         Keeping the base empty avoids over-fitting the abstraction
 *         to a single strategy shape; alternative strategies on
 *         different underlyings can share only the
 *         `IStrategy + CDOComponent` surface.
 */
abstract contract Strategy is IStrategy, CDOComponent {
}
