// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IStrategy } from "../../interfaces/IStrategy.sol";
import { IsUSDai } from "../../interfaces/external/IsUSDai.sol";
import { IERC20Cooldown } from "../../interfaces/cooldown/IERC20Cooldown.sol";

/**
 * @title  IUSDAStrategy
 * @notice External surface of the USDA Strategy beyond {IStrategy}:
 *         per-tranche cooldown setter, immutables, and the silo handle
 *         so off-chain consumers can resolve the deploy graph from one
 *         address.
 */
interface IUSDAStrategy is IStrategy {
    event CooldownsChanged(uint32 jr, uint32 mz, uint32 sr);

    error CooldownTooLong(uint32 max, uint32 given);
    error UnsupportedToken(address token);

    /**
     * @notice Set per-tranche cooldown durations (seconds). Each must
     *         be `<= MAX_COOLDOWN`. All-zero disables the silo's
     *         `cooldownDisabled` flag so finalisation is immediate.
     *         Gated by `UPDATER_STRAT_CONFIG_ROLE`.
     */
    function setCooldowns(uint32 jr, uint32 mz, uint32 sr) external;

    function sUSDai() external view returns (IsUSDai);
    function USDai() external view returns (IERC20);
    function erc20Cooldown() external view returns (IERC20Cooldown);

    function cooldownJr() external view returns (uint32);
    function cooldownMz() external view returns (uint32);
    function cooldownSr() external view returns (uint32);

    function MAX_COOLDOWN() external view returns (uint32);
}
