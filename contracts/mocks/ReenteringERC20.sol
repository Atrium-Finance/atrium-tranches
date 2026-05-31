// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Cooldown } from "../core/cooldown/ERC20Cooldown.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice ERC-20 that calls back into the silo from its `transfer`
 *         hook so reentrancy guards can be exercised.
 */
contract ReenteringERC20 is ERC20 {
    ERC20Cooldown public target;
    bool public reenter;

    constructor() ERC20("Reenter", "REE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(ERC20Cooldown silo) external {
        target = silo;
        reenter = true;
    }

    function disarm() external {
        reenter = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (reenter && address(target) != address(0) && to == address(target)) {
            // Try to finalise during the transfer — should be blocked
            // by ReentrancyGuard on the silo.
            target.finalize(IERC20(address(this)), to);
        }
    }
}
