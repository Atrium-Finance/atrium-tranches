# 18 — Unit Tests (Per-Module)

## Overview

Detailed unit-test specification covering every Atrium contract individually.
One test file per contract. Mocked dependencies (no live Strategy required
to test Accounting, no live Accounting required to test Tranche, etc.).

Stack: **Hardhat + TypeScript + viem + Mocha/Chai**. Coverage via
`@nomicfoundation/hardhat-toolbox-viem` and `solidity-coverage`.

Out of scope:

- Integration tests across full deposit/withdraw cycles (spec 19)
- Mainnet fork tests (spec 20)
- Fuzz / invariant testing (defer to audit prep)
- E2E UI tests

---

## Architecture decisions

| #   | Decision                 | Value                                                         |
| --- | ------------------------ | ------------------------------------------------------------- |
| F1  | Test framework           | Hardhat + TypeScript + Mocha/Chai                             |
| F2  | Contract interaction lib | **viem** (NOT ethers.js)                                      |
| F3  | Test runner              | `hardhat test` with `@nomicfoundation/hardhat-toolbox-viem`   |
| F4  | Organization             | One `.test.ts` file per contract under `test/unit/`           |
| F5  | Mock strategy            | Solidity mocks under `contracts/mocks/`, deployed per-test    |
| F6  | Fixture pattern          | `loadFixture` from `@nomicfoundation/hardhat-network-helpers` |
| F7  | Coverage targets         | 95% line, 90% branch, 100% function, **100% critical paths**  |
| F8  | Critical paths           | Accounting NAV split, loss waterfall, deposit/withdraw bodies |
| F9  | Assertion style          | Chai `expect`                                                 |
| F10 | Time manipulation        | `time.increase`, `time.setNextBlockTimestamp` from helpers    |

---

## File structure

```text
test/
├── unit/
│   ├── core/
│   │   ├── PrimeCDO.test.ts
│   │   ├── Accounting.test.ts
│   │   └── Strategy.test.ts                # abstract base behavior via mock
│   ├── vaults/
│   │   └── Tranche.test.ts
│   ├── strategies/
│   │   └── USDAStrategy.test.ts
│   ├── oracles/
│   │   ├── AprPairFeed.test.ts
│   │   └── AaveAprPairProvider.test.ts
│   ├── cooldown/
│   │   ├── CooldownBase.test.ts            # abstract via mock
│   │   ├── ERC20Cooldown.test.ts
│   │   └── SharesCooldown.test.ts
│   └── governance/
│       ├── AccessControlManager.test.ts
│       └── AccessControlled.test.ts        # via test harness
├── fixtures/
│   ├── deployAtrium.ts                     # full-stack fixture
│   ├── deployAccountingOnly.ts             # Accounting + mocks
│   ├── deployTrancheOnly.ts                # Tranche + mock CDO
│   ├── deployStrategyOnly.ts               # Strategy + mock CDO + mock sUSDai
│   └── deployCooldown.ts                   # Cooldown + mock token
├── helpers/
│   ├── viemClients.ts                      # public + wallet client setup
│   ├── deployments.ts                      # typed deploy helpers
│   ├── time.ts                             # time manipulation wrappers
│   └── apr.ts                              # APR encoding (RAY / 12-dec / UD60x18)
├── mocks/                                  # solidity mocks
│   ├── MockSUSDai.sol                      # ERC4626 with vesting methods
│   ├── MockAavePool.sol                    # configurable getReserveData
│   ├── MockStrategy.sol                    # exposes onlyCDO surface for Accounting tests
│   ├── MockAccounting.sol                  # exposes onlyCDO surface for CDO tests
│   ├── MockCDO.sol                         # exposes ICDO surface for Tranche tests
│   ├── MockERC20.sol                       # standard 18-dec ERC20 with mint
│   ├── MockSharesAprProvider.sol           # configurable getApr()
│   └── ReenteringERC20.sol                 # for reentrancy tests
└── hardhat.config.ts
```

---

## hardhat.config.ts essentials

