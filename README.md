# PrimeVaults V2

## What is PrimeVaults?

PrimeVaults V2 is a **3-tranche structured yield protocol** on Arbitrum. It takes a single yield source (sUSDai from USD.AI) and splits its risk/reward into three tiers -- Senior, Mezzanine, and Junior -- so depositors can choose the exact risk profile they want.

Each yield source deploys as a completely independent **market** (1 CDO = 1 Strategy). Markets share no state, no capital, no risk.

### The Problem

DeFi yield is binary: you either take all the risk of a yield source, or you don't participate. There's no way for conservative capital (treasuries, institutions) to earn yield with strong loss protection, while letting risk-tolerant capital earn amplified returns by absorbing that risk.

### The Solution

PrimeVaults solves this by structuring yield into tranches (inspired by traditional finance CDOs):

| Tranche       | Risk    | Yield                                     | Loss Absorption          | Who Is It For?                                     |
| ------------- | ------- | ----------------------------------------- | ------------------------ | -------------------------------------------------- |
| **Senior**    | Lowest  | Guaranteed floor APR (benchmark rate)     | Last to lose (3rd layer) | Conservative capital, treasuries, institutions     |
| **Mezzanine** | Medium  | Leveraged residual yield (~2-3x base APR) | 2nd layer                | Yield seekers wanting moderate risk                |
| **Junior**    | Highest | Residual yield + risk premiums            | First to lose (1st layer)| Risk-tolerant capital, protocol-aligned depositors |

### How It Works (Simple Example)

```
Yield source: sUSDai generating 5% APR
Total pool: $1M ($800K Senior + $100K Mezz + $100K Junior)

Senior earns:  ~3.9% APR (guaranteed floor, protected by $200K subordination)
Mezz earns:    ~8.2% APR (leveraged from Senior's yield transfer)
Junior earns:  ~10.5% APR (residual: base yield + risk premiums from Senior/Mezz)

If sUSDai loses $50K:
  Layer 1: Junior absorbs $50K -> Junior TVL drops from $100K to $50K
  Layer 2-3: Mezz and Senior are completely unaffected
```

---

## Architecture

### Market Isolation (1 CDO = 1 Strategy)

```
Market "USD.AI" (sUSDai):
  Senior Vault  --+
  Mezz Vault    --+--> PrimeCDO --> SUSDaiStrategy --> sUSDai vault (ERC-7540)
  Junior Vault  --+       |
                          +--> Accounting (TVL math, gain splitting, loss waterfall)
                          +--> RedemptionPolicy (coverage-aware cooldowns)
                          +--> AprPairFeed --> SUSDaiAprPairProvider (on-chain APR oracle)
                          +--> RiskParams (risk premium curve parameters)
```

### Core Contracts

#### PrimeCDO -- The Orchestrator

Central coordinator for a single market. It:

- Routes deposits to the strategy, with two deposit paths: base asset (USD.AI) and output token (sUSDai)
- Enforces **coverage gates**: blocks Senior/Mezz deposits if coverage drops below 105%
- Triggers the **3-layer loss waterfall** when the strategy loses money
- Auto-pauses all actions if Junior share price drops below 90% (shortfall protection)
- Routes withdrawals through RedemptionPolicy for coverage-aware cooldowns
- Accumulates reserve (protocol fees) from gain splits and withdrawal fees

#### Accounting -- The Math Engine

Tracks per-tranche TVL and implements:

- **Gain splitting:** Senior gets a guaranteed target APR (from APR oracle). Junior gets the residual. Mezzanine gets leveraged yield from the spread.
- **Loss waterfall (3 layers):** Junior (Layer 1) -> Mezzanine (Layer 2) -> Senior (Layer 3). Senior only loses if everything else is wiped out.
- **Risk premium curves (RP1, RP2):** Auto-price the cost of protection. As Senior grows, RP1 rises. As coverage drops, RP2 rises.

#### TrancheVault -- The User-Facing Token

ERC-4626 vault deployed 3 times per market (pvSENIOR, pvMEZZ, pvJUNIOR) with identical bytecode. It:

- Wraps ERC-4626 (deposit/mint/convertToAssets) but delegates all logic to PrimeCDO
- `totalAssets()` reads from Accounting (not token balance)
- Disables standard `withdraw`/`redeem` -- users must call `requestWithdraw` to enter the cooldown flow
- Supports two deposit paths: `deposit(assets, receiver)` for base asset and `depositOutputToken(amount, receiver)` for sUSDai

