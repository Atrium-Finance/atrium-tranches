/**
 * Withdraw flow — request withdraw, claim cooldowns.
 *
 * Usage:
 *   # Request withdraw (specific shares):
 *   npx tsx lib/scripts/withdraw-flow.ts --tranche SENIOR --shares 100
 *
 *   # Request withdraw ALL of user's shares in a tranche:
 *   npx tsx lib/scripts/withdraw-flow.ts --tranche JUNIOR --all
 *
 *   # Claim ERC20Cooldown (ASSETS_LOCK — sUSDai):
 *   npx tsx lib/scripts/withdraw-flow.ts --claim --cooldown-id 1 --tranche SENIOR
 *
 *   # Claim SharesCooldown (SHARES_LOCK):
 *   npx tsx lib/scripts/withdraw-flow.ts --claim-shares --cooldown-id 1 --tranche JUNIOR
 *
 *   Add --dry-run to preview without sending tx.
 *
 * Env: ARB_RPC_URL, PRIVATE_KEY
 */

import { parseUnits, formatUnits, decodeEventLog, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, hasFlag, parseTranche } from "./config";
import { TRANCHE_VAULT_ABI } from "../abis";
import { TrancheId } from "../types";

const MECHANISM_NAMES: Record<number, string> = {
  0: "NONE (instant)",
  1: "ASSETS_LOCK",
  2: "SHARES_LOCK",
};

// ═══════════════════════════════════════════════════════════════════
//  Request Withdraw
// ═══════════════════════════════════════════════════════════════════