```typescript
import "@nomicfoundation/hardhat-toolbox-viem";
import "solidity-coverage";

export default {
  solidity: {
    version: "0.8.35",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: { allowUnlimitedContractSize: true },
  },
};
```

---

## helpers/viemClients.ts pattern

```typescript
import { createPublicClient, createWalletClient, custom } from "viem";
import { hardhat } from "viem/chains";
import hre from "hardhat";

export async function getClients() {
  const publicClient = await hre.viem.getPublicClient();
  const [owner, user, keeper, treasury, ...rest] = await hre.viem.getWalletClients();
  return { publicClient, owner, user, keeper, treasury, rest };
}
```

---

## helpers/deployments.ts pattern

```typescript
import hre from "hardhat";
import { Address } from "viem";

export async function deployUUPS<T>(contractName: string, initArgs: any[]): Promise<T> {
  const impl = await hre.viem.deployContract(contractName);
  const proxy = await hre.viem.deployContract("ERC1967Proxy", [impl.address, encodeInitData(contractName, initArgs)]);
  return hre.viem.getContractAt(contractName, proxy.address) as Promise<T>;
}
```

---

## fixtures/deployAccountingOnly.ts pattern

```typescript
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { getClients } from "../helpers/viemClients";
import { deployUUPS } from "../helpers/deployments";

export async function accountingFixture() {
  const { owner, user, ...clients } = await getClients();

  const acm = await deployUUPS("AccessControlManager", [owner.account.address]);
  const mockCDO = await hre.viem.deployContract("MockCDO");
  const mockFeed = await hre.viem.deployContract("MockAprPairFeed");

  const accounting = await deployUUPS("Accounting", [
    mockCDO.address,
    mockFeed.address,
    owner.account.address,
    acm.address,
    parseUnits("0.04", 18), // aprTarget = 4%
    parseUnits("0.12", 18), // aprBase = 12%
  ]);

  await mockCDO.write.setAccounting([accounting.address]);

  return { accounting, mockCDO, mockFeed, acm, owner, user, ...clients };
}
```

---

## Per-module test specifications

### 1. PrimeCDO.test.ts — ~22 test cases

```text
describe("PrimeCDO", () => {
  describe("initialization", () => {
    1. Reverts when initialized twice
    2. Sets owner, ACM, and zero-state defaults correctly
    3. Reverts on zero ACM address
  });

  describe("config wiring", () => {
    4. config() wires tranches + accounting + strategy, emits Configured
    5. Reverts when called twice (one-shot)
    6. Reverts on any zero-address arg
    7. Grants Strategy unlimited allowance via Tranche.configure
  });

  describe("kindOf", () => {
    8. Returns JUNIOR / MEZZANINE / SENIOR for wired vaults
    9. Reverts InvalidTranche on unknown address
  });

  describe("totalAssets(tranche)", () => {
    10. Forwards to Accounting.totalAssetsT0() per kind
  });

  describe("coverage gates", () => {
    11. _maxSrDeposit caps at (jr + mz) / (MIN_COVERAGE - 1) - sr
    12. _maxSrDeposit returns 0 when (jr + mz) insufficient
    13. _maxWithdraw for SR returns full sr
    14. _maxWithdraw for JR/MZ returns (jr + mz - srFloor)
    15. _maxWithdraw returns 0 when buffer already at floor
    16. maxWithdraw(tranche, owner=silo) bypasses coverage
  });

  describe("reduceReserve", () => {
    17. Drains reserve to treasury, calls Accounting.reduceReserve(amount)
    18. Reverts when not RESERVE_MANAGER_ROLE
    19. Reverts when treasury == address(0)
    20. Reverts when amount > reserve
  });

  describe("pause states", () => {
    21. setActionStates per tranche pauses deposit/withdraw independently
    22. Reverts when not PAUSER_ROLE
  });
});
```

---

### 2. Accounting.test.ts — ~30 test cases (CRITICAL — 100% branch)

