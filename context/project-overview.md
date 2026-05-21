# Atrium

## Overview

Atrium applies the economic logic of collateralised debt obligations (CDOs) to on-chain yield sources, enabling institutional-grade risk segmentation within a single decentralised protocol. Capital is organised into three tranches — Senior, Mezzanine, and Junior — with explicitly defined priority rules governing yield receipt and loss absorption, creating differentiated risk-return profiles from a common yield source.

A single underlying strategy generates yield. Atrium splits that yield among tranches according to deterministic on-chain rules: Senior receives a target rate first, Mezzanine and Junior share the remainder, and when yield is insufficient, losses flow upward through Junior, then Mezzanine, and only then into Senior principal.

## Goals

1. Provide three ERC-4626 vaults — Senior (Sr), Mezzanine (Mz), and Junior (Jr) — sharing one underlying yield strategy.
2. Enforce deterministic yield splitting where Senior receives its target rate before Mezzanine and Junior.
3. Enforce a strict loss waterfall: Junior absorbs first, then Mezzanine, then Senior.
4. Compute Senior's target APY dynamically from a base APY and a tranche-ratio-weighted risk premium, with a configurable floor.
5. Pay Junior and Mezzanine their share of the residual risk premium via a leverage-weighted split.
6. Support multi-asset deposits per tranche where the underlying strategy allows it.
7. Provide coverage-aware withdrawal mechanics (SharesLock, AssetsLock, fee, cooldown) that adapt to Senior coverage levels.
8. Expose live tranche TVLs, exchange rates, and delivered risk-premium rates for off-chain consumers.

## Core User Flow

1. User deposits a supported asset into one of the three tranche vaults (Senior, Mezzanine, or Junior).
2. The vault forwards the deposit to the CDO orchestrator.
3. CDO calls Accounting to refresh the strategy's total TVL and settle any yield accrued since the previous action.
4. Accounting applies the yield-split rules (or loss waterfall if yield is insufficient) and updates each tranche's TVL.
5. CDO mints tranche shares to the user, priced against the post-update tranche TVL.
6. CDO forwards assets to the Strategy for staking.
7. Over time, every protocol action triggers a new Accounting update: Senior receives its target yield, residual risk premium is split between Mezzanine and Junior, and any shortfall is absorbed upward through Junior, then Mezzanine, then Senior.
8. The APR Feed pushes updated base and benchmark APYs into Accounting, which recalculates Senior's target index without retroactively changing past periods.
9. User requests redemption from their tranche vault.
10. CDO settles Accounting up to the current block and determines the redemption path — instant return, AssetsLock, SharesLock, or fee — based on live Senior coverage.
11. Strategy releases the assets through the selected path, applying any cooldown or fee defined for the current coverage range.
12. CDO transfers the released assets to the user, completing the withdrawal.

## Tranche Model

### Senior (Sr) — Protected Yield & Principal

- Receives its target APY before Mezzanine and Junior receive anything.
- Target APY is the maximum of a configured floor and a formula-driven rate.
- **Principal protection via waterfall**: Senior principal is impaired only after Junior and Mezzanine — both their yield and principal — are fully exhausted.
- Protection applies to **both yield shortfalls and underlying asset depreciation**. If the value of the underlying asset (e.g. `USDai`, `sUSDai`) declines, the resulting loss is absorbed in the same waterfall order: Junior yield → Junior principal → Mezzanine yield → Mezzanine principal → Senior.
- A negative strategy gain (`netGain < 0`) is treated as a loss event and routed through the waterfall identically to a yield shortfall.
- Senior holders see their principal preserved as long as combined Junior and Mezzanine capacity exceeds the total loss — yield-driven or price-driven.

### Mezzanine (Mz) — Balanced Risk

- Receives base APY on its TVL plus a leverage-weighted share of the delivered risk premium.
- Absorbs losses after Junior is exhausted, before any Senior impairment.
- Provides Junior with additional yield amplification via the leverage factor.

### Junior (Jr) — Leveraged Yield

- Receives base APY on its TVL plus a leverage-weighted share of the delivered risk premium.
- Absorbs losses first — both yield and principal — before Mezzanine.
- The leverage factor `α` controls how aggressively risk premium is concentrated into Junior.

