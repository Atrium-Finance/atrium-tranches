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

    /**
     * @notice Burns `shares` from `from` and records the corresponding
     *         assets as an accrued protocol fee.
     * @dev    Called by SharesCooldown when applying entry or
     *         early-exit fees. Real body lives with the Tranche fee
     *         spec; declared here so the silo's typed calls compile.
     */
    function burnSharesAsFee(uint256 shares, address from) external;
}