```text
describe("Accounting", () => {
  describe("initialization", () => {
    1. Sets aprTarget, aprBase, defaults reserveBps=5%, alphas, riskParams
    2. srtTargetIndex starts at 1e18
    3. Reverts on zero CDO
  });

  describe("calculateNAVSplit — bootstrap branch", () => {
    4. All tranche NAVs zero + navT1 > 0 → entire navT1 to reserve
  });

  describe("calculateNAVSplit — Case 1 (yield meets target)", () => {
    5. delta enough for Sr target, residual to Jr/Mz alpha-weighted
    6. Reserve cut applied (5% of delta)
    7. Jr+Mz NAV zero falls back to alpha-only split
    8. Invariant navT1 == jr + mz + sr + reserve holds
  });

  describe("calculateNAVSplit — Case 2 (drag)", () => {
    9. delta < srTarget, Jr→Mz cascade funds Sr to target
    10. Jr exhausted first, Mz second
    11. Jr+Mz can't cover full shortfall, Sr receives partial
    12. No Sr impairment (positive period)
  });

  describe("calculateNAVSplit — Case 3 (loss within subordinate)", () => {
    13. loss <= jr → Jr absorbs entirely, Mz/Sr untouched
    14. loss > jr but <= jr+mz → Jr to 0, Mz absorbs remainder
    15. Reserve untouched in all loss paths
  });

  describe("calculateNAVSplit — Case 4 (Sr impairment)", () => {
    16. loss > jr+mz → Sr absorbs remainder, emits SeniorImpaired
    17. loss == jr+mz+sr → all tranches to 0, reserve untouched
    18. loss > jr+mz+sr → reverts LossExceedsNav
  });

  describe("APR pipeline", () => {
    19. _fetchAprs reads feed, updates aprBase + aprTarget
    20. onAprChanged updates aprSrt with risk premium formula
    21. aprSrt = max(aprTarget, aprBase × (1 - riskPremium))
    22. Risk premium = riskX + riskY × srRatio^riskK
    23. srRatio == 1 → max risk, aprBase fully discounted
    24. srRatio == 0 → no risk, aprBase passes through
  });

  describe("Index ratchet", () => {
    25. updateIndex compounds srtTargetIndex by aprSrt × dt / YEAR
    26. Same block (t1==t0) → no-op
    27. Index multiplier always >= 1e18 (non-decreasing)
  });

  describe("Stubs filled (post-update-prompt)", () => {
    28. updateBalanceFlow(6 args) updates tranche tvls + refreshes nav
    29. accrueFee moves assets from tranche bucket to reserve
    30. reduceReserve(amount) drains reserve, drops nav
  });

  describe("Access control", () => {
    31. Non-CDO call to updateAccounting reverts
    32. Setters role-gated correctly
  });
});
```

---

### 3. Tranche.test.ts — ~25 test cases

```text
describe("Tranche", () => {
  describe("initialization", () => {
    1. Sets asset, name, symbol via ERC4626
    2. Wires CDO + Strategy correctly
    3. Sets exitMode default (configured per Tranche)
  });

  describe("deposit (token-routed)", () => {
    4. ERC20-style deposit pulls from user, mints shares
    5. Multi-token: deposits USDai vs sUSDai both work
    6. Reverts on unsupported token
    7. Reverts when paused for deposit
    8. Reverts when amount > maxDeposit (coverage gate)
    9. MIN_SHARES floor enforced (when totalSupply==0, first deposit)
  });

  describe("withdraw (token-routed)", () => {
    10. ERC4626 mode: burns shares, transfers via Strategy
    11. SharesLock mode: locks shares in silo, no immediate transfer
    12. Fee mode: applies exit fee, accrueFee called
    13. Dynamic mode: routes per TRedemptionParams
    14. Standard ERC4626 withdraw(assets, recv, owner) delegates to token-routed
  });

  describe("TRedemptionParams validation", () => {
    15. Mode mismatch → reverts RedemptionParamsMismatch
    16. Fee bps cap enforced (≤ MAX_EXIT_FEE = 10%)
  });

  describe("MIN_SHARES guard", () => {
    17. Withdraw leaving totalSupply between 0 and MIN_SHARES → reverts MinSharesViolation
    18. Withdraw leaving totalSupply == 0 → allowed
    19. burnSharesAsFee also enforces MIN_SHARES
  });

  describe("Preview / max views", () => {
    20. previewWithdraw fee-aware (includes exit fee)
    21. previewRedeem fee-aware
    22. maxDeposit/maxWithdraw forward to CDO
    23. quoteWithdraw / quoteRedeem return token amounts
  });

  describe("Events", () => {
    24. OnExit fires with mode metadata on withdraw
    25. ERC4626 standard events (Deposit, Withdraw) emitted
  });
});
```

