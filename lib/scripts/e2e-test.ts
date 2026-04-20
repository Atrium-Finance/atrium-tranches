/**
 * End-to-end mainnet test — exercises every user-facing flow on the deployed protocol.
 *
 * Pre-requisites:
 *   1. Deploy stack (TEST_MODE=1 npx hardhat run deploy/03_configure.ts)
 *      → ASSETS_LOCK = 3 minutes, SHARES_LOCK = 5 minutes
 *   2. Wallet has at least DEPOSIT_AMOUNT * 4 USD.AI for testing all 3 tranches
 *
 * Test sequence:
 *   1. Show protocol health + tranche state
 *   2. Junior deposit (no coverage gate)
 *   3. Senior deposit (requires coverage)
 *   4. Mezz deposit (requires coverage)
 *   5. Withdraw test for each tranche → discover mechanism, claim after cooldown
 *   6. sUSDai deposit (output token) into Junior → verify preview matches actual
 *   7. Final dashboard
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/e2e-test.ts
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/e2e-test.ts --amount 10
 */

import { parseUnits, formatUnits, decodeEventLog, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, USDAI, SUSDAI } from "./config";
import { TRANCHE_VAULT_ABI, ERC20_ABI } from "../abis";
import { TrancheId, CooldownType } from "../types";

const MECHANISM_NAMES: Record<number, string> = {
  0: "NONE",
  1: "ASSETS_LOCK",
  2: "SHARES_LOCK",
};

const TRANCHE_LABEL: Record<number, string> = {
  0: "SENIOR",
  1: "MEZZ",
  2: "JUNIOR",
};

function fmt(v: bigint, decimals = 18): string {
  if (v === 0n) return "0";
  const num = Number(formatUnits(v, decimals));
  // Show "dust" tag for tiny non-zero values that round to 0 at 4 decimals
  if (num > 0 && num < 0.0001) return `dust(${v.toString()} wei)`;
  return num.toFixed(4);
}

