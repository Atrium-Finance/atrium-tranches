/**
 * Claim accumulated reserve (fees + gain cuts) to a recipient (governance only).
 *
 * Usage:
 *   npx tsx lib/scripts/claim-reserve.ts --recipient 0x...
 *   npx tsx lib/scripts/claim-reserve.ts --recipient 0x... --dry-run
 *
 * Env: ARB_RPC_URL, PRIVATE_KEY
 */

import { formatUnits, isAddress, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, hasFlag, parseFlag } from "./config";

const CDO_ABI = [
  { inputs: [{ name: "recipient", type: "address" }], name: "claimReserve", outputs: [{ name: "amountOut", type: "uint256" }], stateMutability: "nonpayable", type: "function" },
] as const;

const ACCOUNTING_ABI = [
  { inputs: [], name: "s_reserveTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = hasFlag(args, "--dry-run");
  const recipientArg = parseFlag(args, "--recipient");

  if (!recipientArg || !isAddress(recipientArg)) {
    throw new Error("--recipient <address> required");
  }
  const recipient = recipientArg as `0x${string}`;

  const { publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();

  const cdoAddr = addresses.primeCDO as `0x${string}`;
  const accountingAddr = addresses.accounting as `0x${string}`;

  const reserve = await publicClient.readContract({ address: accountingAddr, abi: ACCOUNTING_ABI, functionName: "s_reserveTVL" });

  console.log(`\n  Reserve TVL: ${formatUnits(reserve, 18)} USD.AI`);
  console.log(`  Owner:       ${account.address}`);
  console.log(`  Recipient:   ${recipient}`);

  if (reserve === 0n) {
    console.log(`  No reserve to claim.\n`);
    return;
  }

  if (dryRun) {
    console.log(`  Dry run — no tx sent.\n`);
    return;
  }

  console.log(`  Claiming reserve...`);
  const hash = await walletClient.writeContract({
    address: cdoAddr, abi: CDO_ABI, functionName: "claimReserve",
    args: [recipient],
    chain: walletClient.chain, account,
  });
  await waitForTx(publicClient, hash as Hash, "claimReserve");

  const after = await publicClient.readContract({ address: accountingAddr, abi: ACCOUNTING_ABI, functionName: "s_reserveTVL" });
  console.log(`  Reserve after: ${formatUnits(after, 18)}`);
  console.log(`  Done. sUSDai sent to ${recipient}.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
