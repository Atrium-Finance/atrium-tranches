// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { CooldownBase } from "../core/cooldown/CooldownBase.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICooldown } from "../interfaces/cooldown/ICooldown.sol";

/**
 * @notice Concrete leaf of CooldownBase for harness testing. Implements
 *         the ICooldown surface as no-ops so the abstract base can be
 *         instantiated.
 */
contract MockCooldown is CooldownBase {
    function finalize(IERC20, address) external pure override returns (uint256) { return 0; }
    function finalize(IERC20, address, uint256) external pure override returns (uint256) { return 0; }
    function balanceOf(IERC20, address)
        external pure override returns (ICooldown.TBalanceState memory s)
    { return s; }
    function balanceOf(IERC20, address, uint256)
        external pure override returns (ICooldown.TBalanceState memory s)
    { return s; }
}