---

### 4. USDAStrategy.test.ts — ~18 test cases

```text
describe("USDAStrategy", () => {
  describe("initialization", () => {
    1. Sets sUSDai + USDai + erc20Cooldown immutables in constructor
    2. Initialize approves silo unlimited for sUSDai
    3. Reverts on zero CDO
  });

  describe("deposit", () => {
    4. USDai deposit auto-stakes to sUSDai
    5. sUSDai deposit held directly (no stake)
    6. Pulls from Tranche (NOT user) — Pattern B/3
    7. Reverts on unsupported token (e.g. random ERC20)
    8. Reverts when not called by CDO
  });

  describe("withdraw", () => {
    9. sUSDai withdraw routes through ERC20Cooldown silo
    10. Cooldown=0 → silo short-circuits to direct transfer
    11. Cooldown>0 → silo holds, user finalizes later
    12. withdrawByAssets converts via previewWithdraw
    13. USDai withdraw reverts UnsupportedToken (sUSDai-only)
  });

  describe("reduceReserve", () => {
    14. Transfers sUSDai directly to treasury (bypass silo)
    15. Reverts on treasury == address(0)
  });

  describe("views", () => {
    16. totalAssets returns sUSDai.previewRedeem(balance)
    17. convertToAssets / convertToTokens correct for both tokens
    18. getSupportedTokens returns [USDai, sUSDai]
  });

  describe("admin", () => {
    19. setCooldowns role-gated, max 7 days per tranche
    20. setCooldowns(0,0,0) toggles silo cooldownDisabled = true
    21. setCooldowns(>7 days) reverts CooldownTooLong
  });
});
```

---

### 5. AaveAprPairProvider.test.ts — ~22 test cases

```text
describe("AaveAprPairProvider", () => {
  describe("initialization", () => {
    1. Sets aavePool, sUSDai, benchmarkTokens
    2. Reverts on zero aavePool / sUSDai
    3. Reverts on empty benchmark list
  });

  describe("getAPRtarget — happy path", () => {
    4. Weighted avg across 2 markets (USDC, USDT) computed correctly
    5. Single benchmark (just USDC) returns USDC's APR directly
    6. RAY → 12-dec conversion accurate (test with known RAY values)
  });

  describe("getAPRtarget — bounds + reverts", () => {
    7. aprAvg > BOUND_MAX (0.4e12) → reverts InvalidAprAvg(value)
    8. aprAvg below BOUND_MIN doesn't apply (BOUND_MIN=0)
    9. totalWeight == 0 → reverts InvalidAprAvg(0)
    10. Empty benchmarks → reverts EmptyBenchmark
    11. Invalid Aave reserve (aTokenAddress=0) → reverts InvalidAaveReserve
  });

  describe("getAPRbase — sUSDai vesting", () => {
    12. Active vesting window returns proportional APR
    13. elapsed >= VESTING_PERIOD (8h) → returns 0
    14. unvestedAmount == 0 → returns 0
    15. totalAssets == 0 → returns 0 (division guard)
    16. lastDistributionTimestamp > block.timestamp (drift) → returns 0
    17. Extreme apr (huge unvested) clamped at 2e12 (200%)
  });

  describe("getApr — 3-tuple", () => {
    18. Returns (aprBase, aprTarget, updatedAt) with current block timestamp
    19. Both values within int64 range
  });

  describe("admin", () => {
    20. setBenchmarkTokens role-gated UPDATER_STRAT_CONFIG_ROLE
    21. setBenchmarkTokens rejects duplicates (DuplicateBenchmark)
    22. setBenchmarkTokens rejects > MAX_BENCHMARK_TOKENS (8)
    23. setBenchmarkTokens rejects zero address + invalid reserve
  });
});
```

