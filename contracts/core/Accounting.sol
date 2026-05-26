// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { UD60x18 } from "@prb/math/src/ud60x18/ValueType.sol";
import { ud } from "@prb/math/src/ud60x18/Casting.sol";

import { AccessControlled } from "../governance/AccessControlled.sol";
import { CDOComponent } from "../base/CDOComponent.sol";

import { ICDO } from "../interfaces/ICDO.sol";
import { ITranche } from "../interfaces/ITranche.sol";
import { IAccounting, TrancheKind } from "../interfaces/IAccounting.sol";
import { IAPRFeed } from "../interfaces/IAPRFeed.sol";

/**
 * @title  Accounting
 */
contract Accounting is AccessControlled, CDOComponent, IAccounting {
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /** @notice Seconds in a non-leap year. */
    uint256 public constant SECONDS_PER_YEAR = 31_536_000;

    /** @notice Cap on `reserveRate`: 20% of `netGain`, in 1e18 precision. */
    uint256 public constant RESERVE_BPS_MAX = 0.2e18;

    /** @dev SD7x12 feed upper bound: 200% APR. */
    int64 private constant APR_FEED_BOUNDARY_MAX = 2e12;
    /** @dev SD7x12 feed lower bound: 0% APR. */
    int64 private constant APR_FEED_BOUNDARY_MIN = 0;
    /** @dev Expected `IAPRFeed.decimals()` — SD7x12. */
    uint256 private constant APR_FEED_DECIMALS = 12;

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error NotImplemented();
    error InvalidTranche(address tranche);
    error InvalidFeedDecimals(uint8 actual, uint256 expected);
    error InvalidReserveRate(uint256 rate);
    error RiskPremiumTooHigh();
    error InvalidNavSplit(uint256 navT1, uint256 jr, uint256 mz, uint256 sr, uint256 reserve);
    error InvalidLeverageAlpha(uint256 alpha);

    // ---------------------------------------------------------------
    // Storage — tranche TVLs and total NAV
    // ---------------------------------------------------------------

    uint256 public tvlJr;
    uint256 public tvlMz;
    uint256 public tvlSr;
    uint256 public tvlReserve;

    /** @notice Last-recorded total strategy NAV. */
    uint256 public nav;

    // ---------------------------------------------------------------
    // Storage — APR feed and APR values
    // ---------------------------------------------------------------

    /** @notice External APR pair feed. `address(0)` disables pulls. */
    IAPRFeed public override aprPairFeed;

    /** @notice Floor target APR for Senior. */
    UD60x18 public override aprTarget;
    /** @notice Base APR pulled from the feed and normalised to UD60x18. */
    UD60x18 public override aprBase;
    /** @notice Senior target APR: `max(aprTarget, aprBase × (1 - RP_nominal))`. */
    UD60x18 public override aprSrt;

    // ---------------------------------------------------------------
    // Storage — Risk premium parameters (UD60x18)
    // ---------------------------------------------------------------

    UD60x18 public override riskX;
    UD60x18 public override riskY;
    UD60x18 public override riskK;

    // ---------------------------------------------------------------
    // Storage — yield-split parameters
    // ---------------------------------------------------------------

    uint256 public override leverageAlpha;
    uint256 public override reserveRate;

    // ---------------------------------------------------------------
    // Storage — Senior compounding index
    // ---------------------------------------------------------------

    /** @notice Senior target index. Compounds via `aprSrt` over `dt`. */
    uint256 public override srtTargetIndex;
    uint256 public override lastUpdateTime;

    // ---------------------------------------------------------------
    // Storage gap
    // ---------------------------------------------------------------

    /** @dev Reserved for additional fields in future versions. */
    uint256[34] private __gap;

    // ---------------------------------------------------------------
    // Initialiser
    // ---------------------------------------------------------------

    /**
     * @notice Initialise the Accounting proxy.
     * @dev    `aprPairFeed_` may be `address(0)` — pulls no-op until {setAprPairFeed}.
     */
    function initialize(address cdo_, IAPRFeed aprPairFeed_, address owner_, address acm_) external initializer {
        if (cdo_ == address(0)) revert InvalidCaller(address(0));
        AccessControlled_init(owner_, acm_);

        cdo = ICDO(cdo_);
        aprPairFeed = aprPairFeed_;

        // Senior index seed = 1.0.
        srtTargetIndex = 1e18;
        lastUpdateTime = block.timestamp;

        // Defaults: x = y = 20%, k = 0.3.
        riskX = ud(0.2e18);
        riskY = ud(0.2e18);
        riskK = ud(0.3e18);

        // Neutral leverage — Mz/Jr split purely by TVL.
        leverageAlpha = 1e18;
    }

    // ---------------------------------------------------------------
    // State-changing — driven by CDO
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IAccounting
     */
    function updateAccounting(uint256 /*navT1*/) external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function updateBalanceFlow(
        uint256 /*jrIn*/,
        uint256 /*jrOut*/,
        uint256 /*mzIn*/,
        uint256 /*mzOut*/,
        uint256 /*srIn*/,
        uint256 /*srOut*/
    ) external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function updateBalanceFlow() external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function accrueFee(address /*tranche*/, uint256 /*assets*/) external onlyCDO {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function reduceReserve(
        uint256 /*totalAmount*/,
        uint256 /*jrDistribute*/,
        uint256 /*mzDistribute*/,
        uint256 /*srDistribute*/
    ) external onlyCDO {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // State-changing — APR pipeline + admin setters
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IAccounting
     */
    function onAprChanged() external onlyRole(UPDATER_FEED_ROLE) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     * @dev `address(0)` detaches the feed; non-zero feeds must report
     *      `decimals() == APR_FEED_DECIMALS`.
     */
    function setAprPairFeed(IAPRFeed aprPairFeed_) external onlyOwner {
        if (address(aprPairFeed_) != address(0)) {
            uint8 feedDecimals = aprPairFeed_.decimals();
            if (uint256(feedDecimals) != APR_FEED_DECIMALS) {
                revert InvalidFeedDecimals(feedDecimals, APR_FEED_DECIMALS);
            }
        }
        aprPairFeed = aprPairFeed_;
        emit AprPairFeedChanged(address(aprPairFeed_));
    }

    /**
     * @inheritdoc IAccounting
     */
    function setRiskParameters(
        UD60x18 /*riskX_*/,
        UD60x18 /*riskY_*/,
        UD60x18 /*riskK_*/
    ) external onlyRole(UPDATER_STRAT_CONFIG_ROLE) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function setReserveRate(uint256 /*rate*/) external onlyOwner {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function setLeverageAlpha(uint256 /*alpha*/) external onlyOwner {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /**
     * @inheritdoc IAccounting
     */
    function totalAssets(
        uint256 /*navT1*/
    ) external view returns (uint256 jrAssets, uint256 mzAssets, uint256 srAssets, uint256 reserveAssets) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function totalAssetsT0()
        external
        view
        returns (uint256 jrTvl_, uint256 mzTvl_, uint256 srTvl_, uint256 reserveTvl_)
    {
        return (tvlJr, tvlMz, tvlSr, tvlReserve);
    }

    /**
     * @inheritdoc IAccounting
     */
    function totalAssets(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function maxDeposit(address /*tranche*/) external view returns (uint256) {
        revert NotImplemented();
    }

    /**
     * @inheritdoc IAccounting
     */
    function maxWithdraw(address /*tranche*/, bool /*isSharesLockup*/) external view returns (uint256) {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // Public view — NAV split projection (stub)
    // ---------------------------------------------------------------

    /**
     * @notice Project the next-state NAV split given a fresh strategy NAV.
     * @dev    Stub — yield-split model under reconsideration.
     */
    function calculateNAVSplit(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) public pure returns (uint256, uint256, uint256, uint256) {
        revert NotImplemented();
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    /** @dev Resolve a wired tranche address to its kind; reverts otherwise. */
    function _kindOf(address tranche) internal view returns (TrancheKind) {
        if (tranche == address(cdo.jrVault())) return TrancheKind.JUNIOR;
        if (tranche == address(cdo.mezzVault())) return TrancheKind.MEZZANINE;
        if (tranche == address(cdo.srVault())) return TrancheKind.SENIOR;
        revert InvalidTranche(tranche);
    }
}