## Accounting Model

### Definitions

$$\text{pool} = \text{TVL}_{sr} + \text{TVL}_{mz} + \text{TVL}_{jr}$$
$$\text{sub} = \text{TVL}_{mz} + \text{TVL}_{jr}$$
$$\text{netGain} = \text{BaseAPY} \times \text{pool}$$

---

### 1. Senior Target

$$\text{RP}_{nominal} = x_{sr} + y_{sr} \times \left( \frac{\text{TVL}_{sr}}{\text{pool}} \right)^{k_{sr}}$$
$$\text{APY}_{sr\_formula} = \text{BaseAPY} \times (1 - \text{RP}_{nominal})$$
$$\text{APY}_{sr\_target} = \max(\text{floor}_{sr}, \text{APY}_{sr\_formula})$$
$$\text{Sr}_{yield\_target} = \text{APY}_{sr\_target} \times \text{TVL}_{sr}$$

---

### 2. Risk Premium Split (Mezz vs Junior)

$$\text{share}_{jr} = \frac{\alpha \times \text{TVL}_{jr}}{\alpha \times \text{TVL}_{jr} + \text{TVL}_{mz}}$$
$$\text{share}_{mz} = \frac{\text{TVL}_{mz}}{\alpha \times \text{TVL}_{jr} + \text{TVL}_{mz}}$$

---

### 3. Delivered Risk Premium

$$\text{RP}_{delivered} = \max(0, (\text{BaseAPY} - \text{APY}_{sr\_target}) \times \text{TVL}_{sr})$$

$$\text{RP}_{actual\_rate} = \begin{cases} \frac{\text{RP}_{delivered}}{\text{BaseAPY} \times \text{TVL}_{sr}} & \text{if } \text{BaseAPY} > 0 \\ 0 & \text{otherwise} \end{cases}$$

---

### 4. Yield Distribution Scenarios

#### Case 1 — Sufficient Yield

Applied when: $\text{netGain} \ge \text{Sr}_{yield\_target} + \text{BaseAPY} \times \text{sub}$

$$Y_{sr} = \text{Sr}_{yield\_target}$$
$$Y_{mz} = \text{BaseAPY} \times \text{TVL}_{mz} + \text{share}_{mz} \times \text{RP}_{delivered}$$
$$Y_{jr} = \text{BaseAPY} \times \text{TVL}_{jr} + \text{share}_{jr} \times \text{RP}_{delivered}$$

> **Note:** Senior receives its full target. Mezzanine and Junior each receive base APY on their own TVL plus their leverage-weighted share of the delivered risk premium.

#### Case 2 — Insufficient Yield (Loss Waterfall)

Applied when: $\text{netGain} < \text{Sr}_{yield\_target} + \text{BaseAPY} \times \text{sub}$

$$\text{total}_{shortfall} = \text{Sr}_{yield\_target} + \text{BaseAPY} \times \text{sub} - \text{netGain}$$

**Layer 1 + 2: Junior absorbs yield, then principal**
$$\text{Jr}_{capacity} = \max(0, \text{BaseAPY} \times \text{TVL}_{jr}) + \text{TVL}_{jr}$$
$$\text{jr}_{loss} = \min(\text{total}_{shortfall}, \text{Jr}_{capacity})$$
$$\text{remaining}_1 = \text{total}_{shortfall} - \text{jr}_{loss}$$

**Layer 3 + 4: Mezzanine absorbs yield, then principal**
$$\text{Mz}_{capacity} = \max(0, \text{BaseAPY} \times \text{TVL}_{mz}) + \text{TVL}_{mz}$$
$$\text{mz}_{loss} = \min(\text{remaining}_1, \text{Mz}_{capacity})$$
$$\text{remaining}_2 = \text{remaining}_1 - \text{mz}_{loss}$$

**Layer 5: Senior impaired (extreme case only)**
$$\text{sr}_{loss} = \text{remaining}_2$$

**Yield Distribution Results:**
$$Y_{sr} = \text{Sr}_{yield\_target} - \text{sr}_{loss}$$
$$Y_{mz} = \text{BaseAPY} \times \text{TVL}_{mz} - \text{mz}_{loss}$$
$$Y_{jr} = \text{BaseAPY} \times \text{TVL}_{jr} - \text{jr}_{loss}$$

