// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title  IsUSDai
 * @notice Minimal external view surface of the USD.AI sUSDai vault used
 *         by Atrium. ERC-4626 share-price growth + vesting state needed
 *         to compute aprBase. No native unstake hook — Atrium routes
 *         withdraws through its own ERC20Cooldown silo and never invokes
 *         USD.AI's async USDai redemption.
 */
interface IsUSDai is IERC4626 {
    /**
     * @notice Amount of yield currently queued for vesting in the active
     *         distribution period and not yet released to share price.
     */
    function unvestedAmount() external view returns (uint256);

    /**
     * @notice Unix timestamp at which the active vesting period started.
     *         `block.timestamp - lastDistributionTimestamp` gives elapsed
     *         seconds into the 8-hour vesting window.
     */
    function lastDistributionTimestamp() external view returns (uint256);
}
