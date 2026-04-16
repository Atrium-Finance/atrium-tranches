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
 *   6. Final dashboard
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/e2e-test.ts
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/e2e-test.ts --amount 10
 */

import { parseUnits, formatUnits, decodeEventLog, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, USDAI } from "./config";
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
  console.log(`  ║  PrimeVaults E2E Mainnet Test (3 mechanisms)           ║`);
  console.log(`  ╚═══════════════════════════════════════════════════════╝`);
  console.log(`  User:        ${user}`);
  console.log(`  Base unit:   ${baseStr} USD.AI\n`);
  console.log(`  Scenarios:`);
  console.log(`    A) NONE        — deposit Sr=1×, Mz=1×, Jr=1× (cs=300%, cm=200%)`);
  console.log(`    B) ASSETS_LOCK — deposit Sr=7×, Mz=1×, Jr=3× (cs=157%, cm=400%)`);
  console.log(`    C) SHARES_LOCK — deposit Sr=8×, Mz=1×, Jr=1× (cs=125%, cm=200%)`);

  // Check balance — need ~22× base for all 3 phases (worst case Phase B+C)
  const required = base * 25n;
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

  await showHealth(sdk);
  await showTranches(sdk);

  console.log(`\n  ✓ All 3 mechanism scenarios passed.\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  console.error(err.stack);
  process.exitCode = 1;
});
