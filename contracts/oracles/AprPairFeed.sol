// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { AccessControlled } from "../governance/AccessControlled.sol";
import { IAprPairFeed } from "../interfaces/oracles/IAprPairFeed.sol";
import { IStrategyAprProvider } from "../interfaces/oracles/IStrategyAprProvider.sol";

/**
 * @title  AprPairFeed
 * @notice `(aprBase, aprTarget)` oracle for Atrium Senior pricing.
 *         Prefers fresh PUSH rounds; falls back to PULL from the
 *         wired {IStrategyAprProvider} when stale.
 */
contract AprPairFeed is IAprPairFeed, AccessControlled {
    /**
     * @dev SD7x12 valid range — `[-50%, +200%]`. Matches the
     *      Accounting feed normaliser bounds.
     */
    int64 private constant APR_MAX = 2e12;
    int64 private constant APR_MIN = -0.5e12;

    // @dev Clock-skew tolerance for future-dated PUSH timestamps.
    uint64 private constant MAX_FUTURE_DRIFT = 60;

    // @notice SD7x12 encoding — 12 decimals.
    uint8 public constant override decimals = 12;

    // @notice Historical rounds retained in the ring buffer.
    uint8 public constant roundsCap = 20;

    string public description;
    uint64 public latestRoundId;
    TRound public latestRound;
    mapping(uint64 => TRound) public rounds;

    uint256 public roundStaleAfter;
    IStrategyAprProvider public provider;

    enum ESourcePref {
        Feed,
        Strategy
    }
    ESourcePref public sourcePref;

    event AnswerUpdated(int64 aprBase, int64 aprTarget, uint64 roundId, uint64 updatedAt);
    event ProviderSet(address provider);
    event StalePeriodSet(uint256 period);
    event SourcePrefChanged(ESourcePref pref);

    error StaleUpdate(int64 aprBase, uint64 timestamp);
    error OutOfOrderUpdate(int64 aprBase, uint64 timestamp);
    error InvalidApr(int64 apr);
    error NoDataPresent();
    error OldRound();

    // @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address acm_,
        IStrategyAprProvider provider_,
        uint256 roundStaleAfter_,
        string memory description_
    ) external initializer {
        AccessControlled_init(owner_, acm_);
        provider = provider_;
        roundStaleAfter = roundStaleAfter_;
        description = description_;
    }

    // @inheritdoc IAprPairFeed
    function latestRoundData() external view override returns (TRound memory) {
        TRound memory round = latestRound;

        if (sourcePref == ESourcePref.Feed && round.updatedAt != 0) {
            // Guard against future-dated rounds (clock skew): a future
            // round is by definition fresh, dt clamps to 0.
            uint256 dt = block.timestamp > round.updatedAt ? block.timestamp - uint256(round.updatedAt) : 0;
            if (dt < roundStaleAfter) {
                return round;
            }
            // fall through to PULL
        }

        (int64 aprBase, int64 aprTarget, uint64 t1) = provider.getApr();
        _ensureValid(aprBase);
        _ensureValid(aprTarget);
        return TRound({ aprBase: aprBase, aprTarget: aprTarget, updatedAt: t1, answeredInRound: latestRoundId + 1 });
    }

    // @inheritdoc IAprPairFeed
    function getRoundData(uint64 roundId) external view override returns (TRound memory) {
        uint64 idx = roundId % uint64(roundsCap);
        TRound memory round = rounds[idx];
        if (round.updatedAt == 0) revert NoDataPresent();
        if (round.answeredInRound != roundId) revert OldRound();
        return round;
    }

    // @inheritdoc IAprPairFeed
    function updateRoundData(
        int64 aprBase,
        int64 aprTarget,
        uint64 timestamp
    ) external override onlyRole(UPDATER_FEED_ROLE) {
        _updateRoundDataInner(aprBase, aprTarget, timestamp);
        _setSourcePref(ESourcePref.Feed);
    }

    // @inheritdoc IAprPairFeed
    function updateRoundData() external override onlyRole(UPDATER_FEED_ROLE) {
        (int64 aprBase, int64 aprTarget, uint64 t) = provider.getApr();
        _updateRoundDataInner(aprBase, aprTarget, t);
        _setSourcePref(ESourcePref.Strategy);
    }

    function _updateRoundDataInner(int64 aprBase, int64 aprTarget, uint64 t) internal {
        // Skip staleness check when chain time hasn't yet exceeded
        // `roundStaleAfter` (test-chain / fresh-fork safety).
        if (block.timestamp > roundStaleAfter && uint256(t) < block.timestamp - roundStaleAfter) {
            revert StaleUpdate(aprBase, t);
        }
        if (t <= latestRound.updatedAt || uint256(t) > block.timestamp + MAX_FUTURE_DRIFT) {
            revert OutOfOrderUpdate(aprBase, t);
        }
        _ensureValid(aprBase);
        _ensureValid(aprTarget);

        uint64 roundId = latestRoundId + 1;
        uint64 idx = roundId % uint64(roundsCap);

        latestRoundId = roundId;
        latestRound = TRound({ aprBase: aprBase, aprTarget: aprTarget, updatedAt: t, answeredInRound: roundId });
        rounds[idx] = latestRound;

        emit AnswerUpdated(aprBase, aprTarget, roundId, t);
    }

    function _setSourcePref(ESourcePref pref) internal {
        if (sourcePref != pref) {
            sourcePref = pref;
            emit SourcePrefChanged(pref);
        }
    }

    function _ensureValid(int64 apr) internal pure {
        if (apr < APR_MIN || apr > APR_MAX) revert InvalidApr(apr);
    }

    /**
     * @notice Owner-only. Validates the provider via {getApr} before
     *         registering — rejects misconfigured providers at the
     *         registration moment, not at first read.
     */
    function setProvider(IStrategyAprProvider provider_) external onlyOwner {
        (int64 aprBase, int64 aprTarget, ) = provider_.getApr();
        _ensureValid(aprBase);
        _ensureValid(aprTarget);
        provider = provider_;
        emit ProviderSet(address(provider_));
    }

    function setRoundStaleAfter(uint256 period) external onlyOwner {
        roundStaleAfter = period;
        emit StalePeriodSet(period);
    }
}