---

### 6. AprPairFeed.test.ts — ~18 test cases

```text
describe("AprPairFeed", () => {
  describe("PUSH path", () => {
    1. updateRoundData(aprBase, aprTarget, ts) stores round + emits AnswerUpdated
    2. Reverts on stale timestamp (older than roundStaleAfter)
    3. Reverts on future timestamp beyond MAX_FUTURE_DRIFT
    4. Reverts on out-of-order timestamp (t <= latestRound.updatedAt)
    5. Reverts on APR outside [-50%, +200%] bounds
    6. Sets sourcePref = Feed after PUSH
  });

  describe("PULL path", () => {
    7. updateRoundData() reads provider.getApr(), stores round
    8. Sets sourcePref = Strategy after PULL
  });

  describe("latestRoundData — fresh PUSH", () => {
    9. Returns stored round when dt < roundStaleAfter
    10. Future-dated round (clock skew) returned without underflow
  });

  describe("latestRoundData — stale fallback to PULL", () => {
    11. PUSH stale → falls back to provider.getApr()
    12. PUSH never pushed (updatedAt=0) → falls back to PULL
    13. Provider returns 0 base → ok, returned as-is
  });

  describe("Ring buffer", () => {
    14. Stores last 20 rounds, wraps after rolling
    15. getRoundData by id returns correct round
    16. getRoundData on overwritten id → reverts OldRound
    17. getRoundData on never-written id → reverts NoDataPresent
  });

  describe("admin", () => {
    18. setProvider validates new provider's getApr returns valid APRs
    19. setRoundStaleAfter owner-only
    20. Role gating UPDATER_FEED_ROLE on updateRoundData
  });
});
```

---

### 7. AccessControlManager.test.ts — ~12 test cases

```text
describe("AccessControlManager", () => {
  describe("initialization", () => {
    1. Sets owner as default admin
    2. UUPS proxy upgradeable
  });

  describe("role grant/revoke", () => {
    3. grantRole(role, addr) sets hasRole=true, emits RoleGranted
    4. revokeRole removes hasRole, emits RoleRevoked
    5. Non-owner calls revert (admin role check)
    6. grantRole to zero address reverts
  });

  describe("call-based ACL", () => {
    7. grantCall(target, selector, addr) sets isAllowedToCall=true
    8. revokeCall removes permission
    9. hasPermission returns true if role OR call grants access
  });

  describe("upgrade", () => {
    10. upgradeToAndCall callable by owner only
    11. Non-owner upgrade reverts
    12. Storage preserved across upgrades (test with mock V2)
  });
});
```

---

### 8. ERC20Cooldown.test.ts — ~15 test cases

```text
describe("ERC20Cooldown", () => {
  describe("zero-cooldown short-circuit", () => {
    1. cooldown=0 → direct safeTransferFrom, no slot allocated
    2. cooldownDisabled=true → forces short-circuit regardless of arg
    3. emits Finalized in short-circuit path
  });

  describe("delayed cooldown", () => {
    4. cooldown>0 → allocates slot, holds tokens
    5. emits Pending(slot, ...)
    6. finalize before cooldown elapsed → reverts NotMatured
    7. finalize after cooldown elapsed → transfers to receiver
  });

  describe("setCooldownDisabled", () => {
    8. Per-token flag, role-gated COOLDOWN_WORKER_ROLE
    9. Toggling true → all subsequent transfers short-circuit
  });

  describe("access control", () => {
    10. transfer requires COOLDOWN_WORKER_ROLE
    11. setCooldownDisabled requires COOLDOWN_WORKER_ROLE
  });

  describe("edge cases", () => {
    12. amount=0 → no-op (or reverts ZeroAmount — pick one and test)
    13. Receiver=address(0) → reverts ZeroAddress
    14. Slot reuse: finalize frees slot, next transfer reuses
    15. Reentrancy via callback in receiver → reverts ReentrancyGuard
  });
});
```

