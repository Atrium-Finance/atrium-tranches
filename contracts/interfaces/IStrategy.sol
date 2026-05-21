// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title IStrategy
 * @notice Minimal strategy surface required by the tranche deposit/mint flows.
 *         Full strategy responsibilities (staking, TVL reporting, withdrawal
 *         paths) are out of scope for this interface.
 */
interface IStrategy {
    /**
     * @notice Convert an amount of a meta-vault token into the protocol's
     *         base asset units, applying the requested rounding mode.
     * @dev Reverts if `token` is not a supported meta-vault.
     */
    function convertToAssets(
        address token,
        uint256 tokenAmount,
        Math.Rounding rounding
    ) external view returns (uint256);

    /**
     * @notice Convert an amount of base assets into units of `token`,
     *         applying the requested rounding mode.
     * @dev Reverts if `token` is not a supported meta-vault.
     */
    function convertToTokens(
        address token,
        uint256 baseAssets,
        Math.Rounding rounding
    ) external view returns (uint256);

    /**
     * @notice Pulls `amount` of `token` from `from` and stakes it.
     * @dev    Caller must be the CDO. `from` is the tranche that has
     *         pre-approved the Strategy via {ITranche.configure}.
     * @param  from   The tranche holding the tokens.
     * @param  token  The token to pull and stake.
     * @param  amount The amount of `token` to pull.
     */
    function deposit(address from, address token, uint256 amount) external;

    /**
     * @notice Returns the list of tokens the strategy currently supports
     *         for deposit. Bounded list, controlled by Strategy's admin.
     */
    function getSupportedTokens() external view returns (IERC20[] memory);
}
