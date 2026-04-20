/**
 * Drain all vault shares — withdraw everything from all 3 tranches.
 * Handles cooldowns automatically (waits + claims).
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/drain-all.ts
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/drain-all.ts --dry-run
 */

import { formatUnits, decodeEventLog, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, hasFlag } from "./config";
import { TRANCHE_VAULT_ABI, ERC20_ABI } from "../abis";
import { TrancheId, CooldownType } from "../types";

function fmt(v: bigint): string {
  if (v === 0n) return "0";
  const num = Number(formatUnits(v, 18));
  if (num > 0 && num < 0.0001) return `dust(${v})`;
  return num.toFixed(6);
}

const TRANCHE_LABEL: Record<number, string> = { 0: "SENIOR", 1: "MEZZ", 2: "JUNIOR" };
const MECHANISM_NAMES: Record<number, string> = { 0: "NONE", 1: "ASSETS_LOCK", 2: "SHARES_LOCK" };

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function drainTranche(
  sdk: any,
  walletClient: any,
  publicClient: any,
  account: any,
  vaultAddr: `0x${string}`,
  trancheId: TrancheId,
  dryRun: boolean,
) {
  const label = TRANCHE_LABEL[trancheId];
  const user = account.address;

  const shares = await publicClient.readContract({
    address: vaultAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [user as `0x${string}`],
  }) as bigint;

  if (shares === 0n) {
    console.log(`  ${label}: 0 shares — skip`);
    return;
  }

  // Preview
  const preview = await sdk.previewWithdraw(trancheId, shares);
  console.log(`  ${label}: ${fmt(shares)} shares → ${MECHANISM_NAMES[preview.mechanism]} | fee=${Number(preview.feeBps)}bps | cooldown=${Number(preview.cooldownDuration)}s | net=${fmt(preview.netBaseAmount)}`);

  if (dryRun) return;

  // Simulate first
  try {
    await publicClient.simulateContract({
      address: vaultAddr,
      abi: TRANCHE_VAULT_ABI,
      functionName: "requestWithdraw",
      args: [shares, user as `0x${string}`],
      account: user as `0x${string}`,
    });
  } catch (err: any) {
    console.log(`  ${label}: ❌ simulate requestWithdraw failed:`);
    console.log(`    ${err.shortMessage || err.message}`);
    if (err.cause?.reason) console.log(`    reason: ${err.cause.reason}`);
    if (err.cause?.data) console.log(`    data: ${err.cause.data}`);
    throw err;
  }

  // Request withdraw
  const hash = await walletClient.writeContract({
    address: vaultAddr,
    abi: TRANCHE_VAULT_ABI,
    functionName: "requestWithdraw",
    args: [shares, user as `0x${string}`],
    chain: walletClient.chain,
    account,
  });
  const receipt = await waitForTx(publicClient, hash as Hash, `RequestWithdraw ${label}`);

  // Parse event
  const evt = receipt.logs
    .map((log: any) => {
      try { return decodeEventLog({ abi: TRANCHE_VAULT_ABI, data: log.data, topics: log.topics }); }
      catch { return null; }
    })
    .find((e: any) => e?.eventName === "WithdrawRequested");

  if (!evt || !("args" in evt)) {
    console.log(`  ${label}: tx OK but couldn't parse event`);
    return;
  }

  const wr = (evt.args as any).result;
  const mechanism = Number(wr.appliedCooldownType);

  if (wr.isInstant) {
    console.log(`  ${label}: ✓ instant — ${fmt(wr.amountOut)} sUSDai received`);
    return;
  }

  // Wait for cooldown
  const cooldownSec = Number(preview.cooldownDuration);
  console.log(`  ${label}: waiting ${cooldownSec + 10}s for cooldown...`);
  await sleep((cooldownSec + 10) * 1000);

  // Claim with simulation
  if (mechanism === CooldownType.SHARES_LOCK) {
    console.log(`  ${label}: simulating SHARES_LOCK claim #${wr.cooldownId}...`);
    try {
      await publicClient.simulateContract({
        address: vaultAddr, abi: TRANCHE_VAULT_ABI, functionName: "claimSharesWithdraw",
        args: [wr.cooldownId], account: user as `0x${string}`,
      });
    } catch (err: any) {
      console.log(`  ${label}: ❌ simulate claimSharesWithdraw failed:`);
      console.log(`    ${err.shortMessage || err.message}`);
      if (err.cause?.reason) console.log(`    reason: ${err.cause.reason}`);
      if (err.cause?.data) console.log(`    data: ${err.cause.data}`);
      throw err;
    }
    const cHash = await walletClient.writeContract({
      address: vaultAddr, abi: TRANCHE_VAULT_ABI, functionName: "claimSharesWithdraw",
      args: [wr.cooldownId], chain: walletClient.chain, account,
    });
    await waitForTx(publicClient, cHash as Hash, `ClaimSharesWithdraw ${label}`);
  } else {
    console.log(`  ${label}: simulating ASSETS_LOCK claim #${wr.cooldownId}...`);
    try {
      await publicClient.simulateContract({
        address: vaultAddr, abi: TRANCHE_VAULT_ABI, functionName: "claimWithdraw",
        args: [wr.cooldownId, wr.cooldownHandler as `0x${string}`], account: user as `0x${string}`,
      });
    } catch (err: any) {
      console.log(`  ${label}: ❌ simulate claimWithdraw failed:`);
      console.log(`    ${err.shortMessage || err.message}`);
      if (err.cause?.reason) console.log(`    reason: ${err.cause.reason}`);
      if (err.cause?.data) console.log(`    data: ${err.cause.data}`);
      throw err;
    }
    const cHash = await walletClient.writeContract({
      address: vaultAddr, abi: TRANCHE_VAULT_ABI, functionName: "claimWithdraw",
      args: [wr.cooldownId, wr.cooldownHandler as `0x${string}`], chain: walletClient.chain, account,
    });
    await waitForTx(publicClient, cHash as Hash, `ClaimWithdraw ${label}`);
  }
  console.log(`  ${label}: ✓ claim complete`);
}

