// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ITranche } from "../../interfaces/ITranche.sol";
import { ICooldown } from "../../interfaces/cooldown/ICooldown.sol";
import { ISharesCooldown } from "../../interfaces/cooldown/ISharesCooldown.sol";
import { CooldownBase } from "./CooldownBase.sol";

/**
 * @title  SharesCooldown
 * @notice Silo that holds tranche vault shares during the
 *         coverage-driven cooldown period.
 */
contract SharesCooldown is ISharesCooldown, CooldownBase {
    uint256 private constant PERCENTAGE_100 = 1e18;
    uint256 private constant MAX_FEE_PER_DAY = 0.01e18; // 1%/day cap
    uint256 private constant SECONDS_PER_DAY = 1 days;

    mapping(address vault => mapping(address account => TRequest[])) private _activeRequests;

    mapping(address vault => uint256) public override vaultEarlyExitFeePerDay;
    mapping(address vault => TExitUpperBounds) private _vaultExitBounds;

    modifier onlyUser(address user) {
        if (msg.sender != user) revert OnlySharesOwner(msg.sender, user);
        _;
    }

    // ---------------------------------------------------------------
    // Worker entrypoint
    // ---------------------------------------------------------------

    function requestRedeem(
        ITranche vault,
        address token,
        address initialFrom,
        address to,
        uint256 shares,
        uint256 fee,
        uint32 cooldownSeconds
    ) external onlyRole(COOLDOWN_WORKER_ROLE) {
        if (shares == 0) return;

        if (fee > 0) {
            (uint256 sharesUser, ) = _accrueFee(vault, shares, fee);
            shares = sharesUser;
        }

        if (cooldownSeconds == 0) {
            // No lock — finalise immediately.
            vault.redeem(token, shares, to, address(this));
            emit Finalized(IERC20(address(vault)), to, shares);
            return;
        }

        TRequest[] storage requests = _activeRequests[address(vault)][to];
        uint256 requestsCount = requests.length;

        if (initialFrom != to && requestsCount >= PUBLIC_REQUEST_SLOTS_CAP) {
            revert ExternalReceiverRequestLimitReached(IERC20(address(vault)), initialFrom, to, shares);
        }

        uint64 unlockAt = uint64(block.timestamp + cooldownSeconds);

        if (requestsCount < MAX_ACTIVE_REQUEST_SLOTS) {
            if (requestsCount > 0 && requests[requestsCount - 1].unlockAt == unlockAt) {
                // Same-block request — merge with the last entry.
                TRequest storage last = requests[requestsCount - 1];
                last.token = token;
                last.shares += uint192(shares);
            } else requests.push(TRequest(unlockAt, uint192(shares), token));
        } else {
            // Slot cap reached — merge into last and extend unlock.
            TRequest storage last = requests[requestsCount - 1];
            last.token = token;
            last.shares += uint192(shares);
            if (last.unlockAt < unlockAt) last.unlockAt = unlockAt;
        }

        emit RequestedCooldown(address(vault), token, initialFrom, to, shares, unlockAt);
    }

    // ---------------------------------------------------------------
    // User-facing
    // ---------------------------------------------------------------

    function finalize(IERC20 vault, address user) external returns (uint256 claimed) {
        return _finalizePublic(ITranche(address(vault)), address(0), user, block.timestamp);
    }

    function finalize(IERC20 vault, address user, uint256 _at) external returns (uint256 claimed) {
        return _finalizePublic(ITranche(address(vault)), address(0), user, _at);
    }

    function finalize(ITranche vault, address token, address user) external returns (uint256 claimed) {
        return _finalizePublic(vault, token, user, block.timestamp);
    }

    function finalize(ITranche vault, address token, address user, uint256 _at) external returns (uint256 claimed) {
        return _finalizePublic(vault, token, user, _at);
    }

    function finalizeWithTokenOverride(
        IERC20 vault,
        address token,
        address user
    ) external onlyUser(user) returns (uint256 claimed) {
        claimed = _finalizeAll(address(vault), user, token, block.timestamp);
        emit Finalized(vault, user, claimed);
    }

    function finalizeWithFee(
        ITranche vault,
        address token,
        address user,
        uint256 i,
        TFinalizeWithFeeGuard calldata guard
    ) external onlyUser(user) returns (uint256 claimed) {
        TRequest[] storage requests = _activeRequests[address(vault)][user];
        uint256 len = requests.length;
        if (i >= len) revert OutOfRange(i, len);

        TRequest memory req = requests[i];
        if (req.unlockAt <= block.timestamp) revert RequestReady(req.unlockAt, block.timestamp);
        if (guard.shares != 0 && guard.shares != req.shares) {
            revert UnexpectedShares(req.shares, guard.shares);
        }

        // Swap-pop the entry.
        if (i < len - 1) requests[i] = requests[len - 1];
        requests.pop();

        uint256 shares = req.shares;
        uint256 daysLeft = (req.unlockAt - block.timestamp) / SECONDS_PER_DAY + 1;
        uint256 feePerDay = vaultEarlyExitFeePerDay[address(vault)];

        if (guard.daysLeft != 0 && guard.daysLeft != daysLeft) {
            revert UnexpectedDays(daysLeft, guard.daysLeft);
        }

        (uint256 sharesUser, uint256 sharesFee) = _accrueFee(vault, shares, feePerDay * daysLeft);

        address tokenToRedeem = token != address(0) ? token : req.token;
        vault.redeem(tokenToRedeem, sharesUser, user, address(this));

        emit ExitFeeAccrued(address(vault), user, sharesFee, sharesUser);
        return sharesUser;
    }

    function cancel(IERC20 vault, address user, uint256 i, TCancelGuard calldata guard) external onlyUser(user) {
        TRequest[] storage requests = _activeRequests[address(vault)][user];
        uint256 len = requests.length;
        if (i >= len) revert OutOfRange(i, len);

        TRequest memory req = requests[i];
        if (guard.shares != 0 && guard.shares != req.shares) {
            revert UnexpectedShares(req.shares, guard.shares);
        }

        if (i < len - 1) requests[i] = requests[len - 1];
        requests.pop();

        // Return shares to the recipient (no fee on cancel).
        IERC20(address(vault)).transfer(user, req.shares);
        emit RequestCanceled(address(vault), user, req.shares);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setVaultExitBounds(address vault, TExitUpperBounds calldata bounds) external onlyOwner {
        if (bounds.p0 > bounds.p1) revert InvalidBounds(bounds.p0, bounds.p1);
        _vaultExitBounds[vault] = bounds;
        emit VaultCooldownBoundsUpdated(vault, bounds);
    }

    function setVaultEarlyExitFee(address vault, uint256 fee) external onlyOwner {
        if (fee > MAX_FEE_PER_DAY) revert InvalidFee(fee);
        vaultEarlyExitFeePerDay[vault] = fee;
        emit VaultEarlyExitFeeSet(vault, fee);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function calculateExitParams(address vault, uint256 coverage_) public view returns (TExitParams memory) {
        TExitUpperBounds memory bounds = _vaultExitBounds[vault];
        if (coverage_ <= bounds.p0) return bounds.r0;
        if (coverage_ <= bounds.p1) return bounds.r1;
        return bounds.r2;
    }

    function vaultExitBounds(address vault) external view returns (TExitUpperBounds memory) {
        return _vaultExitBounds[vault];
    }

    function activeRequests(address vault, address account, uint256 i) external view returns (TRequest memory) {
        return _activeRequests[vault][account][i];
    }

    function activeRequestsLength(address vault, address account) external view returns (uint256) {
        return _activeRequests[vault][account].length;
    }

    function balanceOf(IERC20 vault, address user) external view returns (ICooldown.TBalanceState memory) {
        return _balanceOf(vault, user, block.timestamp);
    }

    function balanceOf(IERC20 vault, address user, uint256 _at) external view returns (ICooldown.TBalanceState memory) {
        return _balanceOf(vault, user, _at);
    }

    // ---------------------------------------------------------------
    // Internal — finalisation
    // ---------------------------------------------------------------

    function _finalizePublic(
        ITranche vault,
        address token,
        address user,
        uint256 _at
    ) internal returns (uint256 claimed) {
        if (token == address(0)) {
            claimed = _finalizeAll(address(vault), user, address(0), _at);
        } else {
            (claimed, ) = _processFinalization(address(vault), user, token, address(0), _at);
        }
        if (claimed == 0) revert NothingToFinalize();
        emit Finalized(IERC20(address(vault)), user, claimed);
    }

    function _finalizeAll(
        address vault,
        address user,
        address overrideToken,
        uint256 _at
    ) internal returns (uint256 claimed) {
        if (overrideToken != address(0)) {
            (claimed, ) = _processFinalization(vault, user, address(0), overrideToken, _at);
            return claimed;
        }
        address finalizeToken = ITranche(vault).asset();
        while (true) {
            (uint256 singleClaimed, address nextToken) = _processFinalization(
                vault,
                user,
                finalizeToken,
                overrideToken,
                _at
            );
            claimed += singleClaimed;
            if (nextToken == address(0)) break;
            finalizeToken = nextToken;
        }
    }

    function _processFinalization(
        address vault,
        address user,
        address token,
        address overrideToken,
        uint256 _at
    ) internal returns (uint256 claimed, address nextToken) {
        if (_at > block.timestamp) revert InvalidTime();
        // either `token` filters per-request, or `overrideToken` is
        // the redemption asset for matched requests
        if (token == address(0) && overrideToken == address(0)) revert UnsupportedToken(address(0));

        TRequest[] storage requests = _activeRequests[vault][user];
        bool isCooldownActive = _isCooldownActive(vault);

        uint256 len = requests.length;
        for (uint256 i; i < len; ) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > _at) {
                // still pending
                unchecked {
                    i++;
                }
                continue;
            }
            if (token != address(0) && token != req.token) {
                if (nextToken == address(0)) nextToken = req.token;
                unchecked {
                    i++;
                }
                continue;
            }

            claimed += req.shares;

            // Swap-pop.
            if (i < len - 1) requests[i] = requests[len - 1];
            requests.pop();
            unchecked {
                len--;
            }
        }

        if (claimed > 0) {
            address tokenToRedeem = overrideToken != address(0) ? overrideToken : token;
            ITranche(vault).redeem(tokenToRedeem, claimed, user, address(this));
        }
    }

    function _balanceOf(
        IERC20 vault,
        address user,
        uint256 _at
    ) internal view returns (ICooldown.TBalanceState memory) {
        TRequest[] storage requests = _activeRequests[address(vault)][user];
        bool isCooldownActive = _isCooldownActive(address(vault));

        uint256 len = requests.length;
        uint256 pending;
        uint256 claimable;
        uint256 nextUnlockAt;
        uint256 nextUnlockAmount;

        for (uint256 i; i < len; i++) {
            TRequest memory req = requests[i];
            if (isCooldownActive && req.unlockAt > _at) {
                pending += req.shares;
                if (nextUnlockAt == 0 || req.unlockAt < nextUnlockAt) {
                    nextUnlockAt = req.unlockAt;
                    nextUnlockAmount = req.shares;
                    continue;
                }
                if (req.unlockAt == nextUnlockAt) nextUnlockAmount += req.shares;
                continue;
            }
            claimable += req.shares;
        }

        return
            ICooldown.TBalanceState({
                pending: pending,
                claimable: claimable,
                nextUnlockAt: nextUnlockAt,
                nextUnlockAmount: nextUnlockAmount,
                totalRequests: len
            });
    }

    // ---------------------------------------------------------------
    // Internal — fee / helpers
    // ---------------------------------------------------------------

    function _accrueFee(
        ITranche vault,
        uint256 shares,
        uint256 feeBps
    ) internal returns (uint256 sharesUser, uint256 sharesFee) {
        sharesFee = Math.mulDiv(shares, feeBps, PERCENTAGE_100, Math.Rounding.Floor);
        sharesUser = shares > sharesFee ? shares - sharesFee : 0;
        if (sharesUser == 0 || sharesFee == 0) revert EmptyFee();
        vault.burnSharesAsFee(sharesFee, address(this));
    }

    function _isCooldownActive(address vault) internal view returns (bool) {
        TExitUpperBounds memory bounds = _vaultExitBounds[vault];
        return bounds.p1 > 0 || bounds.r2.sharesLock > 0;
    }
}
