// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IsUSDai } from "../interfaces/external/IsUSDai.sol";

/**
 * @notice ERC4626-style sUSDai mock with vesting state controls for
 *         AaveAprPairProvider tests. `totalAssets()` is overridable
 *         via `setTotalAssets` so tests can pin exchange rates and
 *         denominators without funding the contract.
 */
contract MockSUSDai is ERC4626, IsUSDai {
    uint256 public override lastDistributionTimestamp;
    uint256 private _unvestedAmount;
    uint256 private _totalAssetsOverride;
    bool private _useOverride;

    constructor(IERC20 underlying_) ERC4626(underlying_) ERC20("sUSDai", "sUSDai") {}

    function setVesting(uint256 unvested, uint256 timestamp) external {
        _unvestedAmount = unvested;
        lastDistributionTimestamp = timestamp;
    }

    function setTotalAssets(uint256 v) external {
        _useOverride = true;
        _totalAssetsOverride = v;
    }

    function clearTotalAssets() external {
        _useOverride = false;
    }

    function unvestedAmount() external view override returns (uint256) {
        return _unvestedAmount;
    }

    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        if (_useOverride) return _totalAssetsOverride;
        return super.totalAssets();
    }
}
