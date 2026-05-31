// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IStrategy } from "../../interfaces/IStrategy.sol";
import { IsUSDai } from "../../interfaces/external/IsUSDai.sol";
import { IERC20Cooldown } from "../../interfaces/cooldown/IERC20Cooldown.sol";

/**
 * @title  IUSDAStrategy
 * @notice External surface of the USDA Strategy beyond {IStrategy}.
 *         Exposes the per-tranche cooldown configuration setter,
 *         immutables, and the cooldown silo handle so off-chain
 *         consumers can resolve the full deploy graph from one address.
 * @dev    APR is owned by a separate provider contract (the
 *         AaveAprPairProvider) wired into the AprPairFeed; this
 *         interface does not declare APR methods.
 */
interface IUSDAStrategy is IStrategy {
    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event CooldownsChanged(uint32 jr, uint32 mz, uint32 sr);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error CooldownTooLong(uint32 max, uint32 given);
    error UnsupportedToken(address token);

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /**
     * @notice Set per-tranche cooldown durations (seconds) routed
     *         through the ERC20Cooldown silo. Each value must be
     *         `<= MAX_COOLDOWN`. When all three values are zero the
     *         silo's `cooldownDisabled` flag is set so finalisation
     *         is immediate.
     * @dev    Gated by `UPDATER_STRAT_CONFIG_ROLE`.
     */
    function setCooldowns(uint32 jr, uint32 mz, uint32 sr) external;

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function sUSDai() external view returns (IsUSDai);

    function USDai() external view returns (IERC20);

    function erc20Cooldown() external view returns (IERC20Cooldown);

    function cooldownJr() external view returns (uint32);

    function cooldownMz() external view returns (uint32);

    function cooldownSr() external view returns (uint32);

    function MAX_COOLDOWN() external view returns (uint32);
}