async function requestWithdraw() {
  const args = process.argv.slice(2);
  const tranche = parseTranche(parseFlag(args, "--tranche") ?? "SENIOR");
  const all = hasFlag(args, "--all");
  const sharesArg = parseFlag(args, "--shares");
  const dryRun = hasFlag(args, "--dry-run");

  // Validate input — either --all or --shares must be specified
  if (!all && !sharesArg) {
    throw new Error("Provide either --shares <amount> or --all");
  }
  if (all && sharesArg) {
    throw new Error("Use either --shares or --all, not both");
  }

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;

  // Determine withdraw amount: --all reads the user's full balance, else --shares
  const shareBalance = await sdk.getShareBalance(tranche, user);
  let withdrawShares: bigint;
  if (all) {
    if (shareBalance === 0n) throw new Error(`No ${tranche} shares to withdraw`);
    withdrawShares = shareBalance;
    console.log(`\n  Withdraw ALL — ${tranche}`);
    console.log(`  User:    ${user}`);
    console.log(`  Shares:  ${formatUnits(withdrawShares, 18)} (full balance)`);
  } else {
    withdrawShares = parseUnits(sharesArg!, 18);
    console.log(`\n  Withdraw Flow — ${tranche}`);
    console.log(`  User:    ${user}`);
    console.log(`  Shares:  ${sharesArg}`);
  }
  console.log(`  Output:  sUSDai (underlying)\n`);

  // 1. Check balance
  console.log(`  Share balance: ${formatUnits(shareBalance, 18)}`);
  if (shareBalance < withdrawShares) throw new Error(`Insufficient shares`);

  // 2. Preview
  const previewAssets = await sdk.previewRedeem(tranche, withdrawShares);
  console.log(`  Preview value: ${formatUnits(previewAssets, 18)} USD.AI (base)`);

  // 3. Preview withdraw (mechanism, fee, cooldown)
  const preview = await sdk.previewWithdraw(tranche, withdrawShares);
  console.log(`\n  Mechanism: ${MECHANISM_NAMES[preview.mechanism] ?? preview.mechanism}`);
  console.log(`  Fee:       ${Number(preview.feeBps) / 100}% (${formatUnits(preview.feeAmount, 18)})`);
  console.log(`  Cooldown:  ${Number(preview.cooldownDuration) / 3600}h`);
  console.log(`  Net base:  ${formatUnits(preview.netBaseAmount, 18)} USD.AI`);
  console.log(`  Net out:   ${formatUnits(preview.outputTokenAmount, 18)} sUSDai`);

  // 4. Pending withdraws
  const pending = await sdk.getUserWithdrawRequests(user);
  if (pending.length > 0) {
    console.log(`\n  Pending withdraws: ${pending.length}`);
    for (const pw of pending) {
      console.log(`    #${pw.requestId} | ${formatUnits(pw.amount, 18)} | claimable=${pw.isClaimable}`);
    }
  }

  if (dryRun) {
    console.log(`\n  Dry run — no tx sent.\n`);
    return;
  }

  // 5. Request withdraw
  const vaultAddr = (
    tranche === TrancheId.SENIOR ? addresses.seniorVault : addresses.juniorVault
  ) as `0x${string}`;

  console.log(`\n  Requesting withdraw...`);
  const hash = await walletClient.writeContract({
    address: vaultAddr,
    abi: TRANCHE_VAULT_ABI,
    functionName: "requestWithdraw",
    args: [withdrawShares, user],
    chain: walletClient.chain,
    account,
  });
  const receipt = await waitForTx(publicClient, hash as Hash, "RequestWithdraw");

  // 6. Parse WithdrawRequested event
  const withdrawEvent = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: TRANCHE_VAULT_ABI, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e?.eventName === "WithdrawRequested");

  if (withdrawEvent && "args" in withdrawEvent) {
    const wr = (withdrawEvent.args as any).result;
    console.log(`\n  Result:`);
    console.log(`    Instant:    ${wr.isInstant}`);
    console.log(`    AmountOut:  ${formatUnits(wr.amountOut, 18)}`);
    console.log(`    Mechanism:  ${MECHANISM_NAMES[Number(wr.appliedCooldownType)] ?? wr.appliedCooldownType}`);
    console.log(`    CooldownId: ${wr.cooldownId}`);
    console.log(`    Fee:        ${formatUnits(wr.feeAmount, 18)}`);

    // Next action hint
    if (wr.isInstant) {
      console.log(`\n  Withdraw complete. sUSDai received.\n`);
    } else if (Number(wr.appliedCooldownType) === 2) {
      console.log(`\n  Next: --claim-shares --cooldown-id ${wr.cooldownId} --tranche ${tranche}\n`);
    } else {
      console.log(`\n  Next: --claim --cooldown-id ${wr.cooldownId} --tranche ${tranche}\n`);
    }
  } else {
    console.log(`\n  Tx confirmed. Check pending withdraws for status.\n`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Claim ERC20Cooldown (ASSETS_LOCK)
// ═══════════════════════════════════════════════════════════════════

async function claimCooldown() {
  const args = process.argv.slice(2);
  const tranche = parseTranche(parseFlag(args, "--tranche") ?? "SENIOR");
  const cooldownId = parseFlag(args, "--cooldown-id");
  const dryRun = hasFlag(args, "--dry-run");

  if (!cooldownId) throw new Error("--cooldown-id required");

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;

  console.log(`\n  Claim Cooldown — ${tranche} #${cooldownId}`);

  const requests = await sdk.getUserWithdrawRequests(user);
  const claimable = requests.filter((r) => r.isClaimable);
  console.log(`  Requests: ${requests.length} total, ${claimable.length} claimable`);
  for (const cw of claimable) {
    console.log(`    #${cw.requestId} | ${formatUnits(cw.amount, 18)} | handler=${cw.handler.slice(0, 10)}...`);
  }

  if (dryRun) {
    console.log(`\n  Dry run.\n`);
    return;
  }

  const target = claimable.find((c) => c.requestId === BigInt(cooldownId));
  if (!target) throw new Error(`Cooldown #${cooldownId} not found or not claimable`);

  const vaultAddr = (
    tranche === TrancheId.SENIOR ? addresses.seniorVault : addresses.juniorVault
  ) as `0x${string}`;

  console.log(`  Claiming #${cooldownId}...`);
  const hash = await walletClient.writeContract({
    address: vaultAddr,
    abi: TRANCHE_VAULT_ABI,
    functionName: "claimWithdraw",
    args: [BigInt(cooldownId), target.handler as `0x${string}`],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, "ClaimWithdraw");
  console.log(`  Done.\n`);
}

// ═══════════════════════════════════════════════════════════════════
//  Claim SharesCooldown (SHARES_LOCK)
// ═══════════════════════════════════════════════════════════════════

async function claimShares() {
  const args = process.argv.slice(2);
  const tranche = parseTranche(parseFlag(args, "--tranche") ?? "SENIOR");
  const cooldownId = parseFlag(args, "--cooldown-id");
  const dryRun = hasFlag(args, "--dry-run");

  if (!cooldownId) throw new Error("--cooldown-id required");

  const { publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();

  console.log(`\n  Claim Shares Lock — ${tranche} #${cooldownId}`);

  if (dryRun) {
    console.log(`  Dry run.\n`);
    return;
  }

  const vaultAddr = (
    tranche === TrancheId.SENIOR ? addresses.seniorVault : addresses.juniorVault
  ) as `0x${string}`;

  console.log(`  Claiming shares cooldown #${cooldownId}...`);
  const hash = await walletClient.writeContract({
    address: vaultAddr,
    abi: TRANCHE_VAULT_ABI,
    functionName: "claimSharesWithdraw",
    args: [BigInt(cooldownId)],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, "ClaimSharesWithdraw");
  console.log(`  Done.\n`);
}

// ═══════════════════════════════════════════════════════════════════
//  Entry
// ═══════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);

if (hasFlag(args, "--claim-shares")) {
  claimShares().catch((e) => {
    console.error(`\n  Error: ${e.message}\n`);
    process.exitCode = 1;
  });
} else if (hasFlag(args, "--claim")) {
  claimCooldown().catch((e) => {
    console.error(`\n  Error: ${e.message}\n`);
    process.exitCode = 1;
  });
} else {
  requestWithdraw().catch((e) => {
    console.error(`\n  Error: ${e.message}\n`);
    process.exitCode = 1;
  });
}
