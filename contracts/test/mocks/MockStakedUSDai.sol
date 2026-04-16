// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Mock sUSDai matching the actual Arbiscan ABI:
 *      ERC-4626 deposit (sync) + ERC-7540 FIFO queue redeem (async).
 *      redemption() returns Redemption struct with exact redemptionTimestamp.
 *      serviceRedemptions() marks redemptions as claimable (admin).
 *      redeem() transfers USDai when claimable.
 */
contract MockStakedUSDai is ERC20 {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES (matches actual sUSDai ABI)
    // ═══════════════════════════════════════════════════════════════════

    struct Redemption {
        uint256 prev;
        uint256 next;
        uint256 pendingShares;
        uint256 redeemableShares;
        uint256 withdrawableAmount;
        address controller;
        uint64 redemptionTimestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    IERC20 public immutable usdai;
    uint256 private _rate; // 1e18 = 1:1

    uint256 public s_nextRedemptionId;
    mapping(uint256 => Redemption) public s_redemptions;
    mapping(address => uint256[]) public s_controllerRedemptionIds;

    uint256 public s_defaultCooldown; // configurable for tests

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event RedeemRequested(uint256 indexed redemptionId, address indexed controller, uint256 shares);
    event RedemptionServiced(uint256 indexed redemptionId, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address usdai_, uint256 initialRate_) ERC20("Staked USDai", "sUSDai") {
        usdai = IERC20(usdai_);
        _rate = initialRate_;
        s_defaultCooldown = 7 days;
        s_nextRedemptionId = 1; // start at 1
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 — deposit (synchronous)
    // ═══════════════════════════════════════════════════════════════════

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        usdai.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-7540 — requestRedeem (async FIFO queue)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Matches actual sUSDai: requestRedeem(shares, controller, owner) → redemptionId
     *      Burns shares from owner, creates pending redemption with exact timestamp.
     */
    function requestRedeem(uint256 shares, address controller, address owner_) external returns (uint256 redemptionId) {
        require(balanceOf(owner_) >= shares, "insufficient shares");
        if (msg.sender != owner_) {
            require(allowance(owner_, msg.sender) >= shares, "insufficient allowance");
            _spendAllowance(owner_, msg.sender, shares);
        }

        _burn(owner_, shares);

        redemptionId = s_nextRedemptionId++;
        uint256 assets = _sharesToAssets(shares);

        s_redemptions[redemptionId] = Redemption({
            prev: 0,
            next: 0,
            pendingShares: shares,
            redeemableShares: 0,
            withdrawableAmount: 0,
            controller: controller,
            redemptionTimestamp: uint64(block.timestamp + s_defaultCooldown)
        });

        s_controllerRedemptionIds[controller].push(redemptionId);

        emit RedeemRequested(redemptionId, controller, shares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-7540 — redemption view (matches actual ABI)
    // ═══════════════════════════════════════════════════════════════════

    /** @dev Returns (Redemption struct, 0). Second return mimics actual ABI. */
    function redemption(uint256 redemptionId) external view returns (Redemption memory, uint256) {
        return (s_redemptions[redemptionId], 0);
    }

    function claimableRedeemRequest(uint256 redemptionId, address) external view returns (uint256) {
        Redemption memory r = s_redemptions[redemptionId];
        return r.redeemableShares;
    }

    function pendingRedeemRequest(uint256 redemptionId, address) external view returns (uint256) {
        Redemption memory r = s_redemptions[redemptionId];
        return r.pendingShares;
    }

    function redemptionIds(address controller) external view returns (uint256[] memory) {
        return s_controllerRedemptionIds[controller];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-7540 — serviceRedemptions (admin marks as claimable)
    // ═══════════════════════════════════════════════════════════════════

    /** @dev Admin-only in real contract. Moves pending → redeemable. */
    function serviceRedemptions(uint256 redemptionId) external {
        Redemption storage r = s_redemptions[redemptionId];
        require(r.pendingShares > 0, "nothing pending");

        uint256 assets = _sharesToAssets(r.pendingShares);
        r.redeemableShares = r.pendingShares;
        r.withdrawableAmount = assets;
        r.pendingShares = 0;

        emit RedemptionServiced(redemptionId, assets);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-7540 — redeem (claim after serviced)
    // ═══════════════════════════════════════════════════════════════════

    /** @dev Transfers USDai to receiver. Only works after serviceRedemptions. */
    function redeem(uint256, address receiver, address controller) external returns (uint256 assets) {
        uint256[] memory ids = s_controllerRedemptionIds[controller];
        for (uint256 i = 0; i < ids.length; i++) {
            Redemption storage r = s_redemptions[ids[i]];
            if (r.redeemableShares > 0 && r.controller == controller) {
                assets += r.withdrawableAmount;
                r.redeemableShares = 0;
                r.withdrawableAmount = 0;
            }
        }
        require(assets > 0, "nothing claimable");
        usdai.transfer(receiver, assets);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 — view
    // ═══════════════════════════════════════════════════════════════════

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return shares * _rate / 1e18;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return assets * 1e18 / _rate;
    }

    function asset() external view returns (address) {
        return address(usdai);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function setRate(uint256 newRate) external {
        _rate = newRate;
    }

    function setDefaultCooldown(uint256 duration_) external {
        s_defaultCooldown = duration_;
    }

    function _sharesToAssets(uint256 shares) internal view returns (uint256) {
        return shares * _rate / 1e18;
    }
}