---

### 9. SharesCooldown.test.ts — ~20 test cases

```text
describe("SharesCooldown", () => {
  describe("requestRedeem", () => {
    1. Burns user shares, allocates slot, holds shares as silo
    2. Per-vault TExitUpperBounds 3-range logic (r0/r1/r2)
    3. Coverage range 0 (healthy) → no fee, normal cooldown
    4. Coverage range 1 (warning) → partial fee + cooldown
    5. Coverage range 2 (critical) → max fee + max cooldown
    6. Slot 70 reached → merge into last slot
    7. Slot 40 reached + external receiver → reverts PublicSlotsExhausted
  });

  describe("finalize", () => {
    8. After cooldown elapsed, transfers shares to user
    9. Before cooldown → reverts NotMatured
    10. Fee applied per request's stored feeBps
  });

  describe("finalizeWithFee proportional", () => {
    11. Fee scales with remaining cooldown time
    12. Capped at 1%/day
  });

  describe("cancel", () => {
    13. Cancel before cooldown returns full shares (no fee)
    14. Cancel after cooldown? (depends on policy — test current behavior)
    15. Cancel by non-owner reverts
  });

  describe("admin", () => {
    16. setExitUpperBounds validates range monotonicity
    17. Reverts on r2 > 1e18 or p1 > p0
    18. Role-gated COOLDOWN_WORKER_ROLE
  });

  describe("integration with CDO", () => {
    19. CDO.sharesCooldown == silo address
    20. Coverage view excludes silo-held shares (totalAssetsUnlocked fix)
  });
});
```

---

### 10. CooldownBase.test.ts — ~8 test cases (via mock)

Tests the abstract base behavior shared by ERC20Cooldown + SharesCooldown.

```text
describe("CooldownBase", () => {
  1. Slot allocation: sequential IDs
  2. Slot status tracking (Pending / Matured / Finalized)
  3. Time-based maturity check
  4. Storage layout preserved through upgrade
  5. Events: Pending, Finalized
  6. Free slot lookup
  7. Active slots count tracking
  8. Reentrancy guard on finalize
});
```

---

### 11. Strategy abstract test (via MockStrategy.test.ts) — ~6 test cases

```text
describe("Strategy abstract", () => {
  1. onlyCDO modifier blocks non-CDO callers
  2. CDOComponent inheritance: cdo storage settable in initialize
  3. AccessControlled inheritance: role modifiers work
  4. ReentrancyGuard initialized
  5. Strategy is abstract (cannot deploy directly)
  6. configure() callable by CDO, approves silo
});
```

---

### 12. AccessControlled.test.ts — ~6 test cases (via harness)

```text
describe("AccessControlled", () => {
  1. onlyOwner modifier
  2. onlyRole modifier checks ACM
  3. onlyAllowedToCall modifier checks call-based ACL
  4. _disableInitializers called in constructor
  5. AccessControlled_init initializes ReentrancyGuard
  6. ZeroAddress error declared
});
```

---

## Mock contracts (under contracts/mocks/)

### MockSUSDai.sol — ERC4626 with vesting

```solidity
contract MockSUSDai is ERC4626Upgradeable {
    uint256 public lastDistributionTimestamp;
    uint256 public vestingAmount;
    uint256 private _unvestedAmount;

    function setVesting(uint256 unvested, uint256 timestamp) external {
        _unvestedAmount = unvested;
        lastDistributionTimestamp = timestamp;
    }

    function getUnvestedAmount() external view returns (uint256) {
        return _unvestedAmount;
    }

    function totalAssets() public view override returns (uint256) {
        return super.totalAssets() - _unvestedAmount;  // matches USD.AI convention
    }
}
```

### MockAavePool.sol — configurable getReserveData

```solidity
contract MockAavePool {
    mapping(address => IAavePool.ReserveData) public reserves;

    function setReserve(
        address asset,
        uint128 currentLiquidityRate,
        address aTokenAddress
    ) external {
        reserves[asset].currentLiquidityRate = currentLiquidityRate;
        reserves[asset].aTokenAddress = aTokenAddress;
    }

    function getReserveData(address asset) external view returns (IAavePool.ReserveData memory) {
        return reserves[asset];
    }
}
```

