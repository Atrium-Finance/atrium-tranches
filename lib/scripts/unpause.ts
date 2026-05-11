/**
 * Unpause the protocol after a manual triggerShortfallPause() by guardian.
 *
 * Usage:
 *   npx tsx lib/scripts/unpause.ts
 */

import { type Hash } from "viem";
import { createSDK, createWallet, waitForTx } from "./config";

const CDO_ABI = [
  { inputs: [], name: "unpauseShortfall", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "s_shortfallPaused", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const { publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const cdoAddr = addresses.primeCDO as `0x${string}`;

  const paused = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" });
  console.log(`\n  CDO:    ${cdoAddr}`);
  console.log(`  Paused: ${paused}\n`);

  if (paused) {
    console.log(`  Unpausing...`);
    const hash = await walletClient.writeContract({ address: cdoAddr, abi: CDO_ABI, functionName: "unpauseShortfall", chain: walletClient.chain, account });
    await waitForTx(publicClient, hash as Hash, "unpauseShortfall");
  } else {
    console.log(`  Already unpaused.`);
  }

  const afterPaused = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" });
  console.log(`\n  After:`);
  console.log(`  Paused: ${afterPaused}`);
  console.log(`  Done.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
