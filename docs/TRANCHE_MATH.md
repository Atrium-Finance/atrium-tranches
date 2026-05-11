# PrimeVaults V2 — Tranche Math Reference

All formulas used in the PrimeVaults protocol, mapped to their Solidity implementation.
All values use **18-decimal fixed-point** (1e18 = 1.0) unless noted otherwise.

> **2-tranche protocol** — Senior (principal-protected) + Junior (loss absorber).
> Strata Protocol design: 1 CDO = 1 Strategy.

---

## Table of Contents

1. [Notation](#1-notation)
2. [Share Price & ERC-4626](#2-share-price--erc-4626)
3. [Coverage Ratio](#3-coverage-ratio)
4. [Coverage Gate (Deposit Blocking)](#4-coverage-gate)
5. [Risk Premium Curve (RP1)](#5-risk-premium-curve)
6. [APY Computation Chain](#6-apy-computation-chain)
7. [Gain Splitting](#7-gain-splitting)
8. [Loss Waterfall (3-Layer + Senior Principal Protection)](#8-loss-waterfall)
9. [Withdrawal Fees](#9-withdrawal-fees)
10. [Cooldown Mechanism Selection](#10-cooldown-mechanism-selection)
11. [SHARES_LOCK Claim Math (with Snapshot Cap)](#11-shares_lock-claim-math)
12. [Manual Shortfall Pause](#12-manual-shortfall-pause)
13. [Deposit Base-Equivalent Conversion](#13-deposit-base-equivalent-conversion)
14. [Governance Parameter Bounds](#14-governance-parameter-bounds)
15. [Worked Examples](#15-worked-examples)

---

## 1. Notation

| Symbol | Description | Solidity |
|--------|-------------|----------|
| `Sr` | Senior TVL (base asset) | `s_seniorTVL` |
| `Jr` | Junior TVL (base asset) | `s_juniorBaseTVL` |
| `SrP` | Senior principal (net Senior deposits) | `s_seniorPrincipal` |
| `SrY` | Senior accrued yield = `Sr - SrP` | (derived) |
| `Res` | Reserve TVL (accumulated fees + gain cut) | `s_reserveTVL` |
| `Pool` | Total tranche TVL = Sr + Jr | — |
| `cs` | Senior coverage ratio | `_getCoverageSenior()` |
| `RP1` | Senior risk premium (yield discount) | `_computeRP1()` |
| `aprBase` | Strategy APR (sUSDai growth) | `AprPairFeed.aprBase` |
| `aprTargetSenior` | Aave benchmark APR (Senior floor) | `AprPairFeed.aprTargetSenior` |
| `APY_sr` | Senior APY | `_computeSeniorAPY()` |
| `APY_jr` | Junior APY | `_computeJuniorAPY()` |
| `deltaT` | Seconds since last accounting update | `block.timestamp - s_lastUpdateTimestamp` |
| `YEAR` | 365 days in seconds = 31,536,000 | `365 days` |

> APR feed values are **int64 × 12-decimal** (1% = 1e10). Accounting upscales to 18-decimal internally.

---

## 2. Share Price & ERC-4626

Each tranche vault is ERC-4626. Share price comes from Accounting, NOT token balances.

### Total Assets

```
totalAssets(tranche) = totalSupply > 0 ? Accounting.getTrancheTVL(tranche) : 0
```

> Returns 0 when no shares exist to prevent share inflation from dust TVL residuals.

**Contract:** `TrancheVault.totalAssets()` (line 87)

### Share Price

```
sharePrice = totalAssets / totalSupply
```

When `totalSupply = 0`: `sharePrice = 1.0` (ERC-4626 default).

### Deposit → Shares

```
shares = amount * totalSupply / totalAssets        (standard ERC-4626)
```

First deposit (`totalSupply = 0`): `shares = amount` (1:1).

**Invariant:** `sharePrice_before == sharePrice_after` for every deposit.

### baseAmount Recompute (Audit H#1 Fix)

`PrimeCDO.requestWithdraw` recomputes `baseAmount` from live `vaultShares` **after** `_updateAccounting()` runs, defeating stale-snapshot drain when the loss waterfall fires in-call:

```
baseAmount = vaultShares >= totalSupply
    ? freshTVL
    : (vaultShares × freshTVL) / totalSupply
```

**Contract:** `PrimeCDO._quoteBaseAmount()`, called inside `PrimeCDO.requestWithdraw()` (line 237).

---

## 3. Coverage Ratio

Coverage measures how much subordinated capital protects Senior.

### Senior Coverage (cs)

```
cs = (Sr + Jr) / Sr
```

If `Sr = 0`: `cs = MAX_UINT256` (infinite — allow first deposit).

**Contract:** `PrimeCDO._getCoverageSenior()` (line 510)

**Interpretation:** `cs = 2.0` means for every $1 of Senior there's $1 of Junior subordination (50% buffer). `cs = 1.0` means zero buffer.

---

## 4. Coverage Gate

Blocks Senior deposits when coverage is too low. Junior deposits are never blocked (they increase coverage).

```
Senior deposit: requires cs >= minCoverageForDeposit    (default 1.05e18 = 105%)
Junior deposit: always allowed
```

**Contract:** `PrimeCDO.deposit()` (line 173)

---

## 5. Risk Premium Curve

Single premium curve `RP1` determines how much yield Senior sacrifices for protection.

### RP1 — Senior Risk Premium

```
ratio_sr = Sr / (Sr + Jr)
RP1 = x + y × ratio_sr^k
```

| Parameter | Default | Bound |
|-----------|---------|-------|
| x | 0.10 (10%) | ≤ 0.30 |
| y | 0.125 (12.5%) | x + y ≤ 0.80 |
| k | 0.3 | — |

**Contract:** `Accounting._computeRP1()` (line 361), `RiskParams.s_seniorPremium`

**Behavior:** As Senior grows relative to the pool → `ratio_sr` increases → RP1 increases → Senior gets less yield (pays more for protection).

### Fixed-Point Power

```
fpow(base, exp) = PRBMath.UD60x18.pow(base, exp)
```

**Contract:** `FixedPointMath.fpow()` — delegates to `@prb/math`

---

## 6. APY Computation Chain

APY flows: aprBase / aprTargetSenior → Senior → Junior (residual with leverage).

### Step 1: APR Feed Inputs

```
aprBase          = strategyAPR    (sUSDai exchange-rate growth from snapshots)
aprTargetSenior  = Aave benchmark (aToken-supply-weighted avg lending rate)
```

Both read via `AprPairFeed.latestRoundData()`. Returned as **int64 × 12-decimal**, upscaled by `1e6` to 18-decimal inside Accounting.

### Step 2: Senior APY

```
APY_sr = MAX(aprTargetSenior, aprBase × (1 - RP1))
```

Floor = Aave benchmark. Senior never earns less than the benchmark (subject to liquidity).

**Contract:** `Accounting._computeSeniorAPY()` (line 403)

### Step 3: Junior APY (Residual)

Junior takes the entire sub-pool — there is no Mezzanine layer.

```
leverage = Sr / Jr        (if Jr > 0, else APY_jr = 0)

If aprBase >= APY_sr:                                       [normal: surplus]
    APY_jr = aprBase + (aprBase - APY_sr) × leverage

Else:                                                       [floor active: deficit]
    deficit = (APY_sr - aprBase) × leverage
    APY_jr = aprBase >= deficit ? aprBase - deficit : 0     [clamped to 0]
```

**Contract:** `Accounting._computeJuniorAPY()` (line 420)

**Intuition:** Junior gets `aprBase` plus a leveraged share of the surplus Senior didn't take. When the Aave floor exceeds `aprBase`, Senior pulls extra from Junior — Junior's APY can drop to 0 (actual losses then flow through the share price via the waterfall).

---

## 7. Gain Splitting

Called by `updateTVL()` on every deposit/withdraw when `strategy.totalAssets() >= previous accounting total`.

### Step 1: Detect Gain

```
prevTotal = Sr + Jr + Res
gain = strategy.totalAssets() - prevTotal
```

If `gain = 0` or `deltaT = 0`: skip.

**Contract:** `Accounting.updateTVL()` (line 140)

### Step 2: Reserve Cut

```
reserveCut = gain × reserveBps / 10,000
netGain    = gain - reserveCut
Res       += reserveCut
```

Default `reserveBps = 500` (5%).

**Contract:** `Accounting._splitGain()` (line 260)

### Step 3: Senior Target Gain

```
seniorTarget   = Sr × APY_sr × deltaT / YEAR
Sr            += seniorTarget          (yield-tier — does NOT increase SrP)

interestFactor = APY_sr × deltaT / YEAR
srtTargetIndex = srtTargetIndex × (1 + interestFactor)
```

**Contract:** `Accounting._splitGain()` (line 260)

### Step 4: Junior Residual or Deficit

```
If netGain >= seniorTarget:
    juniorGain = netGain - seniorTarget
    Jr        += juniorGain                          [CASE A: surplus]
Else:
    deficit    = seniorTarget - netGain              [CASE C: shortfall]
    applyLossWaterfall(deficit)                      [Junior absorbs first]
```

**Contract:** `Accounting._splitGain()` (line 260)

**Key invariant:** Senior always receives its full target gain. Any shortfall flows through the loss waterfall.

---

## 8. Loss Waterfall

Applied when `strategy.totalAssets() < previous accounting total`, or when gain splitting has a deficit. **Three layers**, with Senior split into yield-tier (consumable) and principal-tier (last resort).

```
remaining = loss
SrY = Sr > SrP ? Sr - SrP : 0       // Senior accrued yield

// Layer 1: Junior absorbs first
jrAbsorbed   = MIN(remaining, Jr)
Jr          -= jrAbsorbed
remaining   -= jrAbsorbed

// Layer 2: Senior yield-tier
srYAbsorbed  = MIN(remaining, SrY)
Sr          -= srYAbsorbed
remaining   -= srYAbsorbed

// Layer 3: Senior principal-tier (LAST RESORT)
srPAbsorbed  = MIN(remaining, SrP)
Sr          -= srPAbsorbed
SrP         -= srPAbsorbed
emit SeniorPrincipalAbsorbed(srPAbsorbed)
```

**Contract:** `Accounting._applyLossWaterfall()` (line 304)

### Senior Principal Tracking (`s_seniorPrincipal`)

`SrP` tracks net Senior deposits and is preserved as long as possible:

| Operation | Effect on `SrP` |
|-----------|----------------|
| `recordDeposit(SENIOR, x)` | `SrP += x` (line 172) |
| `recordWithdraw(SENIOR, x)` / `recordFee(SENIOR, x)` | `SrP` scales pro-rata: `SrP × newSr / oldSr` |
| `recordDeposit(JUNIOR, x)` | no change (Junior never tracked) |
| Senior gain split (Step 3 above) | no change — Senior gain credits to `Sr` only |
| Layer 3 waterfall | `SrP` decremented and `SeniorPrincipalAbsorbed` emitted |

**Contract:** `Accounting._scaleSeniorPrincipal()` (line 334)

**Invariant:** `SrP ≤ Sr` at all times. While `Jr + SrY` can cover a loss, `SrP` is preserved verbatim — Senior's deposit value is locked in.

### Why Junior APY Returns 0 (Not Negative)

`_computeJuniorAPY` floors at 0 even when the Aave-floor deficit would imply a negative number. Actual Junior losses are not surfaced through APY — they are reflected through the **share price** (`Jr / Jr_totalSupply`) after the waterfall has trimmed `Jr`.

---

## 9. Withdrawal Fees

Fees are deducted from the withdrawal base amount and moved to reserve.

```
feeAmount   = baseAmount × feeBps / 10,000
netAmount   = baseAmount - feeAmount
trancheTVL -= feeAmount     (via recordFee, scales SrP pro-rata if Senior)
Res        += feeAmount
```

**Default fee schedule:**

| Tranche | NONE (instant) | ASSETS_LOCK | SHARES_LOCK |
|---------|----------------|-------------|-------------|
| Senior  | 0 bps | 0 bps | 0 bps |
| Junior  | 0 bps | 20 bps (0.2%) | 100 bps (1.0%) |

Max fee per mechanism: 1,000 bps (10%).

**Contract:** `PrimeCDO.requestWithdraw()` (line 237), `RedemptionPolicy.MechanismConfig`

---

## 10. Cooldown Mechanism Selection

RedemptionPolicy selects the mechanism based on live Senior coverage `cs`.

### Senior — Always Instant

```
Senior → NONE (always, regardless of coverage)
```

### Junior — Single-Dimensional (cs only)

```
If cs >  instantCs    (default 1.60):  NONE          (instant)
If cs >  assetLockCs  (default 1.40):  ASSETS_LOCK   (lock sUSDai, 3 days default)
If cs <= assetLockCs:                  SHARES_LOCK   (escrow shares, 7 days default)
```

**Contract:** `RedemptionPolicy._evaluateJuniorMechanism()` (line 173), `RedemptionPolicy.s_juniorParams`

---

## 11. SHARES_LOCK Claim Math

When SHARES_LOCK expires, shares are converted to base value at the **current** exchange rate (user benefits from yield accrued during cooldown), capped at a maximum growth multiple of the request-time snapshot to defeat rate-pump attacks (Audit M#1).

### At Request Time

```
baseAmountSnapshot = (vaultShares × baseTVL) / totalSupply
fee = baseAmountSnapshot × feeBps / 10_000
recordFee(JUNIOR, fee)                                   // moves fee → reserve
SharesCooldown.request(shares, beneficiary, cdo)         // shares escrowed in CDO

s_sharesLockBaseSnapshot[requestId] = baseAmountSnapshot - fee     // post-fee baseline
```

**Strategy is NOT touched. `totalSupply` is unchanged. Coverage stays stable during cooldown.**

### At Claim Time

```
sharesReturned = SharesCooldown.claim(id)        // shares returned to CDO
_updateAccounting()                              // sync gain/loss

totalSupply    = vault.totalSupply()
baseTVL        = Accounting.getTrancheTVL(JUNIOR)
liveBase       = (sharesReturned × baseTVL) / totalSupply

snapshot       = s_sharesLockBaseSnapshot[id]
maxAllowed     = snapshot + snapshot × s_maxClaimGrowthBps / 10_000
baseAmount     = MIN(liveBase, maxAllowed)       // M#1 cap

Accounting.recordWithdraw(JUNIOR, baseAmount)
strategy.withdraw(baseAmount) → sUSDai to beneficiary
vault.burnSharesFrom(CDO, sharesReturned)
delete s_sharesLockBaseSnapshot[id]
```

**Contract:** `PrimeCDO.claimSharesWithdraw()` (line 380)

| Parameter | Default | Max |
|-----------|---------|-----|
| `s_maxClaimGrowthBps` | 5_000 (50%) | 10_000 (100%) |

**Properties:**
- During cooldown, `baseTVL` increases via normal yield accrual → user earns yield while waiting (up to the cap).
- An attacker who pumps the exchange rate immediately before claim cannot drain more than `snapshot × (1 + maxGrowthBps/10_000)`.

---

## 12. Manual Shortfall Pause

> **Audit L#5 fix:** Automatic Junior shortfall auto-pause was removed (it was weaponizable as a DoS by anyone who could push Junior PPS below threshold). Emergency pause is now **manual, guardian-only**.

```
triggerShortfallPause()    onlyGuardian   → s_shortfallPaused = true
unpauseShortfall()         onlyOwnerOrGuardian → s_shortfallPaused = false
```

While `s_shortfallPaused == true`: all `deposit` and `requestWithdraw` calls revert with `PrimeVaults__ShortfallPaused`.

**Contract:** `PrimeCDO.triggerShortfallPause()` (line 465), `PrimeCDO.unpauseShortfall()`.

There is **no automatic trigger** based on Junior share price. Off-chain monitoring (or governance) is expected to decide when to pause.

---

## 13. Deposit Base-Equivalent Conversion

Deposits can be base asset (USD.AI) or output token (sUSDai). Shares are always minted based on base-equivalent value.

### Base Asset (USD.AI)

```
baseAmount = amount       (1:1)
shares     = previewDeposit(baseAmount)
```

### Output Token (sUSDai)

```
baseAmount = sUSDai.convertToAssets(amount)     [sUSDai → USD.AI equivalent]
shares     = previewDeposit(baseAmount)
```

**Contract:** `PrimeCDO.deposit()` (line 173), `TrancheVault.depositOutputToken()` (line 148)

> **Audit M#1 (deposit-side, accepted risk):** `convertToAssets` reads sUSDai's live exchange rate with no TWAP/slippage param. Front-running risk exists but sUSDai uses a Spark-style `chi` accumulator that is not directly user-pumpable, so it is documented but not mitigated at the contract level.

---

## 14. Governance Parameter Bounds

| Parameter | Min | Max | Default |
|-----------|-----|-----|---------|
| Senior RP1 `x` | — | 0.30 (30%) | 0.10 (10%) |
| Senior RP1 `x + y` | — | 0.80 (80%) | 0.225 (22.5%) |
| Reserve bps | — | 2,000 (20%) | 500 (5%) |
| Fee bps (per mechanism) | — | 1,000 (10%) | see §9 |
| Min coverage deposit | — | — | 1.05 (105%) |
| `s_maxClaimGrowthBps` (M#1 cap) | — | 10,000 (100%) | 5,000 (50%) |

**Contract:** `RiskParams` (`MAX_SENIOR_X`, `MAX_SENIOR_XY`, `MAX_RESERVE_BPS`), `RedemptionPolicy` (fee + threshold config), `PrimeCDO` (`s_maxClaimGrowthBps`, `s_minCoverageForDeposit`).

> Junior premium / RP2 / shortfall-pause-price parameters were **removed** in the 2-tranche refactor.

---

## 15. Worked Examples

### Example A: Normal Gain Split

**State:** `Sr = 800, Jr = 200`. Pool = 1,000. Strategy yields 50 over period.
Feed: `aprBase = 5%`, `aprTargetSenior = 3%`.

**Step 1 — RP1:**
```
ratio_sr = 800 / 1000 = 0.80
RP1      = 0.10 + 0.125 × 0.80^0.3 = 0.10 + 0.125 × 0.9362 ≈ 0.2170
```

**Step 2 — Senior APY:**
```
APY_sr = MAX(3%, 5% × (1 - 0.2170)) = MAX(3%, 3.915%) = 3.915%
```

**Step 3 — Junior APY:**
```
leverage = 800 / 200 = 4.0
aprBase (5%) >= APY_sr (3.915%) → normal branch
APY_jr   = 5% + (5% - 3.915%) × 4.0 = 5% + 4.34% = 9.34%
```

**Gain distribution (annualized on these APYs, pro-rated by deltaT):**
```
Reserve cut   = 50 × 5%       = 2.50
netGain                       = 47.50

Senior target = 800 × 3.915%  = 31.32   (annualized; pro-rated to deltaT)
Junior residual = netGain − seniorTarget = 47.50 − 31.32 = 16.18
```

**Verify:** `Reserve + Sr_gain + Jr_gain = 2.50 + 31.32 + 16.18 = 50.00 ✓`

---

### Example B: Floor Active + Deficit

**State:** `Sr = 800, Jr = 200, SrP = 800`. Feed: `aprBase = 2%`, `aprTargetSenior = 4%`.

```
RP1      = 0.10 + 0.125 × 0.8^0.3 ≈ 0.2170
APY_sr   = MAX(4%, 2% × 0.7830)  = MAX(4%, 1.566%) = 4%    [floor active]

leverage = 4.0
aprBase (2%) < APY_sr (4%) → floor branch
deficit  = (4% - 2%) × 4.0 = 8%
APY_jr   = 2% < 8% → 0     [clamped]
```

**Gain split with `actual gain = 20` (≈ 2% of 1,000) over the period:**
```
reserveCut    = 20 × 5%      = 1.00
netGain                      = 19.00

seniorTarget  = 800 × 4%     = 32.00   (annualized; assume full year for illustration)
deficit       = 32.00 − 19.00 = 13.00  → applyLossWaterfall(13.00)
```

**Loss waterfall (Layer 1 only — Junior covers):**
```
jrAbsorbed = MIN(13.00, 200) = 13.00
Jr: 200 → 187
SrY (=Sr−SrP=0) untouched, SrP (800) untouched
```

Senior is credited the full 32 target, Junior absorbs the 13 deficit, share price drops on Junior:
```
Junior PPS = 187 / 200 = 0.935    (down from 1.0)
```

---

### Example C: Catastrophic Loss — Senior Principal Touched

**State:** `Sr = 1000, Jr = 100, SrP = 800` (Sr has 200 accrued yield → SrY = 200).
Strategy crashes — loss of 950.

**Waterfall:**
```
Layer 1: Jr absorbs MIN(950, 100) = 100 → Jr = 0, remaining = 850
Layer 2: SrY absorbs MIN(850, 200) = 200 → Sr = 800, remaining = 650
Layer 3: SrP absorbs MIN(650, 800) = 650 → Sr = 150, SrP = 150
         emit SeniorPrincipalAbsorbed(650)
```

**End state:** `Sr = 150, Jr = 0, SrP = 150`. Senior lost 81% of principal; Junior is wiped out first. Without principal-tier separation a naive 2-layer waterfall would have absorbed identical amounts in the same order — the tracking provides observability (`SeniorPrincipalAbsorbed` event + on-chain accountability of how much principal was touched).

---

### Example D: Coverage & Mechanism Selection

**State:** `Sr = 700, Jr = 300`

```
cs = (700 + 300) / 700 = 1.4286 (142.86%)
```

**Senior withdraw:** Always NONE (instant).

**Junior withdraw:**
```
cs = 1.4286 > 1.60? No
cs = 1.4286 > 1.40? Yes → ASSETS_LOCK   (3-day lock on sUSDai)
```

If `Jr` dropped further so `cs ≤ 1.40` (e.g. `Sr = 700, Jr = 200 → cs = 1.286`):
```
cs ≤ 1.40 → SHARES_LOCK   (7-day, shares escrowed, yield accrues, claim capped at +50%)
```

---

### Example E: sUSDai Deposit Conversion

**sUSDai rate:** 1 sUSDai = 1.08 USD.AI. User deposits 100 sUSDai into Senior vault.

```
baseAmount = sUSDai.convertToAssets(100) = 108 USD.AI

// If vault has totalAssets = 1000, totalSupply = 1000 (price = 1.0):
shares     = 108 × 1000 / 1000 = 108

// New state: totalAssets = 1108, totalSupply = 1108, price still 1.0 ✓
// Senior principal increments by 108: SrP_new = SrP_old + 108
```

---

### Example F: Senior Withdraw — Principal Scales Pro-Rata

**State pre-withdraw:** `Sr = 1000, SrP = 800` (yield SrY = 200).
User withdraws baseAmount = 250 (25% of Sr).

```
oldSr = 1000
Accounting.recordWithdraw(SENIOR, 250) → newSr = 750

_scaleSeniorPrincipal(250):
    newPrincipal = 800 × 750 / 1000 = 600
    SrP: 800 → 600         (scales pro-rata)
```

**End state:** `Sr = 750, SrP = 600, SrY = 150`. The 25% of Sr withdrawn carries 25% of the principal-tier and 25% of the yield-tier with it — no free principal extraction or yield strip-mining.

---
