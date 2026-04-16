# PrimeVaults SDK

TypeScript SDK for **PrimeVaults V2** — a 3-tranche structured yield protocol on Arbitrum. All three tranches (Senior, Mezzanine, Junior) are base-asset only (USD.AI) and share the same deposit/withdraw API.

## Installation

```bash
npm install primevaults-sdk viem
# or
pnpm add primevaults-sdk viem
```

Build from source:

```bash
git clone https://github.com/your-org/primevaults
cd primevaults/lib
pnpm install
pnpm build
```

## Quick Start

```ts
import { PrimeVaultsSDK, TrancheId } from "primevaults-sdk";
import { arbitrum } from "viem/chains";

const sdk = new PrimeVaultsSDK({
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  chain: arbitrum,
  addresses: {
    primeCDO: "0x...",
    seniorVault: "0x...",
    mezzVault: "0x...",
    juniorVault: "0x...",
    primeLens: "0x...",
    accounting: "0x...",
    strategy: "0x...",
    // optional
    erc20Cooldown: "0x...",
    sharesCooldown: "0x...",
    redemptionPolicy: "0x...",
    aprFeed: "0x...",
    riskParams: "0x...",
    primeLock: "0x...",
  },
});
```

## Read API

### Protocol Health

```ts
const health = await sdk.getProtocolHealth();
// { seniorTVL, mezzTVL, juniorTVL, totalTVL, coverageSenior, coverageMezz,
//   minCoverageForDeposit, shortfallPaused, juniorShortfallPausePrice, strategyTVL }
```

### Tranches (with APY)

```ts
// One tranche
const senior = await sdk.getTrancheById(TrancheId.SENIOR);
console.log(senior.apy); // 18 decimals — divide by 1e18 for percent

// All three (single multicall)
const senior = await sdk.getTrancheById(TrancheId.SENIOR);
const mezz   = await sdk.getTrancheById(TrancheId.MEZZ);
const junior = await sdk.getTrancheById(TrancheId.JUNIOR);
```

`TrancheInfo` fields: `trancheId`, `vault`, `name`, `symbol`, `totalAssets`, `totalSupply`, `sharePrice`, `asset`, `apy`.

### User Portfolio

```ts
const portfolio = await sdk.getUserPortfolio("0xUser...");
// { senior: { shares, assets }, mezz: {...}, junior: {...}, totalAssetsUSD }
```

### Preview Withdraw

```ts
const preview = await sdk.previewWithdraw(TrancheId.MEZZ, sharesToBurn);
// { mechanism (NONE/ASSETS_LOCK/SHARES_LOCK), feeBps, cooldownDuration,
//   feeAmount, netBaseAmount, baseAmountOut }
```

### Pending Withdrawals

```ts
const pending = await sdk.getUserWithdrawRequests("0xUser...");
// PendingWithdraw[] with isClaimable + timeRemaining
```

### Misc

```ts
await sdk.getShareBalance(TrancheId.SENIOR, user);
await sdk.previewRedeem(TrancheId.SENIOR, shares);
await sdk.getTokenBalance(usdAiAddress, user);
await sdk.getTokenAllowance(usdAiAddress, owner, spender);
```

## Write API

The SDK is read-focused. For writes, build transactions directly using the exported ABIs and viem's `walletClient`:

### Deposit (any tranche)

```ts
import { TRANCHE_VAULT_ABI, ERC20_ABI } from "primevaults-sdk";

// 1. Approve
await walletClient.writeContract({
  address: USDAI_ADDRESS,
  abi: ERC20_ABI,
  functionName: "approve",
  args: [seniorVaultAddress, amount],
});

// 2. Deposit
await walletClient.writeContract({
  address: seniorVaultAddress,
  abi: TRANCHE_VAULT_ABI,
  functionName: "deposit",
  args: [amount, receiverAddress],
});
```

### Request Withdraw

