// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICooldown } from "./ICooldown.sol";

/**
 * @title  IERC20Cooldown
 * @notice Silo that locks generic ERC-20 tokens for a configurable
 *         cooldown period before they can be released to the user.
 *         Used by Strategy contracts when releasing sUSDai shares
 *         on withdrawal.
 */
interface IERC20Cooldown is ICooldown {
    /**
     * @notice Transfer `amount` of `token` from the caller into the
     *         silo on behalf of `initialFrom`, recording a lockup
     *         until `block.timestamp + cooldownSeconds`. After the
     *         lock expires, the recipient `to` finalises via
     *         {ICooldown.finalize} to claim the tokens.
     * @dev    Caller must hold `COOLDOWN_WORKER_ROLE`. When
     *         `cooldownSeconds == 0`, the silo immediately forwards
     *         the tokens to `to` (no lockup, no record).
     */
    function transfer(
        IERC20 token,
        address initialFrom,
        address to,
        uint256 amount,
        uint256 cooldownSeconds
    ) external;

    /**
     * @notice Toggle cooldown enforcement for a token. When disabled,
     *         pending requests finalise immediately regardless of
     *         their recorded `unlockAt`.
     * @dev    Emergency-exit switch. Callable by
     *         `COOLDOWN_WORKER_ROLE` so Strategy can lift the lock
     *         when its own cooldown configuration is set to zero.
     */
    function setCooldownDisabled(IERC20 token, bool isCooldownDisabled) external;
}
