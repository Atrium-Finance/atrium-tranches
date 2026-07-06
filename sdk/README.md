# Atrium SDK

TypeScript SDK for **Atrium** — a three-tranche CDO (Junior / Mezzanine / Senior) over a single
yield strategy on Arbitrum. Deposits use the base asset **USDai**; withdrawals are denominated in
the output token **sUSDai**. Yield flows Senior-first; losses flow Junior-first (the waterfall).

Read-focused: wraps a viem `PublicClient` for on-chain reads and returns viem write requests you
submit with your own `WalletClient`.

## Install

```bash
pnpm add atrium-sdk viem
```

## Quick start

```ts
import { AtriumSDK, TrancheId, ExitMode } from "atrium-sdk";
import { arbitrum } from "viem/chains";

const sdk = new AtriumSDK({
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  chain: arbitrum,
  addresses: {
    cdo:            "0xbe0310f4F343Ba7C34815e8AB67752cdE05cD858",
    accounting:     "0x3c142b82aD93A7308BE7fd83a06BD1Bc1AF613c7",
    strategy:       "0xb7E576764BF0496702C868B504D86d062A7b80c8",
    jrVault:        "0x19268f989886eE0599e5ebd8Ac559585619dd64a",
    mzVault:        "0x52c91B6ecD4C95d9BF43F34ca6217754925Efc9f",
    srVault:        "0xe1AB89fF238C289862bfFA41b6b6C062b2829d3a",
    sharesCooldown: "0x95b44cFCB08606B1d28e4678De9859Eda3e3b093",
    usdai:          "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
    susdai:         "0x5f02c1bec4ad5de9b7abf999c1f0854d4836a049",
  },
});

// Reads
const tranches = await sdk.getAllTranches();
const health   = await sdk.getProtocolHealth();   // coverage, TVLs, minCoverage
const apr      = await sdk.getApr();               // aprSrt / aprBase / aprTarget / index
const preview  = await sdk.previewWithdraw(TrancheId.JUNIOR, shares, user);
```

> Addresses above are from `ignition/deployments/chain-42161/deployed_addresses.json`. Regenerate
> after every deploy.

## Deposit (USDai)

```ts
import { createWalletClient, custom } from "viem";
const wallet = createWalletClient({ chain: arbitrum, transport: custom(window.ethereum) });

// 1) approve USDai for the tranche vault
await wallet.writeContract({ ...sdk.buildApprove(sdk.addr.usdai, sdk.addr.jrVault, amount), account });
// 2) deposit
await wallet.writeContract({ ...sdk.buildDeposit(TrancheId.JUNIOR, amount, account), account });
```

## Withdraw (receive sUSDai)

Withdrawals **must** use the sUSDai meta-token path — `buildWithdraw` does this for you (it calls
`redeem(sUSDai, shares, receiver, owner)`). The plain ERC-4626 `redeem(shares,…)` routes the base
asset which the v1 Strategy rejects.

```ts
const req = sdk.buildWithdraw(TrancheId.JUNIOR, shares, account, account);

// ALWAYS simulate first — surfaces coverage / pause / mode reverts (viem decodes the custom error)
await sdk.publicClient.simulateContract({ ...req, account });
await wallet.writeContract({ ...req, account });
```

If `previewWithdraw(...).mode === ExitMode.SharesLock`, the shares are escrowed in the SharesCooldown
silo for `cooldownSeconds`. Poll `getUserWithdrawRequests(user)`; once `isClaimable`, finalize:

```ts
await wallet.writeContract({ ...sdk.buildFinalizeCooldown(TrancheId.JUNIOR, account), account });
```

## API

| Method | Returns |
|---|---|
| `getTranche(id)` / `getAllTranches()` | TVL, supply, share price, indicative APR |
| `previewDeposit(id, assets)` | shares minted, share price |
| `previewWithdraw(id, shares, owner)` | mode, fee, cooldown, net USDai + sUSDai out |
| `getProtocolHealth()` | coverage, minCoverage, per-tranche TVL, reserve, strategy TVL |
| `getApr()` | `aprSrt`, `aprBase`, `aprTarget`, `srtTargetIndex` (all 1e18) |
| `getUserWithdrawRequests(user)` | pending share-lock requests across tranches |
| `getUserPortfolio(user)` | shares + USDai value per tranche |
| `getTokenBalance / getTokenAllowance / getShareBalance` | ERC-20 / share reads |
| `buildApprove / buildDeposit / buildWithdraw / buildFinalizeCooldown` | viem write requests |

Admin ABIs (`PRIME_CDO_ADMIN_ABI`, `ACCOUNTING_ADMIN_ABI`, `SHARES_COOLDOWN_ADMIN_ABI`,
`STRATEGY_ADMIN_ABI`, `ACM_ABI`) are exported for governance tooling.

## Notes & gotchas

- **TrancheId** matches the on-chain `TrancheKind` enum: `JUNIOR=0, MEZZANINE=1, SENIOR=2`.
- **Withdraw = sUSDai** overload only (handled by `buildWithdraw`).
- **Simulate before write** to catch `CoverageBelowMinimum`, `WithdrawalsDisabled`, `RedemptionParamsMismatch`.
- APR / fee / coverage values are **1e18-scaled** (`0.04e18 = 4%`).
- Reads reflect the last `updateAccounting()`; for an exact live quote, `simulateContract` the entry.
- Alt-token (sUSDai) deposits are intentionally omitted — the on-chain meta-deposit path has an open
  issue (maxWithdraw check on ERC-7540 sUSDai). Use the USDai deposit path.

## Build

```bash
pnpm install
pnpm build        # tsup → dist (cjs + esm + d.ts)
pnpm typecheck
```
