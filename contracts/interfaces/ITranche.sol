// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IPrimeVault} from "./IPrimeVault.sol";
import {ICDOComponent} from "./ICDOComponent.sol";

/**
 * @title ITranche
 * @notice Tranche vault interface extending the ERC4626 standard.
 */
interface ITranche is ICDOComponent, IPrimeVault {
    /**
     * @notice Approves every Strategy-supported token from this tranche
     *         to the Strategy (unlimited), so the Strategy can pull
     *         deposit assets during {ICDO.deposit}.
     * @dev    Must be callable only by the CDO. Idempotent — safe to
     *         re-call after the Strategy's supported-token list changes.
     */
    function configure() external;
}