### MockAprPairFeed.sol — feed stub

```solidity
contract MockAprPairFeed is IAprPairFeed {
    TRound public latestRound;

    function setLatestRound(int64 aprBase, int64 aprTarget, uint64 ts) external {
        latestRound = TRound(aprBase, aprTarget, ts, 1);
    }

    function latestRoundData() external view returns (TRound memory) {
        return latestRound;
    }
    // ... other interface methods stubbed
}
```

---

## Sample test file — Accounting.test.ts skeleton

```typescript
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, getAddress } from "viem";
import { accountingFixture } from "../../fixtures/deployAccountingOnly";

describe("Accounting", () => {
  describe("calculateNAVSplit — Case 3 (loss in subordinate)", () => {
    it("Jr absorbs loss when loss <= jr", async () => {
      const { accounting } = await loadFixture(accountingFixture);

      const navT0 = parseUnits("450", 18); // 100 jr + 300 mz + 50 sr
      const jrtNavT0 = parseUnits("100", 18);
      const mzNavT0 = parseUnits("300", 18);
      const srtNavT0 = parseUnits("50", 18);
      const reserveNavT0 = 0n;
      const navT1 = parseUnits("400", 18); // loss of 50

      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit([
        navT0,
        jrtNavT0,
        mzNavT0,
        srtNavT0,
        reserveNavT0,
        navT1,
      ]);

      expect(jr).to.equal(parseUnits("50", 18)); // Jr absorbed 50
      expect(mz).to.equal(parseUnits("300", 18)); // Mz untouched
      expect(sr).to.equal(parseUnits("50", 18)); // Sr untouched
      expect(reserve).to.equal(0n);
    });

    it("Jr→Mz cascade when loss > jr", async () => {
      // ... similar pattern, loss=200, expect jr=0, mz=200
    });
  });

  describe("calculateNAVSplit — Case 4 (impairment)", () => {
    it("emits SeniorImpaired when loss reaches Sr", async () => {
      const { accounting, mockCDO, publicClient } = await loadFixture(accountingFixture);

      // Set initial state via mockCDO admin path
      await mockCDO.write.bumpAccounting([
        parseUnits("450", 18), // navT0
        parseUnits("100", 18), // jr
        parseUnits("300", 18), // mz
        parseUnits("50", 18), // sr
      ]);

      // Trigger update with catastrophic navT1
      const hash = await mockCDO.write.callUpdateAccounting([parseUnits("100", 18)]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const events = await accounting.getEvents.SeniorImpaired();
      expect(events).to.have.lengthOf(1);
      expect(events[0].args.lossToSenior).to.equal(parseUnits("0", 18));
      // ... assertions
    });
  });
});
```

---

## Coverage configuration

`.solcover.js`:

```javascript
module.exports = {
  skipFiles: ["mocks/", "interfaces/"],
  configureYulOptimizer: true,
  istanbulFolder: "./coverage",
};
```

`package.json` scripts:

```json
{
  "scripts": {
    "test": "hardhat test",
    "test:coverage": "hardhat coverage --solcoverjs ./.solcover.js",
    "test:gas": "REPORT_GAS=true hardhat test"
  }
}
```

CI gate (GitHub Actions example):

```yaml
- name: Test with coverage
  run: pnpm test:coverage
- name: Verify thresholds
  run: |
    LINE=$(jq '.total.lines.pct' coverage/coverage-summary.json)
    BRANCH=$(jq '.total.branches.pct' coverage/coverage-summary.json)
    FUNC=$(jq '.total.functions.pct' coverage/coverage-summary.json)
    [ $(echo "$LINE >= 95" | bc) -eq 1 ] || exit 1
    [ $(echo "$BRANCH >= 90" | bc) -eq 1 ] || exit 1
    [ $(echo "$FUNC >= 100" | bc) -eq 1 ] || exit 1
```

