// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  ICooldown
 * @notice Shared base for cooldown silo contracts. Defines the balance
 *         shape exposed to viewers and the finalisation entry points
 *         shared between every concrete cooldown variant.
 */
interface ICooldown {
    /** @dev Aggregate view of a user's silo state for a given token. */
    struct TBalanceState {
        uint256 pending;
        uint256 claimable;
        uint256 nextUnlockAt;
        uint256 nextUnlockAmount;
        uint256 totalRequests;
    }

    event TransferRequested(
        IERC20 indexed token,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 unlockAt
    );
    event Finalized(IERC20 indexed token, address indexed user, uint256 amount);

    error InvalidTime();
    error UnsupportedToken(address token);
    error NothingToFinalize();
    error ExternalReceiverRequestLimitReached(
        IERC20 token,
        address from,
        address to,
        uint256 amount
    );

    function finalize(IERC20 token, address user) external returns (uint256 claimed);
    function finalize(IERC20 token, address user, uint256 at) external returns (uint256 claimed);

    function balanceOf(IERC20 token, address user) external view returns (TBalanceState memory);
    function balanceOf(IERC20 token, address user, uint256 at) external view returns (TBalanceState memory);
}
