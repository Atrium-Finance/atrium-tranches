// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/**
 * @title IAccounting
 * @notice Minimal accounting surface required by `PrimeCDO`. The full
 *         accounting responsibilities (yield split, loss waterfall, exchange
 *         rates, Senior target index) are deferred to a dedicated spec.
 */
interface IAccounting {
    /**
     * @notice Refreshes total TVL from strategy and settles yield since the
     *         previous call.
     */
    function updateAccounting() external;

    /**
     * @notice Returns the current accounting TVL attributable to a tranche.
     * @param tranche The tranche vault address (jr, mezz, or sr).
     */
    function totalAssets(address tranche) external view returns (uint256);
}