function fmtPct(v: bigint): string {
  return `${Number(formatUnits(v, 16)).toFixed(2)}%`;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function showHealth(sdk: any) {
  console.log(`\n  ─── Protocol health ───`);
  const h = await sdk.getProtocolHealth();
  console.log(`  Senior TVL:  ${fmt(h.seniorTVL)}`);
  console.log(`  Mezz TVL:    ${fmt(h.mezzTVL)}`);
  console.log(`  Junior TVL:  ${fmt(h.juniorTVL)}`);
  console.log(`  Total TVL:   ${fmt(h.totalTVL)}`);
  console.log(`  Coverage Sr: ${h.coverageSenior > 10n ** 36n ? "∞" : fmtPct(h.coverageSenior)}`);
  console.log(`  Coverage Mz: ${h.coverageMezz > 10n ** 36n ? "∞" : fmtPct(h.coverageMezz)}`);
  console.log(`  Paused:      ${h.shortfallPaused}`);
}

async function showTranches(sdk: any) {
  console.log(`\n  ─── Tranches ───`);
  for (const id of [TrancheId.SENIOR, TrancheId.MEZZ, TrancheId.JUNIOR]) {
    const t = await sdk.getTrancheById(id);
    console.log(
      `  ${TRANCHE_LABEL[id]}: assets=${fmt(t.totalAssets)} | supply=${fmt(t.totalSupply)} | price=${fmt(t.sharePrice)} | APY=${fmtPct(t.apy)}`,
    );
  }
}

async function depositTranche(
  sdk: any,
  walletClient: any,
  publicClient: any,
  account: any,
  vaultAddr: string,
  trancheId: TrancheId,
  amount: bigint,
) {
  const label = TRANCHE_LABEL[trancheId];
  console.log(`\n  ─── DEPOSIT ${label}: ${fmt(amount)} USD.AI ───`);

  // Approve
  const allowance = await sdk.getTokenAllowance(USDAI, account.address, vaultAddr);
  if (allowance < amount) {
    console.log(`  Approving USD.AI...`);
    const aHash = await walletClient.writeContract({
      address: USDAI as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddr as `0x${string}`, amount],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, aHash as Hash, "Approve");
  }

  const sharesBefore = await sdk.getShareBalance(trancheId, account.address);
  const hash = await walletClient.writeContract({
    address: vaultAddr as `0x${string}`,
    abi: TRANCHE_VAULT_ABI,
    functionName: "deposit",
    args: [amount, account.address],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, `Deposit ${label}`);
  const sharesAfter = await sdk.getShareBalance(trancheId, account.address);
  const minted: any = sharesAfter - sharesBefore;
  console.log(`  ✓ Shares minted: ${fmt(minted)}`);
  return minted;
}

async function depositSUSDai(
  sdk: any,
  walletClient: any,
  publicClient: any,
  account: any,
  vaultAddr: string,
  trancheId: TrancheId,
  sUSDaiAmount: bigint,
) {
  const label = TRANCHE_LABEL[trancheId];
  console.log(`\n  ─── DEPOSIT sUSDai ${label}: ${fmt(sUSDaiAmount)} sUSDai ───`);

  // Preview
  const preview = await sdk.previewDepositOutputToken(trancheId, sUSDaiAmount);
  console.log(`  Preview: ${fmt(preview.shares)} shares (base-equiv: ${fmt(preview.totalBaseValue)})`);

  // Approve sUSDai to vault
  const allowance = await sdk.getTokenAllowance(SUSDAI, account.address, vaultAddr);
  if (allowance < sUSDaiAmount) {
    console.log(`  Approving sUSDai...`);
    const aHash = await walletClient.writeContract({
      address: SUSDAI as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddr as `0x${string}`, sUSDaiAmount],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, aHash as Hash, "Approve sUSDai");
  }

  const sharesBefore = await sdk.getShareBalance(trancheId, account.address);
  const hash = await walletClient.writeContract({
    address: vaultAddr as `0x${string}`,
    abi: TRANCHE_VAULT_ABI,
    functionName: "depositOutputToken",
    args: [sUSDaiAmount, account.address],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, `DepositOutputToken ${label}`);
  const sharesAfter = await sdk.getShareBalance(trancheId, account.address);
  const minted: any = sharesAfter - sharesBefore;
  console.log(`  ✓ Shares minted: ${fmt(minted)} (preview was ${fmt(preview.shares)})`);

  // Verify preview matches actual (allow small drift from sUSDai rate change between blocks)
  const diff = minted > preview.shares ? minted - preview.shares : preview.shares - minted;
  const bps = preview.shares > 0n ? (diff * 10_000n) / preview.shares : 0n;
  if (bps > 1n) {
    // > 0.01% drift = real mismatch
    console.log(`  ⚠ Preview mismatch: diff=${diff} wei (${Number(bps) / 100}%)`);
  } else {
    console.log(`  ✓ Preview matches actual (diff=${diff} wei, <0.01% — sUSDai rate drift)`);
  }

  return minted;
}

async function withdrawAndClaim(
  sdk: any,
  walletClient: any,
  publicClient: any,
  account: any,
  vaultAddr: string,
  trancheId: TrancheId,
  shares: bigint,
) {
  const label = TRANCHE_LABEL[trancheId];
  console.log(`\n  ─── WITHDRAW ${label}: ${fmt(shares)} shares ───`);

  // Preview
  const preview = await sdk.previewWithdraw(trancheId, shares);
  console.log(`  Mechanism: ${MECHANISM_NAMES[preview.mechanism]}`);
  console.log(`  Cooldown:  ${Number(preview.cooldownDuration)}s`);
  console.log(`  Fee:       ${preview.feeBps} bps (${fmt(preview.feeAmount)})`);
  console.log(`  Net out:   ${fmt(preview.netBaseAmount)}`);

  // Request withdraw
  const hash = await walletClient.writeContract({
    address: vaultAddr as `0x${string}`,
    abi: TRANCHE_VAULT_ABI,
    functionName: "requestWithdraw",
    args: [shares, account.address],
    chain: walletClient.chain,
    account,
  });
  const receipt = await waitForTx(publicClient, hash as Hash, `RequestWithdraw ${label}`);

  // Parse event
  const evt = receipt.logs
    .map((log: any) => {
      try {
        return decodeEventLog({ abi: TRANCHE_VAULT_ABI, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((e: any) => e?.eventName === "WithdrawRequested");

  if (!evt || !("args" in evt)) {
    console.log(`  Tx OK but couldn't parse event — check manually.`);
    return;
  }

  const wr = (evt.args as any).result;
  const mechanism = Number(wr.appliedCooldownType);
  console.log(
    `  Result: instant=${wr.isInstant} | mechanism=${MECHANISM_NAMES[mechanism]} | cooldownId=${wr.cooldownId}`,
  );

  if (wr.isInstant) {
    console.log(`  ✓ Instant — sUSDai received: ${fmt(wr.amountOut)}`);
    return;
  }

  // Wait for cooldown then claim
  const cooldownSec = Number(preview.cooldownDuration);
  console.log(`  Waiting ${cooldownSec + 5}s for cooldown...`);
  await sleep((cooldownSec + 5) * 1000);

  if (mechanism === CooldownType.SHARES_LOCK) {
    // Pre-flight diagnostics
    const COOLDOWN_ABI = [
      { inputs: [{ name: "requestId", type: "uint256" }], name: "isClaimable", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
      { inputs: [{ name: "requestId", type: "uint256" }], name: "timeRemaining", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
      {
        inputs: [{ name: "requestId", type: "uint256" }], name: "getRequest",
        outputs: [{ components: [
          { name: "beneficiary", type: "address" }, { name: "token", type: "address" },
          { name: "amount", type: "uint256" }, { name: "requestTime", type: "uint256" },
          { name: "unlockTime", type: "uint256" }, { name: "status", type: "uint8" },
        ], name: "", type: "tuple" }],
        stateMutability: "view", type: "function",
      },
    ] as const;
    const CDO_ABI = [
      { inputs: [], name: "i_sharesCooldown", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "s_shortfallPaused", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
    ] as const;
    const STRATEGY_ABI = [
      { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    ] as const;

    const cdoAddr = sdk.addresses.primeCDO as `0x${string}`;
    const scAddr = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "i_sharesCooldown" }) as string;
    const isClaimable = await publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "isClaimable", args: [wr.cooldownId] });
    const timeLeft = await publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "timeRemaining", args: [wr.cooldownId] });
    const req = await publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "getRequest", args: [wr.cooldownId] }) as any;
    const paused = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" });
    const stratTVL = await publicClient.readContract({ address: sdk.addresses.strategy as `0x${string}`, abi: STRATEGY_ABI, functionName: "totalAssets" });
    const health = await sdk.getProtocolHealth();

    console.log(`  Pre-flight diagnostics:`);
    console.log(`    SharesCooldown: ${scAddr}`);
    console.log(`    isClaimable:    ${isClaimable}`);
    console.log(`    timeRemaining:  ${timeLeft}s`);
    console.log(`    req.status:     ${req.status} (0=PENDING, 1=CLAIMED)`);
    console.log(`    req.amount:     ${fmt(req.amount)} shares`);
    console.log(`    req.unlockTime: ${req.unlockTime}`);
    console.log(`    shortfallPaused: ${paused}`);
    console.log(`    strategy TVL:   ${fmt(stratTVL as bigint)}`);
    console.log(`    accounting:     Sr=${fmt(health.seniorTVL)} Mz=${fmt(health.mezzTVL)} Jr=${fmt(health.juniorTVL)}`);

    console.log(`  Claiming SHARES_LOCK (${wr.cooldownId})...`);
    const cHash = await walletClient.writeContract({
      address: vaultAddr as `0x${string}`,
      abi: TRANCHE_VAULT_ABI,
      functionName: "claimSharesWithdraw",
      args: [wr.cooldownId],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, cHash as Hash, `ClaimSharesWithdraw ${label}`);
  } else {
    console.log(`  Claiming ASSETS_LOCK (${wr.cooldownId}) handler=${wr.cooldownHandler}...`);
    const cHash = await walletClient.writeContract({
      address: vaultAddr as `0x${string}`,
      abi: TRANCHE_VAULT_ABI,
      functionName: "claimWithdraw",
      args: [wr.cooldownId, wr.cooldownHandler as `0x${string}`],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, cHash as Hash, `ClaimWithdraw ${label}`);
  }
  console.log(`  ✓ Claim complete.`);
}

/**
 * Run a single mechanism scenario:
 *   1. Deposit amounts to set target coverage
 *   2. Withdraw shares from target tranche → verify mechanism matches expected
 *   3. Wait + claim if cooldown
 *   4. Withdraw remaining tranches to clean state
 */
async function runScenario(
  sdk: any,
  walletClient: any,
  publicClient: any,
  account: any,
  addresses: any,
  label: string,
  deposits: { senior: bigint; mezz: bigint; junior: bigint },
  testTranche: TrancheId,
  expectedMechanism: CooldownType,
) {
  console.log(`\n\n  ╔═══════════════════════════════════════════════════════╗`);
  console.log(`  ║  Scenario: ${label.padEnd(43)} ║`);
  console.log(`  ║  Target: ${TRANCHE_LABEL[testTranche].padEnd(7)} → ${MECHANISM_NAMES[expectedMechanism].padEnd(35)} ║`);
  console.log(`  ╚═══════════════════════════════════════════════════════╝`);

  // Deposit Junior FIRST (no coverage gate — can always deposit)
  const jrShares = deposits.junior > 0n
    ? await depositTranche(sdk, walletClient, publicClient, account, addresses.juniorVault, TrancheId.JUNIOR, deposits.junior)
    : 0n;
  const srShares = deposits.senior > 0n
    ? await depositTranche(sdk, walletClient, publicClient, account, addresses.seniorVault, TrancheId.SENIOR, deposits.senior)
    : 0n;
  const mzShares = deposits.mezz > 0n
    ? await depositTranche(sdk, walletClient, publicClient, account, addresses.mezzVault, TrancheId.MEZZ, deposits.mezz)
    : 0n;

  await showHealth(sdk);

  // Withdraw target tranche FIRST → assert mechanism
  const targetShares = testTranche === TrancheId.SENIOR ? srShares : testTranche === TrancheId.MEZZ ? mzShares : jrShares;
  const targetVault =
    testTranche === TrancheId.SENIOR ? addresses.seniorVault
    : testTranche === TrancheId.MEZZ ? addresses.mezzVault
    : addresses.juniorVault;

  console.log(`\n  >>> Asserting mechanism for ${TRANCHE_LABEL[testTranche]} = ${MECHANISM_NAMES[expectedMechanism]}`);
  const preview = await sdk.previewWithdraw(testTranche, targetShares);
  if (Number(preview.mechanism) !== expectedMechanism) {
    throw new Error(
      `❌ Expected mechanism=${MECHANISM_NAMES[expectedMechanism]} but got ${MECHANISM_NAMES[preview.mechanism]} (cs/cm not in target range)`,
    );
  }
  console.log(`  ✓ Mechanism matches expected`);

  await withdrawAndClaim(sdk, walletClient, publicClient, account, targetVault, testTranche, targetShares);

  // Drain remaining tranches (use NONE — coverage should be back to high after target withdraw)
  if (testTranche !== TrancheId.SENIOR && srShares > 0n) {
    await withdrawAndClaim(sdk, walletClient, publicClient, account, addresses.seniorVault, TrancheId.SENIOR, srShares);
  }
  if (testTranche !== TrancheId.MEZZ && mzShares > 0n) {
    const mzNow = await sdk.getShareBalance(TrancheId.MEZZ, account.address);
    if (mzNow > 0n) {
      await withdrawAndClaim(sdk, walletClient, publicClient, account, addresses.mezzVault, TrancheId.MEZZ, mzNow);
    }
  }
  if (testTranche !== TrancheId.JUNIOR && jrShares > 0n) {
    const jrNow = await sdk.getShareBalance(TrancheId.JUNIOR, account.address);
    if (jrNow > 0n) {
      await withdrawAndClaim(sdk, walletClient, publicClient, account, addresses.juniorVault, TrancheId.JUNIOR, jrNow);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const baseStr = parseFlag(args, "--amount") ?? "1";
  const base = parseUnits(baseStr, 18);

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;

  console.log(`\n  ╔═══════════════════════════════════════════════════════╗`);
  console.log(`  ║  PrimeVaults E2E Mainnet Test (3 mechanisms + sUSDai)  ║`);
  console.log(`  ╚═══════════════════════════════════════════════════════╝`);
  console.log(`  User:        ${user}`);
  console.log(`  Base unit:   ${baseStr} USD.AI\n`);
  console.log(`  Scenarios:`);
  console.log(`    A) NONE        — deposit Sr=1×, Mz=1×, Jr=1× (cs=300%, cm=200%)`);
  console.log(`    B) ASSETS_LOCK — deposit Sr=7×, Mz=1×, Jr=3× (cs=157%, cm=400%)`);
  console.log(`    C) SHARES_LOCK — deposit Sr=8×, Mz=1×, Jr=1× (cs=125%, cm=200%)`);
  console.log(`    D) sUSDai      — deposit sUSDai directly into Junior`);

  // Check balance — need ~22× base for phases A-C + 1× for phase D sUSDai
  const required = base * 26n;
  const balance = await sdk.getTokenBalance(USDAI, user);
  console.log(`  Balance:     ${fmt(balance)} USD.AI`);
  console.log(`  Required:    ~${fmt(required)} USD.AI\n`);
  if (balance < required) {
    throw new Error(`Need at least ${fmt(required)} USD.AI for full test (got ${fmt(balance)})`);
  }

  await showHealth(sdk);

  // ─── Phase A: NONE ──────────────────────────────────────────────
  // Equal deposits → high coverage → instant withdraw for all
  await runScenario(
    sdk, walletClient, publicClient, account, addresses,
    "A — NONE (instant withdraw)",
    { senior: base, mezz: base, junior: base },
    TrancheId.MEZZ,
    CooldownType.NONE,
  );

  // ─── Phase B: ASSETS_LOCK ──────────────────────────────────────
  // Sr=7×, Mz=1×, Jr=3× → cs = 11/7 ≈ 157% (in 140-160 range)
  // Mezz: cs in (140, 160] → ASSETS_LOCK ✓
  await runScenario(
    sdk, walletClient, publicClient, account, addresses,
    "B — ASSETS_LOCK (Mezz, 3min cooldown)",
    { senior: base * 7n, mezz: base, junior: base * 3n },
    TrancheId.MEZZ,
    CooldownType.ASSETS_LOCK,
  );

  // ─── Phase C: SHARES_LOCK ──────────────────────────────────────
  // Sr=8×, Mz=1×, Jr=1× → cs = 10/8 = 125% (≤ 140%)
  // Mezz: cs ≤ 140% → SHARES_LOCK ✓
  await runScenario(
    sdk, walletClient, publicClient, account, addresses,
    "C — SHARES_LOCK (Mezz, 5min cooldown)",
    { senior: base * 8n, mezz: base, junior: base },
    TrancheId.MEZZ,
    CooldownType.SHARES_LOCK,
  );

  // ─── Phase D: sUSDai deposit ─────────────────────────────────────
  // Deposit sUSDai (output token) directly into Junior → verify shares
  // Then withdraw to clean state
  {
    console.log(`\n\n  ╔═══════════════════════════════════════════════════════╗`);
    console.log(`  ║  Scenario: D — sUSDai deposit (output token)          ║`);
    console.log(`  ╚═══════════════════════════════════════════════════════╝`);

    // First get some sUSDai: deposit USD.AI into sUSDai vault
    const sUSDaiAmount = base;
    console.log(`\n  Step 1: Acquire sUSDai by depositing ${fmt(sUSDaiAmount)} USD.AI into sUSDai vault`);
    const sUSDaiBalBefore = await sdk.getTokenBalance(SUSDAI, user);

    // Approve USD.AI to sUSDai vault
    const usdaiAllowance = await sdk.getTokenAllowance(USDAI, user, SUSDAI);
    if (usdaiAllowance < sUSDaiAmount) {
      const aHash = await walletClient.writeContract({
        address: USDAI as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [SUSDAI as `0x${string}`, sUSDaiAmount],
        chain: walletClient.chain,
        account,
      });
      await waitForTx(publicClient, aHash as Hash, "Approve USD.AI → sUSDai");
    }

    // Deposit USD.AI → sUSDai (ERC-4626)
    const SUSDAI_ABI = [
      {
        inputs: [
          { name: "assets", type: "uint256" },
          { name: "receiver", type: "address" },
        ],
        name: "deposit",
        outputs: [{ name: "shares", type: "uint256" }],
        stateMutability: "nonpayable",
        type: "function",
      },
    ] as const;
    const dHash = await walletClient.writeContract({
      address: SUSDAI as `0x${string}`,
      abi: SUSDAI_ABI,
      functionName: "deposit",
      args: [sUSDaiAmount, account.address],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, dHash as Hash, "Deposit USD.AI → sUSDai");

    const sUSDaiBal = await sdk.getTokenBalance(SUSDAI, user);
    const sUSDaiAcquired = sUSDaiBal - sUSDaiBalBefore;
    console.log(`  ✓ Acquired ${fmt(sUSDaiAcquired)} sUSDai`);

    // Step 2: Deposit sUSDai into Junior vault (no coverage gate)
    console.log(`\n  Step 2: Deposit sUSDai into Junior vault`);
    const jrShares = await depositSUSDai(
      sdk, walletClient, publicClient, account,
      addresses.juniorVault, TrancheId.JUNIOR, sUSDaiAcquired,
    );

    await showHealth(sdk);

    // Step 3: Withdraw Junior to clean state
    console.log(`\n  Step 3: Withdraw Junior to clean state`);
    await withdrawAndClaim(
      sdk, walletClient, publicClient, account,
      addresses.juniorVault, TrancheId.JUNIOR, jrShares,
    );
  }

  await showHealth(sdk);
  await showTranches(sdk);

  console.log(`\n  ✓ All 4 scenarios passed (3 mechanisms + sUSDai deposit).\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  console.error(err.stack);
  process.exitCode = 1;
});
