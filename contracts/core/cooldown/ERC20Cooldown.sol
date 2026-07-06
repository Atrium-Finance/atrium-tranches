// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ICooldown } from "../../interfaces/cooldown/ICooldown.sol";
import { IERC20Cooldown } from "../../interfaces/cooldown/IERC20Cooldown.sol";
import { CooldownBase } from "./CooldownBase.sol";

/**
 * @title  ERC20Cooldown
 * @notice Silo holding generic ERC20 tokens during Strategy-side
 *         cooldown periods.
 */
contract ERC20Cooldown is IERC20Cooldown, CooldownBase {
    using SafeERC20 for IERC20;

    struct TRequest {
        uint64  unlockAt;
        uint192 amount;
    }

    mapping(address token => mapping(address account => TRequest[])) private _activeRequests;
    mapping(address token => bool) public cooldownDisabled;

    // @inheritdoc IERC20Cooldown
    function transfer(
        IERC20 token,
        address initialFrom,
        address to,
        uint256 amount,
        uint256 cooldownSeconds
    ) external override onlyRole(COOLDOWN_WORKER_ROLE) {
        if (amount == 0) return;

        if (cooldownSeconds == 0) {
            // Pass-through — no slot, no lock.
            token.safeTransferFrom(msg.sender, to, amount);
            emit Finalized(token, to, amount);
            return;
        }

        TRequest[] storage requests = _activeRequests[address(token)][to];
        uint256 requestsCount = requests.length;

        if (initialFrom != to && requestsCount >= PUBLIC_REQUEST_SLOTS_CAP) {
            revert ExternalReceiverRequestLimitReached(token, initialFrom, to, amount);
        }

        uint64 unlockAt = uint64(block.timestamp + cooldownSeconds);

        if (requestsCount < MAX_ACTIVE_REQUEST_SLOTS) {
            // Same-block request — merge with the last entry.
            if (requestsCount > 0 && requests[requestsCount - 1].unlockAt == unlockAt) {
                requests[requestsCount - 1].amount += uint192(amount);
            } else {
                requests.push(TRequest(unlockAt, uint192(amount)));
            }
        } else {
            // Slot cap reached — merge into last entry, extend its unlock.
            TRequest storage last = requests[requestsCount - 1];
            last.amount += uint192(amount);
            if (last.unlockAt < unlockAt) last.unlockAt = unlockAt;
        }

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit TransferRequested(token, initialFrom, to, amount, unlockAt);
    }

    // @inheritdoc ICooldown
    function finalize(IERC20 token, address user) external override returns (uint256) {
        return _finalize(token, user, block.timestamp);
    }

    // @inheritdoc ICooldown
    function finalize(IERC20 token, address user, uint256 evalAt) external override returns (uint256) {
        return _finalize(token, user, evalAt);
    }

    /**
     * @dev Swap-pop iteration; `evalAt <= block.timestamp` enforced.
     *      When `cooldownDisabled[token]` is true, all entries are
     *      claimable regardless of `unlockAt`.
     */
    function _finalize(IERC20 token, address user, uint256 evalAt) internal returns (uint256 claimed) {
        if (evalAt > block.timestamp) revert InvalidTime();

        TRequest[] storage requests = _activeRequests[address(token)][user];
        bool isCooldownActive = !cooldownDisabled[address(token)];

        uint256 len = requests.length;
        for (uint256 i; i < len;) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > evalAt) {
                unchecked { i++; }
                continue;
            }
            claimed += req.amount;
            if (i < len - 1) requests[i] = requests[len - 1];
            requests.pop();
            unchecked { len--; }
        }

        if (claimed == 0) revert NothingToFinalize();

        token.safeTransfer(user, claimed);
        emit Finalized(token, user, claimed);
    }

    /**
     * @inheritdoc IERC20Cooldown
     * @dev Strategy invokes this from its `setCooldowns` when all
     *      three tranche cooldowns drop to zero.
     */
    function setCooldownDisabled(IERC20 token, bool isCooldownDisabled)
        external override onlyRole(COOLDOWN_WORKER_ROLE)
    {
        cooldownDisabled[address(token)] = isCooldownDisabled;
    }

    // @inheritdoc ICooldown
    function balanceOf(IERC20 token, address user)
        external view override returns (ICooldown.TBalanceState memory)
    {
        return _balanceOf(token, user, block.timestamp);
    }

    // @inheritdoc ICooldown
    function balanceOf(IERC20 token, address user, uint256 evalAt)
        external view override returns (ICooldown.TBalanceState memory)
    {
        return _balanceOf(token, user, evalAt);
    }

    function _balanceOf(IERC20 token, address user, uint256 evalAt)
        internal view returns (ICooldown.TBalanceState memory)
    {
        TRequest[] storage requests = _activeRequests[address(token)][user];
        bool isCooldownActive = !cooldownDisabled[address(token)];

        uint256 len = requests.length;
        uint256 pending;
        uint256 claimable;
        uint256 nextUnlockAt;
        uint256 nextUnlockAmount;

        for (uint256 i; i < len; i++) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > evalAt) {
                pending += req.amount;
                if (nextUnlockAt == 0 || req.unlockAt < nextUnlockAt) {
                    nextUnlockAt = req.unlockAt;
                    nextUnlockAmount = req.amount;
                    continue;
                }
                if (req.unlockAt == nextUnlockAt) {
                    nextUnlockAmount += req.amount;
                }
                continue;
            }
            claimable += req.amount;
        }

        return ICooldown.TBalanceState({
            pending: pending,
            claimable: claimable,
            nextUnlockAt: nextUnlockAt,
            nextUnlockAmount: nextUnlockAmount,
            totalRequests: len
        });
    }

    function activeRequests(address token, address account, uint256 i)
        external view returns (TRequest memory)
    {
        return _activeRequests[token][account][i];
    }

    function activeRequestsLength(address token, address account)
        external view returns (uint256)
    {
        return _activeRequests[token][account].length;
    }
}
