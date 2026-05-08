/**
 * Deposit USD.AI into any tranche (Senior, Junior).
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 100
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche JUNIOR --amount 25 --dry-run
 */

import { parseUnits, formatUnits, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, hasFlag, parseTranche, USDAI } from "./config";
import { TRANCHE_VAULT_ABI, ERC20_ABI } from "../abis";
import { TrancheId } from "../types";

const UINT256_MAX = 2n ** 256n - 1n;

function fmtPct(val: bigint): string {
  if (val >= UINT256_MAX) return "∞";
  return `${Number(formatUnits(val, 16)).toFixed(2)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const tranche = parseTranche(parseFlag(args, "--tranche") ?? "SENIOR");
  const amount = parseFlag(args, "--amount") ?? "1";
  const dryRun = hasFlag(args, "--dry-run");

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;
  const depositAmount = parseUnits(amount, 18);

  console.log(`\n  Deposit Flow — ${tranche}`);
  console.log(`  User:    ${user}`);
  console.log(`  Amount:  ${amount} USD.AI\n`);

  // 1. Check balance
  const balance = await sdk.getTokenBalance(USDAI, user);
  console.log(`  USD.AI balance: ${formatUnits(balance, 18)}`);
  if (balance < depositAmount) throw new Error(`Insufficient USD.AI`);

  // 2. Preview
  const preview = await sdk.previewDeposit(tranche, depositAmount);
  console.log(`  Preview shares:  ${formatUnits(preview.shares, 18)}`);

  // 3. Protocol health
  const health = await sdk.getProtocolHealth();
  console.table(health);
  console.log(`  Coverage Sr: ${fmtPct(health.coverageSenior)}`);
  if (health.shortfallPaused) throw new Error("Protocol is shortfall paused");

  if (dryRun) {
    console.log(`\n  Dry run — no tx sent.\n`);
    return;
  }

  // 4. Approve if needed
  const vaultAddr = tranche === TrancheId.SENIOR ? addresses.seniorVault : addresses.juniorVault;
  const allowance = await sdk.getTokenAllowance(USDAI, user, vaultAddr);
  if (allowance < depositAmount) {
    console.log(`\n  Approving USD.AI...`);
    const hash = await walletClient.writeContract({
      address: USDAI as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddr as `0x${string}`, depositAmount],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, hash as Hash, "Approve");
  }

  // 5. Deposit
  const sharesBefore = await sdk.getShareBalance(tranche, user);
  console.log(`  Depositing ${amount} USD.AI into ${tranche}...`);
  const hash = await walletClient.writeContract({
    address: vaultAddr as `0x${string}`,
    abi: TRANCHE_VAULT_ABI,
    functionName: "deposit",
    args: [depositAmount, user],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, "Deposit");

  // 6. Verify
  const sharesAfter = await sdk.getShareBalance(tranche, user);
  console.log(`\n  Shares received: ${formatUnits(sharesAfter - sharesBefore, 18)}`);
  console.log(`  Done.\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
