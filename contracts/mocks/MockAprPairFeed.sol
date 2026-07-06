// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IAPRFeed } from "../interfaces/IAPRFeed.sol";

/**
 * @notice Mock of the legacy `IAPRFeed` interface consumed by
 *         `Accounting`. Lets tests pin `latestRoundData()` to known
 *         values without deploying the real oracle.
 */
contract MockAprPairFeed is IAPRFeed {
    Round private _latest;
    uint8 private _decimals = 12;

    function setLatestRound(int64 aprTarget, int64 aprBase, uint80 roundId, uint256 updatedAt) external {
        _latest = Round({
            roundId: roundId,
            aprTarget: aprTarget,
            aprBase: aprBase,
            updatedAt: updatedAt
        });
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function latestRoundData() external view override returns (Round memory) {
        return _latest;
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }
}