#### RedemptionPolicy -- Coverage-Aware Cooldowns

Uses **mechanism escalation** based on real-time coverage ratios:

- **Senior:** Always instant (best UX for safest tranche)
- **Mezzanine:** Instant (cs > 160%) -> AssetsLock 3d (cs > 140%) -> SharesLock 7d (cs <= 140%)
- **Junior:** Requires BOTH cs AND cm above thresholds. Most restrictive when coverage is stressed.

Three cooldown mechanisms:

- **NONE:** Instant withdrawal
- **ASSETS_LOCK (ERC20Cooldown):** sUSDai locked for a period, no yield during lock
- **SHARES_LOCK (SharesCooldown):** Vault shares escrowed, continue earning yield during lock

#### SUSDaiStrategy -- Yield Source Adapter

Connects to the sUSDai ERC-7540 vault on Arbitrum:

- Deposit: USD.AI -> sUSDai.deposit() (synchronous ERC-4626)
- Withdraw: always returns sUSDai instantly to the user
- Users then convert sUSDai -> USD.AI via sUSDai's own ERC-7540 FIFO redemption queue

#### AprPairFeed / SUSDaiAprPairProvider -- APR Oracle

Provides two rates: the benchmark APR (Aave weighted-average supply rate of USDC/USDT/DAI) as Senior's floor, and the strategy's current APR computed from sUSDai exchange rate growth.

#### RiskParams -- Premium Curve Configuration

Stores risk premium curve parameters (x, y, k for RP1 and RP2) with governance-enforced safety bounds.

#### PrimeLens -- Read-Only Aggregator

Periphery contract for frontend data. Aggregates tranche info, protocol health, pending withdrawals, and withdraw conditions in a single call.

#### PrimeLock -- Governance Timelock

24-hour timelock wrapping OpenZeppelin TimelockController. Operations Multisig proposes, Guardian can cancel.

### Self-Balancing Economics

```
Coverage stressed (few Junior depositors):
  -> Senior/Mezz deposits BLOCKED (coverage gate)
  -> Junior APR rises (RP2 curve) -> attracts Junior capital
  -> Junior withdrawals get SHARES_LOCK (expensive to exit) -> Junior stays
  -> Coverage recovers naturally
```

---

## Withdraw Flow

All tranches receive sUSDai (the underlying yield token). Full withdrawal is a 3-step process:

```
Step 1: TrancheVault.requestWithdraw(shares, receiver)
        -> PrimeCDO evaluates RedemptionPolicy -> routes to cooldown mechanism
        -> NONE: strategy.withdraw() returns sUSDai instantly
        -> ASSETS_LOCK: sUSDai locked in ERC20Cooldown (wait -> claim)
        -> SHARES_LOCK: vault shares escrowed in SharesCooldown (wait -> claim at current rate)

Step 2: User calls sUSDai.requestRedeem(shares) -> enters sUSDai ERC-7540 FIFO queue
        -> Wait for sUSDai cooldown (admin calls serviceRedemptions)

Step 3: User calls sUSDai.redeem(shares, receiver) -> receives USD.AI
```

---

## Contract Directory Layout

```
contracts/
  interfaces/          # All I-prefixed interfaces (IStrategy, IPrimeCDO, ICooldownHandler, etc.)
  core/                # Accounting, PrimeCDO, TrancheVault
  libraries/           # FixedPointMath (18-decimal arithmetic via PRBMath)
  cooldown/            # ERC20Cooldown, SharesCooldown, RedemptionPolicy
  strategies/          # BaseStrategy + usdai/ (SUSDaiStrategy, SUSDaiAprPairProvider)
  oracles/             # AprPairFeed
  periphery/           # PrimeLens (read-only aggregator)
  governance/          # RiskParams, PrimeLock (24h timelock)
  test/mocks/          # Mock contracts for testing
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (v10+)

### Install

```bash
pnpm install
```

### Compile

```bash
npx hardhat compile
```

### Test

```bash
npx hardhat test                                # Run all tests
npx hardhat test test/unit/Accounting.test.ts   # Run a single test file
REPORT_GAS=true npx hardhat test                # With gas reporting
npx hardhat coverage                            # Coverage report
```

### Integration Tests (Arbitrum Fork)

```bash
ARB_RPC_URL=<url> npx hardhat test test/integration/
```

---

## SDK

A TypeScript SDK in `lib/` wraps all contract interactions for frontend and scripting. Built with Viem, published as `primevaults-sdk`.

```bash
cd lib && pnpm install
pnpm build       # Build CJS + ESM + types
pnpm dev         # Watch mode
pnpm typecheck   # TypeScript check
```

### SDK Scripts

```bash
# Dashboard (read-only, no key needed)
ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts

# Deposit into any tranche
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 100

# Request withdrawal
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts --tranche JUNIOR --shares 0.125

# Claim cooldown withdrawal
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts --claim --cooldown-id 1 --tranche SENIOR

# Full E2E test (4 scenarios: instant, assets_lock, shares_lock, sUSDai deposit)
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/e2e-test.ts --amount 1

# Admin: claim reserves, unpause, set cooldowns
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/claim-reserve.ts --recipient 0x...
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/unpause.ts
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/set-cooldown.ts --tranche MEZZ --assets-lock 3d --shares-lock 7d
```

---

## Deployment

Deployed to **Arbitrum mainnet** (chain ID 42161). Key external contracts:

- **USD.AI** (base asset): `0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF`
- **sUSDai** (ERC-7540 vault): `0x0B2b2B2076d95dda7817e785989fE353fe955ef9`

### Deploy Scripts

Deploy scripts in `deploy/` run sequentially:

1. `01_deploy_shared.ts` -- Shared infra (RiskParams, ERC20Cooldown, SharesCooldown)
2. `02_deploy_market.ts` -- Market contracts (AprProvider, AprFeed, Accounting, Strategy, RedemptionPolicy, PrimeCDO, 3x TrancheVault)
3. `03_configure.ts` -- Register tranches, wire CDO, authorize cooldowns (idempotent, supports `TEST_MODE=1` for short cooldowns)
4. `04_deploy_lens.ts` -- PrimeLens (read-only aggregator)
5. `06_deploy_primelock.ts` -- PrimeLock governance timelock
6. `07_transfer_governance.ts` -- Transfer ownership to PrimeLock
7. `08_accept_governance.ts` -- Accept ownership via PrimeLock proposal

### Deployed Addresses

See `deploy/deployed.json` for all contract addresses. Key contracts:

| Contract | Address |
|----------|---------|
| PrimeCDO | `0xfF2D8bAa4aE7a7deC16264F08b9bEbA5b89f44de` |
| Senior Vault | `0x0aD630E65BAbb973A04899125A2d6d69Ef0A46d2` |
| Mezzanine Vault | `0x40b6982e9313aF67F61FE1Aa8E3E0e84946297F5` |
| Junior Vault | `0x3008B64ed98e30CCC13E9cd264566C3093A2Fe50` |
| Accounting | `0x70090C19F32754c04042e6D2a1AE05c0F24FF1b1` |
| Strategy | `0x927605D30441500d854923E1C9499685DB8D7f6F` |
| PrimeLens | `0xaf5512F0DDE9Ce3f7A68763D609554FEEE8BBF28` |

---

## Governance

Progressive decentralization model (see `docs/PV_V2_GOVERNANCE.md` for full details):

- **Stage 1:** Deployer EOA (initial setup)
- **Stage 2:** Operations Multisig (Safe 3/5)
- **Stage 3:** PrimeLock (24h timelock) + Guardian Safe (current target)
- **Stage 4:** DAO with PRIME token (future)

**Guardian** has narrow emergency powers: pause/unpause only. Cannot change parameters.

---

## Stack

- **Solidity** ^0.8.24 (optimizer: 200 runs)
- **Hardhat** + TypeScript
- **ethers** v6 + **Viem** for tests
- **OpenZeppelin** Contracts 5.1.0
- **PRBMath** for fixed-point arithmetic
- Package manager: **pnpm**

## Documentation

| File                          | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| `docs/TRANCHE_MATH.md`       | Formula reference for all mathematical models   |
| `docs/PV_V2_GOVERNANCE.md`   | Governance architecture and rollout stages       |
| `CLAUDE.md`                   | AI assistant context and coding conventions      |

## License

MIT