async function main() {
  const dryRun = hasFlag(process.argv.slice(2), "--dry-run");

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;

  console.log(`\n  ═══ Drain All Vaults ═══`);
  console.log(`  User: ${user}`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  // Show current state
  const health = await sdk.getProtocolHealth();
  console.log(`  Protocol: Sr=${fmt(health.seniorTVL)} Mz=${fmt(health.mezzTVL)} Jr=${fmt(health.juniorTVL)} | paused=${health.shortfallPaused}\n`);

  // Check pending cooldowns first
  const pending = await sdk.getUserWithdrawRequests(user);
  if (pending.length > 0) {
    console.log(`  ⚠ ${pending.length} pending cooldown(s) found:`);
    for (const pw of pending) {
      console.log(`    #${pw.requestId} | ${fmt(pw.amount)} | claimable=${pw.isClaimable} | remaining=${pw.timeRemaining}s | handler=${pw.handler.slice(0, 10)}...`);
    }

    if (!dryRun) {
      // Claim any that are ready
      for (const pw of pending) {
        if (!pw.isClaimable) {
          console.log(`    #${pw.requestId}: not claimable yet, waiting ${Number(pw.timeRemaining) + 10}s...`);
          await sleep((Number(pw.timeRemaining) + 10) * 1000);
        }

        // Determine if SHARES_LOCK or ASSETS_LOCK by checking handler
        const sharesHandler = addresses.sharesCooldown?.toLowerCase();
        const handlerLower = pw.handler.toLowerCase();

        if (sharesHandler && handlerLower === sharesHandler) {
          const vaultToken = pw.token as `0x${string}`;
          console.log(`    Simulating SHARES_LOCK #${pw.requestId}...`);
          try {
            await publicClient.simulateContract({
              address: vaultToken, abi: TRANCHE_VAULT_ABI, functionName: "claimSharesWithdraw",
              args: [pw.requestId], account: account.address as `0x${string}`,
            });
          } catch (err: any) {
            console.log(`    ❌ simulate failed: ${err.shortMessage || err.message}`);
            if (err.cause?.reason) console.log(`    reason: ${err.cause.reason}`);
            if (err.cause?.data) console.log(`    data: ${err.cause.data}`);
            continue;
          }
          console.log(`    Claiming SHARES_LOCK #${pw.requestId} via vault ${vaultToken.slice(0, 10)}...`);
          const cHash = await walletClient.writeContract({
            address: vaultToken, abi: TRANCHE_VAULT_ABI, functionName: "claimSharesWithdraw",
            args: [pw.requestId], chain: walletClient.chain, account,
          });
          await waitForTx(publicClient, cHash as Hash, `ClaimSharesWithdraw #${pw.requestId}`);
        } else {
          const vaultAddr = addresses.seniorVault as `0x${string}`;
          console.log(`    Simulating ASSETS_LOCK #${pw.requestId}...`);
          try {
            await publicClient.simulateContract({
              address: vaultAddr, abi: TRANCHE_VAULT_ABI, functionName: "claimWithdraw",
              args: [pw.requestId, pw.handler as `0x${string}`], account: account.address as `0x${string}`,
            });
          } catch (err: any) {
            console.log(`    ❌ simulate failed: ${err.shortMessage || err.message}`);
            if (err.cause?.reason) console.log(`    reason: ${err.cause.reason}`);
            if (err.cause?.data) console.log(`    data: ${err.cause.data}`);
            continue;
          }
          console.log(`    Claiming ASSETS_LOCK #${pw.requestId}...`);
          const cHash = await walletClient.writeContract({
            address: vaultAddr, abi: TRANCHE_VAULT_ABI, functionName: "claimWithdraw",
            args: [pw.requestId, pw.handler as `0x${string}`], chain: walletClient.chain, account,
          });
          await waitForTx(publicClient, cHash as Hash, `ClaimWithdraw #${pw.requestId}`);
        }
        console.log(`    ✓ #${pw.requestId} claimed`);
      }
    }
    console.log();
  }

  // Drain order: Senior first (always instant), then Mezz, then Junior
  // Senior first because withdrawing Sr increases coverage → better mechanism for Mz/Jr
  const tranches: [TrancheId, `0x${string}`][] = [
    [TrancheId.SENIOR, addresses.seniorVault as `0x${string}`],
    [TrancheId.MEZZ, addresses.mezzVault as `0x${string}`],
    [TrancheId.JUNIOR, addresses.juniorVault as `0x${string}`],
  ];

  console.log(`  ─── Withdrawing ───`);
  for (const [trancheId, vaultAddr] of tranches) {
    try {
      await drainTranche(sdk, walletClient, publicClient, account, vaultAddr, trancheId, dryRun);
    } catch (err: any) {
      console.log(`  ${TRANCHE_LABEL[trancheId]}: ❌ ${err.shortMessage || err.message}`);
    }
  }

  // Final state
  console.log();
  const after = await sdk.getProtocolHealth();
  console.log(`  After: Sr=${fmt(after.seniorTVL)} Mz=${fmt(after.mezzTVL)} Jr=${fmt(after.juniorTVL)} | total=${fmt(after.totalTVL)}`);

  const portfolio = await sdk.getUserPortfolio(user);
  console.log(`  Shares: Sr=${fmt(portfolio.senior.shares)} Mz=${fmt(portfolio.mezz.shares)} Jr=${fmt(portfolio.junior.shares)}`);
  console.log(`\n  Done.\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
