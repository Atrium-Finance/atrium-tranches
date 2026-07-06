// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICooldown } from "./ICooldown.sol";

/**
 * @title  IERC20Cooldown
 * @notice Silo that locks generic ERC-20 tokens for a configurable
 *         cooldown before releasing to the recipient. Used by Strategy
 *         when releasing sUSDai shares on withdrawal.
 */
interface IERC20Cooldown is ICooldown {
    /**
     * @notice Move `amount` of `token` from the caller into the silo
     *         on behalf of `initialFrom`, locking it until
     *         `block.timestamp + cooldownSeconds`. Then `to`
     *         finalises via {ICooldown.finalize}. Caller must hold
     *         `COOLDOWN_WORKER_ROLE`. `cooldownSeconds == 0` forwards
     *         immediately to `to` without creating a queue entry.
     */
    function transfer(
        IERC20 token,
        address initialFrom,
        address to,
        uint256 amount,
        uint256 cooldownSeconds
    ) external;

    /**
     * @notice Emergency toggle. When disabled, pending requests
     *         finalise immediately regardless of `unlockAt`. Gated by
     *         `COOLDOWN_WORKER_ROLE`.
     */
    function setCooldownDisabled(IERC20 token, bool isCooldownDisabled) external;
}