---

## Critical paths — must hit 100% branch coverage

These are economic safety boundaries; any uncovered branch is a deployment blocker.

| File                | Function                          | Why critical                      |
| ------------------- | --------------------------------- | --------------------------------- |
| Accounting          | `calculateNAVSplit` (all 4 cases) | Wrong split = lost user funds     |
| Accounting          | `_applyWaterfall`                 | Loss cascade correctness          |
| Accounting          | `_applyWaterfallNoSr`             | Case 2 funding correctness        |
| Accounting          | `_updateAprSrt`                   | Sr APR floor enforcement          |
| PrimeCDO            | `_maxSrDeposit`                   | Coverage gate enforcement         |
| PrimeCDO            | `_maxWithdraw`                    | Coverage gate enforcement         |
| Tranche             | `_withdraw` (mode routing)        | Exit fee + share burn correctness |
| Tranche             | `_validateRedemptionParams`       | User-side slippage guard          |
| Tranche             | `_onAfterWithdrawalChecks`        | MIN_SHARES enforcement            |
| USDAStrategy        | `deposit` / `withdraw`            | Token flow correctness            |
| ERC20Cooldown       | `transfer` (both branches)        | Withdraw routing                  |
| AaveAprPairProvider | `getAPRtarget`                    | Sr floor source                   |

For these, write explicit tests for EVERY if/else branch including revert paths.

---

## Goals

- Each module has a `.test.ts` file under `test/unit/<area>/`.
- Mocks under `contracts/mocks/` isolate the unit under test.
- `loadFixture` makes setup fast (snapshots between tests).
- viem types provide compile-time safety on contract calls.
- Coverage report meets 95/90/100 thresholds.
- Critical paths hit 100% branch coverage.
- CI gate blocks PRs that drop coverage.

---

## Non-goals

- Integration tests (full deposit → updateAccounting → withdraw → reconcile) — spec 19.
- Mainnet fork tests against real USD.AI / Aave — spec 20.
- Fuzz / invariant testing — defer to audit prep.
- Property-based tests — defer.
- Frontend / SDK tests — out of project scope.

---

## Acceptance criteria

- All 12 `.test.ts` files exist with the case counts listed above (±2 cases ok).
- `pnpm test` runs clean (all green) on a fresh checkout.
- `pnpm test:coverage` reports:
  - Line coverage ≥ 95%
  - Branch coverage ≥ 90%
  - Function coverage = 100%
- Critical paths (table above) report 100% branch coverage individually.
- All mocks under `contracts/mocks/` compile but never deployed to mainnet
  (verify by deploy script exclusion).
- CI workflow blocks PRs failing thresholds.
- Test execution time < 2 min on M2 / 4-core CI machine.

---

## Check when done

- Build clean: `pnpm build`.
- Tests clean: `pnpm test`.
- Coverage clean: `pnpm test:coverage` meets thresholds.
- `progress-tracker.md` updated:
  - Step 18 ticked complete.
  - Coverage report committed to `coverage/` folder.
  - Critical-path coverage table committed for audit reference.
- Open questions:
  - Whether to add fuzz tests for `calculateNAVSplit` (random NAV inputs) before audit.
  - Whether to add scenario tests for cross-contract event ordering (e.g. accrueFee → updateBalanceFlow sequence).
  - Whether to add gas snapshots to track regression.
- Next: spec 19 (integration tests), spec 20 (fork tests), then audit.

---

## Total test case count

| Module               | Cases   |
| -------------------- | ------- |
| PrimeCDO             | 22      |
| Accounting           | 32      |
| Tranche              | 25      |
| USDAStrategy         | 21      |
| AaveAprPairProvider  | 23      |
| AprPairFeed          | 20      |
| AccessControlManager | 12      |
| ERC20Cooldown        | 15      |
| SharesCooldown       | 20      |
| CooldownBase         | 8       |
| Strategy abstract    | 6       |
| AccessControlled     | 6       |
| **Total**            | **210** |

Estimated implementation time: **40-60 hours** Claude Code work (or
20-30 hours with team of 2).