```ts
const hash = await walletClient.writeContract({
  address: vaultAddress,
  abi: TRANCHE_VAULT_ABI,
  functionName: "requestWithdraw",
  args: [shares, receiverAddress],
});

// Parse WithdrawRequested event for mechanism + cooldownId
```

### Claim Cooldown

```ts
// ASSETS_LOCK — claim sUSDai after cooldown
await walletClient.writeContract({
  address: vaultAddress,
  abi: TRANCHE_VAULT_ABI,
  functionName: "claimWithdraw",
  args: [cooldownId, cooldownHandlerAddress],
});

// SHARES_LOCK — claim shares (yield accrued during lock)
await walletClient.writeContract({
  address: vaultAddress,
  abi: TRANCHE_VAULT_ABI,
  functionName: "claimSharesWithdraw",
  args: [cooldownId],
});
```

## Governance

PrimeVaults V2 uses **progressive decentralization** (see `docs/PV_V2_GOVERNANCE.md`):

- **Stage 1**: Deployer EOA (initial setup)
- **Stage 2**: Operations Multisig (Safe 3/5)
- **Stage 3**: **PrimeLock** (24-hour timelock) + **Guardian** Safe for emergency
- **Stage 4** (future): DAO with PRIME ERC20Votes token

The Guardian Safe has narrow emergency powers (pause/unpause, cancel proposals) bypassing the timelock. All other parameter changes go through the 24-hour PrimeLock delay.

## Runnable Scripts

All scripts are in `lib/scripts/`. Run with `npx tsx`:

```bash
# Read-only dashboard
ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts
ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts --user 0xUser...

# Deposit (any tranche)
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 100
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche JUNIOR --amount 25 --dry-run

# Withdraw
npx tsx lib/scripts/withdraw-flow.ts --tranche MEZZ --shares 10
npx tsx lib/scripts/withdraw-flow.ts --claim --cooldown-id 1 --tranche SENIOR
npx tsx lib/scripts/withdraw-flow.ts --claim-shares --cooldown-id 2 --tranche JUNIOR

# Governance / admin
npx tsx lib/scripts/claim-reserve.ts --recipient 0xTreasury...
npx tsx lib/scripts/unpause.ts
npx tsx lib/scripts/set-cooldown.ts --tranche MEZZ --assets-lock 3d --shares-lock 7d
```

## Exported Types

```ts
import type {
  PrimeVaultsConfig,
  ContractAddresses,
  TrancheId,
  TrancheInfo,
  PreviewDeposit,
  PreviewWithdraw,
  PendingWithdraw,
  ProtocolHealth,
  WithdrawCondition,
  CDOWithdrawResult,
  UserPortfolio,
  WriteResult,
  WithdrawRequestResult,
  CooldownType,
} from "primevaults-sdk";
```

## Exported ABIs

```ts
import {
  PRIME_LENS_ABI,
  TRANCHE_VAULT_ABI,
  ACCOUNTING_ABI,
  ERC20_ABI,
  APR_PAIR_FEED_ABI,
} from "primevaults-sdk";
```

Admin ABIs (governance ops):

```ts
import {
  PRIME_CDO_ADMIN_ABI,
  ACCOUNTING_ADMIN_ABI,
  RISK_PARAMS_ABI,
  REDEMPTION_POLICY_ABI,
  STRATEGY_ADMIN_ABI,
} from "primevaults-sdk/admin";
```

## Notes

- **APR vs APY**: SDK getter returns `apy` (renamed from `apr`). Internal AprPairFeed contract still uses APR (data source from Aave is APR).
- **Withdraw output token**: All withdrawals return **sUSDai** (yield-bearing). To convert to USD.AI, call `sUSDai.requestRedeem()` then `sUSDai.redeem()` after the sUSDai cooldown.
- **Test files**: See `test/unit/` in the main repo for usage patterns and integration examples.

## Requirements

- Node.js ≥ 18
- `viem` ≥ 2.0.0