Losses flow strictly upward. Each tranche's full capacity (yield + principal) is consumed before the next tranche is touched.

## Features

### Tranche Vaults

- Three ERC-4626 vaults: Senior, Mezzanine, Junior.
- Each vault denominated in the strategy's base asset.
- Each vault is a meta-vault accepting the base asset plus strategy-supported alternatives.
- Share price reflects the tranche's TVL after every protocol action.

### CDO Orchestrator

- Single entry point for all deposit, withdraw, and yield-settlement actions.
- Forwards user assets to the Strategy.
- Calls Accounting to settle TVLs before any share mint or redemption.
- Enforces tranche-level access rules and asset-list constraints.

### Strategy

- Manages all staked assets across the protocol.
- Reports a single `totalTVL` value that drives Accounting updates.
- Implements asset-return mechanisms: direct return, ERC20 cooldown (AssetsLock), unstaking cooldown, shares cooldown (SharesLock), and exit fees.
- Each withdrawal request is tracked independently — new requests never extend or affect earlier ones.

### Accounting

- Pure-calculation contract; holds no funds.
- Computes `TVL_sr`, `TVL_mz`, `TVL_jr`, and reserve TVL on every action.
- Applies the yield-split or loss-waterfall logic depending on `netGain`.
- Tracks Senior's target index over time so target yield compounds correctly.
- Exposes per-tranche `exchangeRate` and `totalAssets` to the ERC-4626 vaults.

### APR Feed

- Off-chain or governance-controlled feed for base APY and benchmark APY parameters.
- Pushes updates into Accounting; Accounting recalculates Senior's target index at the moment of update.
- All parameter changes are observable on-chain via events.

### Coverage-Aware Withdrawals

- Senior coverage is divided into up to three ranges.
- Each range can apply any combination of SharesLock, AssetsLock, and exit fee.
- High coverage: faster, cheaper exits.
- Low coverage: slower, more expensive exits — protects liquidity and discourages runs.
- Rules are deterministic and known to users before they request a withdrawal.

## Scope

### In Scope

- Three-tranche ERC-4626 vaults sharing one Strategy
- CDO orchestration of deposits, withdrawals, and yield settlement
- Dynamic Senior target APY with floor and risk-premium formula
- Leverage-weighted Mezz/Junior split of delivered risk premium
- Strict loss waterfall (Junior → Mezzanine → Senior) covering both yield and principal
- Multi-asset deposits where the underlying strategy supports them
- Coverage-aware withdrawal mechanics (SharesLock, AssetsLock, fee, cooldown)
- APR Feed integration for base and benchmark APYs
- Reserve TVL allocation from strategy gain
- On-chain events for all yield-split, loss-allocation, and parameter changes

### Out Of Scope

- Tranche-to-tranche secondary market or share swaps
- Tokenised tranche derivatives outside the ERC-4626 share
- Cross-strategy aggregation (a single CDO instance serves one Strategy)
- Insurance fund or external loss backstop
- Governance token and DAO mechanics
- Off-chain credit scoring or KYC gating
- Versioned strategy migration tooling (initial deployment only)

## Success Criteria

1. A user can deposit into any tranche and receive shares priced against the post-update tranche TVL.
2. Across a yield period, Senior receives `APY_sr_target × TVL_sr` whenever `netGain` is sufficient.
3. Residual risk premium splits between Mezz and Junior in exact accordance with `share_mz` and `share_jr`.
4. When `netGain` is insufficient, losses are absorbed in strict order: Junior yield → Junior principal → Mezz yield → Mezz principal → Senior — and no out-of-order impairment occurs.
5. Sum of `Y_sr + Y_mz + Y_jr + reserve_gain` equals `netGain` in both cases, with no value created or destroyed by the accounting.
6. Withdrawals settle through the coverage-appropriate path (instant, AssetsLock, SharesLock, or fee) based on live Senior coverage.
7. APR Feed updates propagate to Senior target index without retroactively changing past periods.
8. Every yield split, loss allocation, parameter update, and withdrawal path selection emits a verifiable event.
