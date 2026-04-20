# PrimeVaults V3 — Tranche Math Reference

All formulas used in the PrimeVaults protocol, mapped to their Solidity implementation.
All values use **18-decimal fixed-point** (1e18 = 1.0) unless noted otherwise.

---

## Table of Contents

1. [Notation](#1-notation)
2. [Share Price & ERC-4626](#2-share-price--erc-4626)
3. [Coverage Ratios](#3-coverage-ratios)
4. [Coverage Gate (Deposit Blocking)](#4-coverage-gate)
5. [Risk Premium Curves (RP1, RP2)](#5-risk-premium-curves)
6. [APY Computation Chain](#6-apy-computation-chain)
7. [Gain Splitting](#7-gain-splitting)
8. [Loss Waterfall](#8-loss-waterfall)
9. [Withdrawal Fees](#9-withdrawal-fees)
10. [Cooldown Mechanism Selection](#10-cooldown-mechanism-selection)
11. [SHARES_LOCK Claim Math](#11-shares_lock-claim-math)
12. [Shortfall Auto-Pause](#12-shortfall-auto-pause)
13. [Deposit Base-Equivalent Conversion](#13-deposit-base-equivalent-conversion)
14. [Governance Parameter Bounds](#14-governance-parameter-bounds)
15. [Worked Examples](#15-worked-examples)

---

## 1. Notation

| Symbol | Description | Solidity |
|--------|-------------|----------|
| `Sr` | Senior TVL (base asset) | `s_seniorTVL` |
| `Mz` | Mezzanine TVL (base asset) | `s_mezzTVL` |
| `Jr` | Junior TVL (base asset) | `s_juniorBaseTVL` |
| `Res` | Reserve TVL (accumulated fees + gain cut) | `s_reserveTVL` |
| `Pool` | Total tranche TVL = Sr + Mz + Jr | — |
| `cs` | Senior coverage ratio | `_getCoverageSenior()` |
| `cm` | Mezzanine coverage ratio | `_getCoverageMezz()` |
| `RP1` | Senior risk premium (yield discount) | `_computeRP1()` |
| `RP2` | Mezz/Junior risk premium | `_computeRP2()` |
| `APY_base` | Strategy base APY (from APR feed) | `_computeBaseAPY()` |
| `APY_aave` | Aave benchmark APY (floor) | `_getAprPair().aprTarget` |
| `APY_sr` | Senior target APY | `_computeSeniorAPY()` |
| `APY_sub` | Sub-pool effective APY | `_computeSubPoolAPY()` |
| `APY_mz` | Mezzanine target APY | `_computeMezzAPY()` |
| `APY_jr` | Junior residual APY | `_computeJuniorAPY()` |
| `deltaT` | Seconds since last accounting update | `block.timestamp - s_lastUpdateTimestamp` |
| `YEAR` | 365 days in seconds = 31,536,000 | `365 days` |

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

### Full Drain Guard

When `shares == totalSupply` (last withdrawal):

```
baseAmount = totalAssets    (not convertToAssets — avoids dust from virtual shares)
```

**Contract:** `TrancheVault.requestWithdraw()` (line 175)

---

## 3. Coverage Ratios

Coverage measures how much subordinated capital protects a tranche.

### Senior Coverage (cs)

```
cs = (Sr + Mz + Jr) / Sr
```

If `Sr = 0`: `cs = MAX_UINT256` (infinite — allow first deposit).

**Contract:** `PrimeCDO._getCoverageSenior()` (line 450)

**Interpretation:** cs = 2.0 means for every $1 of Senior, there's $1 of Mezz+Jr subordination (50% buffer). cs = 1.0 means zero buffer.

### Mezzanine Coverage (cm)

```
cm = (Mz + Jr) / Mz
```

If `Mz = 0`: `cm = MAX_UINT256` (infinite).

**Contract:** `PrimeCDO._getCoverageMezz()` (line 463)

---

## 4. Coverage Gate

Blocks Senior/Mezz deposits when coverage is too low. Junior deposits are never blocked (they increase coverage).

```
Senior deposit: requires cs >= minCoverageForDeposit    (default 1.05e18 = 105%)
Mezz deposit:   requires cm >= minCoverageForDeposit    (default 1.05e18 = 105%)
Junior deposit: always allowed
```

**Contract:** `PrimeCDO.deposit()` (lines 166-173)

---

## 5. Risk Premium Curves

Premium curves determine how much yield Senior/Mezz sacrifice for protection.

### RP1 — Senior Risk Premium

```
ratio_sr = Sr / Pool
RP1 = x₁ + y₁ × ratio_sr^k₁
```

| Parameter | Default | Bound |
|-----------|---------|-------|
| x₁ | 0.10 (10%) | ≤ 0.30 |
| y₁ | 0.125 (12.5%) | x₁ + y₁ ≤ 0.80 |
| k₁ | 0.3 | — |

**Contract:** `Accounting._computeRP1()` (line 330), `RiskParams.s_seniorPremium`

**Behavior:** As Senior grows relative to pool → `ratio_sr` increases → RP1 increases → Senior gets less yield (pays more for protection).

### RP2 — Mezzanine/Junior Risk Premium

```
ratio_mz_sub = Mz / (Mz + Jr)
RP2 = x₂ + y₂ × ratio_mz_sub^k₂
```

| Parameter | Default | Bound |
|-----------|---------|-------|
| x₂ | 0.05 (5%) | — |
| y₂ | 0.10 (10%) | x₂ + y₂ ≤ 0.50 |
| k₂ | 0.5 | — |

**Contract:** `Accounting._computeRP2()` (line 345), `RiskParams.s_juniorPremium`

**Behavior:** As Mezzanine grows relative to sub-pool → RP2 increases → Mezz gets less yield → more goes to Junior.

### Fixed-Point Power

```
fpow(base, exp) = PRBMath.UD60x18.pow(base, exp)
```

**Contract:** `FixedPointMath.fpow()` — delegates to `@prb/math`

---

## 6. APY Computation Chain

APY flows top-down: Base → Senior → Sub-pool → Mezzanine → Junior.

### Step 1: Base APY

```
APY_base = strategyAPR    (from AprPairFeed.latestRoundData().aprBase)
```

**Contract:** `Accounting._computeBaseAPY()` (line 375)

### Step 2: Senior APY

```
APY_sr = MAX(APY_aave, APY_base × (1 - RP1))
```

Floor = Aave weighted-average benchmark. Senior never earns less than Aave.

**Contract:** `Accounting._computeSeniorAPY()` (line 383)

### Step 3: Sub-pool APY

The "sub-pool" is Mezzanine + Junior. It captures the yield Senior didn't take.

```
leverage = Sr / (Mz + Jr)

If APY_base >= APY_sr:
    APY_sub = APY_base + (APY_base - APY_sr) × leverage     [normal: sub-pool boosted]
Else:
    APY_sub = APY_base - (APY_sr - APY_base) × leverage     [floor active: sub-pool pays]
    APY_sub = MAX(0, APY_sub)                                [clamp to 0]
```

**Contract:** `Accounting._computeSubPoolAPY()` (line 399)

**Intuition:** When Senior takes less than base rate (normal), the surplus flows to the sub-pool, amplified by leverage. When Aave floor kicks in and Senior takes more than base rate, the sub-pool pays the premium.

### Step 4: Mezzanine APY

```
APY_mz = MAX(APY_aave, APY_sub × (1 - RP2))
```

Floor = Aave benchmark. Mezzanine never earns less than Aave.

**Contract:** `Accounting._computeMezzAPY()` (line 424)

### Step 5: Junior APY (Residual)

```
mezzLeverage = Mz / Jr

If APY_sub >= APY_mz:
    APY_jr = APY_sub + (APY_sub - APY_mz) × mezzLeverage
Else:
    APY_jr = 0
```

If `Mz = 0`: `APY_jr = APY_sub` (Junior gets full sub-pool).
If `Jr = 0`: `APY_jr = 0`.

**Contract:** `Accounting._computeJuniorAPY()` (line 443)

**Intuition:** Junior gets everything left after Mezzanine takes its cut. Leveraged by how large Mezzanine is relative to Junior.

---

## 7. Gain Splitting

Called by `updateTVL()` on every deposit/withdraw when `strategy.totalAssets() >= previous accounting total`.

### Step 1: Detect Gain

```
prevTotal = Sr + Mz + Jr + Res
gain = strategy.totalAssets() - prevTotal
```

If `gain = 0` or `deltaT = 0`: skip.

**Contract:** `Accounting.updateTVL()` (line 122)

### Step 2: Reserve Cut

```
reserveCut = gain × reserveBps / 10,000
netGain = gain - reserveCut
Res += reserveCut
```

Default `reserveBps = 500` (5%).

**Contract:** `Accounting._splitGain()` (line 238)

### Step 3: Senior Target Gain

```
seniorTarget = Sr × APY_sr × deltaT / YEAR
Sr += seniorTarget

// Compound index update:
interestFactor = APY_sr × deltaT / YEAR
srtTargetIndex = srtTargetIndex × (1 + interestFactor)
```

**Contract:** `Accounting._splitGain()` (lines 244-251)

### Step 4: Mezzanine Target Gain

```
mezzTarget = Mz × APY_mz × deltaT / YEAR
Mz += mezzTarget

// Compound index update:
interestFactor = APY_mz × deltaT / YEAR
mzTargetIndex = mzTargetIndex × (1 + interestFactor)
```

**Contract:** `Accounting._splitGain()` (lines 254-261)

### Step 5: Junior Residual or Deficit

```
totalTarget = seniorTarget + mezzTarget

If netGain >= totalTarget:
    juniorGain = netGain - totalTarget         [CASE A: surplus]
    Jr += juniorGain
Else:
    deficit = totalTarget - netGain            [CASE B: shortfall]
    applyLossWaterfall(deficit)                [Junior absorbs first]
```

**Contract:** `Accounting._splitGain()` (lines 265-281)

**Key insight:** Senior and Mezzanine ALWAYS receive their full target gain, even if actual yield is insufficient. The deficit is pushed to the loss waterfall. This guarantees Senior/Mezz target APY at Junior's expense.

---

## 8. Loss Waterfall

Applied when `strategy.totalAssets() < previous accounting total`, or when gain splitting has a deficit.

```
remaining = loss

// Layer 1: Junior absorbs first
jrAbsorbed = MIN(remaining, Jr)
Jr -= jrAbsorbed
remaining -= jrAbsorbed

// Layer 2: Mezzanine
mzAbsorbed = MIN(remaining, Mz)
Mz -= mzAbsorbed
remaining -= mzAbsorbed

// Layer 3: Senior (last resort)
srAbsorbed = MIN(remaining, Sr)
Sr -= srAbsorbed
```

**Contract:** `Accounting._applyLossWaterfall()` (line 294)

**Priority:** Junior (first loss) → Mezzanine → Senior (last resort).

---

## 9. Withdrawal Fees

Fees are deducted from the withdrawal base amount and moved to reserve.

```
feeAmount = baseAmount × feeBps / 10,000
netAmount = baseAmount - feeAmount
trancheTVL -= feeAmount     (via recordFee)
Res += feeAmount
```

**Default fee schedule:**

| Tranche | NONE (instant) | ASSETS_LOCK | SHARES_LOCK |
|---------|---------------|-------------|-------------|
| Senior  | 0 bps | 0 bps | 0 bps |
| Mezz    | 0 bps | 10 bps (0.1%) | 50 bps (0.5%) |
| Junior  | 0 bps | 20 bps (0.2%) | 100 bps (1.0%) |

Max fee: 1,000 bps (10%).

**Contract:** `PrimeCDO.requestWithdraw()` (lines 220-223), `RedemptionPolicy.MechanismConfig`

---

## 10. Cooldown Mechanism Selection

RedemptionPolicy selects the mechanism based on live coverage ratios.

### Senior — Always Instant

```
Senior → NONE (always, regardless of coverage)
```

### Mezzanine — Single-Dimensional (cs only)

```
If cs > 1.60:  NONE          (instant)
If cs > 1.40:  ASSETS_LOCK   (lock sUSDai, 3 days default)
If cs ≤ 1.40:  SHARES_LOCK   (escrow shares, 7 days default)
```

**Contract:** `RedemptionPolicy._evaluateMezzMechanism()` (line 214)

### Junior — Two-Dimensional (cs AND cm)

Evaluate cs and cm independently, take the **most restrictive** result.

```
cs_mechanism:
  cs > 1.60 → NONE
  cs > 1.40 → ASSETS_LOCK
  cs ≤ 1.40 → SHARES_LOCK

cm_mechanism:
  cm > 1.50 → NONE
  cm > 1.30 → ASSETS_LOCK
  cm ≤ 1.30 → SHARES_LOCK

Junior mechanism = MAX(cs_mechanism, cm_mechanism)
```

Where `SHARES_LOCK > ASSETS_LOCK > NONE`.

**Contract:** `RedemptionPolicy._evaluateJuniorMechanism()` (line 222)

**Example:** cs = 200% (→ NONE) but cm = 125% (→ SHARES_LOCK). Result: SHARES_LOCK.

### Default Thresholds

| Threshold | Mezz (cs only) | Junior cs | Junior cm |
|-----------|---------------|-----------|-----------|
| Instant   | 1.60 (160%) | 1.60 (160%) | 1.50 (150%) |
| Asset Lock | 1.40 (140%) | 1.40 (140%) | 1.30 (130%) |

---

## 11. SHARES_LOCK Claim Math

When SHARES_LOCK expires, shares are converted to base value at the **current** exchange rate (user benefits from yield accrued during cooldown).

### At Request Time

```
fee deducted from trancheTVL → moved to reserve
shares escrowed in SharesCooldown (NOT burned)
strategy NOT touched
totalSupply unchanged → TVL unchanged → coverage stable
```

### At Claim Time

```
sharesReturned = SharesCooldown.claim(id)     [shares go back to CDO]
updateAccounting()                             [sync gain/loss]

totalSupply = vault.totalSupply()
baseTVL = Accounting.getTrancheTVL(tranche)

baseAmount = sharesReturned × baseTVL / totalSupply

Accounting.recordWithdraw(tranche, baseAmount)
strategy.withdraw(baseAmount) → sUSDai to beneficiary
vault.burnSharesFrom(CDO, sharesReturned)
```

**Contract:** `PrimeCDO.claimSharesWithdraw()` (line 342)

**Key property:** During cooldown, `baseTVL` increases (yield accrual), so `baseAmount` at claim time ≥ `baseAmount` at request time. User earns yield while waiting.

---

## 12. Shortfall Auto-Pause

Protocol auto-pauses if Junior share price drops below a threshold.

```
juniorPrice = Jr_TVL × 1e18 / Jr_totalSupply

If juniorPrice < shortfallPausePrice:
    s_shortfallPaused = true
```

Default `shortfallPausePrice = 0.90e18` (90%). Set to 0 to disable.

**Contract:** `PrimeCDO._checkJuniorShortfall()` (line 476)

**When checked:** At the start of every deposit/withdraw, after `updateTVL()` runs.

**Recovery:** `unpauseShortfall()` — callable by owner or guardian.

---

## 13. Deposit Base-Equivalent Conversion

Deposits can be base asset (USDai) or output token (sUSDai). Shares are always minted based on base-equivalent value.

### Base Asset (USDai)

```
baseAmount = amount       (1:1)
shares = previewDeposit(baseAmount)
```

### Output Token (sUSDai)

```
baseAmount = sUSDai.convertToAssets(amount)     [sUSDai → USDai equivalent]
shares = previewDeposit(baseAmount)
```

**Contract:** `PrimeCDO.deposit()` (lines 183-184), `TrancheVault.depositOutputToken()` (line 148)

---

## 14. Governance Parameter Bounds

| Parameter | Min | Max | Default |
|-----------|-----|-----|---------|
| Senior RP1 x | — | 0.30 (30%) | 0.10 (10%) |
| Senior RP1 x+y | — | 0.80 (80%) | 0.225 (22.5%) |
| Junior RP2 x+y | — | 0.50 (50%) | 0.15 (15%) |
| Alpha | 0.40 (40%) | 0.80 (80%) | 0.60 (60%) |
| Reserve bps | — | 2,000 (20%) | 500 (5%) |
| Fee bps (per mechanism) | — | 1,000 (10%) | see §9 |
| Min coverage deposit | — | — | 1.05 (105%) |
| Shortfall pause price | 0 (disabled) | — | 0.90 (90%) |

**Contract:** `RiskParams` (bounds), `RedemptionPolicy` (fee + threshold config)

---

## 15. Worked Examples

### Example A: Normal Gain Split

**State:** Sr = 800, Mz = 100, Jr = 100. Pool = 1,000. Strategy yields 50 over period.
Feed: APY_base = 5%, APY_aave = 3%.

**Step 1 — RP1:**
```
ratio_sr = 800 / 1000 = 0.80
RP1 = 0.10 + 0.125 × 0.80^0.3 = 0.10 + 0.125 × 0.9313 = 0.2164
```

**Step 2 — Senior APY:**
```
APY_sr = MAX(3%, 5% × (1 - 0.2164)) = MAX(3%, 3.918%) = 3.918%
```

**Step 3 — Sub-pool APY:**
```
leverage = 800 / 200 = 4.0
APY_sub = 5% + (5% - 3.918%) × 4.0 = 5% + 4.328% = 9.328%
```

**Step 4 — RP2:**
```
ratio_mz_sub = 100 / 200 = 0.50
RP2 = 0.05 + 0.10 × 0.50^0.5 = 0.05 + 0.0707 = 0.1207
```

**Step 5 — Mezz APY:**
```
APY_mz = MAX(3%, 9.328% × (1 - 0.1207)) = MAX(3%, 8.202%) = 8.202%
```

**Step 6 — Junior APY:**
```
mezzLeverage = 100 / 100 = 1.0
APY_jr = 9.328% + (9.328% - 8.202%) × 1.0 = 10.454%
```

**Gain distribution (annualized on 1,000 at these APYs):**
```
Reserve cut   = 50 × 5%        = 2.50
Senior target = 800 × 3.918%   = 31.34  (per year, pro-rated by deltaT)
Mezz target   = 100 × 8.202%   = 8.20
Junior residual = netGain - Sr - Mz = 47.50 - 31.34 - 8.20 = 7.96
```

**Verify:** Reserve + Sr + Mz + Jr = 2.50 + 31.34 + 8.20 + 7.96 = 50.00 ✓

---

### Example B: Deficit (Floor Active)

**State:** Sr = 800, Mz = 100, Jr = 100. Feed: APY_base = 2%, APY_aave = 4%.

```
APY_sr = MAX(4%, 2% × 0.7836) = MAX(4%, 1.567%) = 4%    [floor active]

leverage = 4.0
APY_sub = 2% - (4% - 2%) × 4.0 = 2% - 8% = -6% → clamped to 0%

APY_mz = MAX(4%, 0%) = 4%    [floor active]
APY_jr = 0%                    [nothing left]
```

**Gain split with actual gain = 20 (2% of 1,000):**
```
Reserve = 20 × 5% = 1.0
netGain = 19.0
Senior target = 800 × 4% = 32.0 (annualized, pro-rated)
Mezz target = 100 × 4% = 4.0

totalTarget = 36.0 > netGain = 19.0 → DEFICIT = 17.0
```

**Loss waterfall (deficit 17.0):**
```
Jr absorbs MIN(17.0, 100) = 17.0
Jr: 100 → 83
```

Junior price drops: `83/100 shares = 0.83` — still above 0.90 pause threshold if the deficit is from a short period.

---

### Example C: Coverage & Mechanism Selection

**State:** Sr = 700, Mz = 100, Jr = 200

```
cs = (700 + 100 + 200) / 700 = 1.4286 (142.86%)
cm = (100 + 200) / 100 = 3.0 (300%)
```

**Senior withdraw:** Always NONE (instant).

**Mezz withdraw:**
```
cs = 1.4286 > instantCs (1.60)? No
cs = 1.4286 > assetLockCs (1.40)? Yes → ASSETS_LOCK
```

**Junior withdraw:**
```
cs: 1.4286 > 1.60? No. > 1.40? Yes → ASSETS_LOCK
cm: 3.0 > 1.50? Yes → NONE
MAX(ASSETS_LOCK, NONE) = ASSETS_LOCK
```

---

### Example D: sUSDai Deposit Conversion

**sUSDai rate:** 1 sUSDai = 1.08 USDai. User deposits 100 sUSDai into Senior vault.

```
baseAmount = sUSDai.convertToAssets(100) = 108 USDai

// If vault has totalAssets=1000, totalSupply=1000 (price=1.0):
shares = 108 × 1000 / 1000 = 108

// New state: totalAssets=1108, totalSupply=1108, price still 1.0 ✓
```
