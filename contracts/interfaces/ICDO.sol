// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ITranche } from "./ITranche.sol";
import { IStrategy } from "./IStrategy.sol";

/**
 * @title ICDO
 * @notice Primary entry point for tranche coordination, accounting, deposits, and withdrawals.
 */
interface ICDO {
    function jrVault() external view returns (ITranche);

    function mezzVault() external view returns (ITranche);

    function srVault() external view returns (ITranche);

    function strategy() external view returns (IStrategy);

    function totalAssets(address tranche) external view returns (uint256);

    function updateAccounting() external;

    function deposit(address tranche, address token, uint256 tokenAmount, uint256 baseAssets) external;

    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner,
        address receiver
    ) external;

    function maxWithdraw(address tranche) external view returns (uint256);

    function maxWithdraw(address tranche, address owner) external view returns (uint256);

    function maxDeposit(address tranche) external view returns (uint256);
}
