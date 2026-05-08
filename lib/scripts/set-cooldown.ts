/**
 * Update cooldown duration via RedemptionPolicy (single source of truth).
 *
 * Durations are now managed in RedemptionPolicy.MechanismConfig, NOT in the
 * cooldown handler contracts (ERC20Cooldown/SharesCooldown no longer store durations).
 *
 * Usage:
 *   npx tsx lib/scripts/set-cooldown.ts --tranche JUNIOR --assets-lock 5d --shares-lock 10d
 *   npx tsx lib/scripts/set-cooldown.ts --tranche JUNIOR --assets-lock 0s --shares-lock 0s  # testing
 *
 * Env: ARB_RPC_URL, PRIVATE_KEY
 */

import { type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, parseTranche } from "./config";

const REDEMPTION_POLICY_ABI = [
  {
    inputs: [{ name: "tranche", type: "uint8" }],
    name: "s_mechanismConfig",
    outputs: [
      { name: "instantFeeBps", type: "uint256" },
      { name: "assetsLockFeeBps", type: "uint256" },
      { name: "assetsLockDuration", type: "uint256" },
      { name: "sharesLockFeeBps", type: "uint256" },
      { name: "sharesLockDuration", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "tranche", type: "uint8" },
      {
        name: "config_",
        type: "tuple",
        components: [
          { name: "instantFeeBps", type: "uint256" },
          { name: "assetsLockFeeBps", type: "uint256" },
          { name: "assetsLockDuration", type: "uint256" },
          { name: "sharesLockFeeBps", type: "uint256" },
          { name: "sharesLockDuration", type: "uint256" },
        ],
      },
    ],
    name: "setMechanismConfig",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function parseDuration(input: string): bigint {
  const match = input.match(/^(\d+)(d|h|m|s)?$/);
  if (!match) throw new Error(`Invalid duration: ${input}. Use: 3d, 12h, 30m, 300s, or 300`);
  const value = BigInt(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = { d: 86400n, h: 3600n, m: 60n, s: 1n }[unit]!;
  return value * multiplier;
}

function fmtDur(seconds: bigint): string {
  const s = Number(seconds);
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400}d`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

async function main() {
  const args = process.argv.slice(2);
  const trancheStr = parseFlag(args, "--tranche");
  if (!trancheStr) throw new Error("--tranche required: SENIOR or JUNIOR");
  const tranche = parseTranche(trancheStr);
  const assetsLockStr = parseFlag(args, "--assets-lock");
  const sharesLockStr = parseFlag(args, "--shares-lock");

  if (!assetsLockStr && !sharesLockStr) {
    throw new Error("At least one of --assets-lock or --shares-lock required");
  }

  const { publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const rpAddr = addresses.redemptionPolicy as `0x${string}`;
  const trancheNum = tranche as number;

  // Read current config
  const current = await publicClient.readContract({
    address: rpAddr,
    abi: REDEMPTION_POLICY_ABI,
    functionName: "s_mechanismConfig",
    args: [trancheNum],
  });

  const [instantFeeBps, assetsLockFeeBps, assetsLockDuration, sharesLockFeeBps, sharesLockDuration] = current;

  console.log(`\n  RedemptionPolicy — ${tranche}`);
  console.log(`  ───────────────────────────────────`);
  console.log(`  Current assets lock: ${fmtDur(assetsLockDuration)} (fee: ${assetsLockFeeBps} bps)`);
  console.log(`  Current shares lock: ${fmtDur(sharesLockDuration)} (fee: ${sharesLockFeeBps} bps)`);

  // Build new config (only update what's provided, keep fees unchanged)
  const newAssetsLockDuration = assetsLockStr ? parseDuration(assetsLockStr) : assetsLockDuration;
  const newSharesLockDuration = sharesLockStr ? parseDuration(sharesLockStr) : sharesLockDuration;

  console.log(`\n  New assets lock:    ${fmtDur(newAssetsLockDuration)}`);
  console.log(`  New shares lock:    ${fmtDur(newSharesLockDuration)}\n`);

  if (newAssetsLockDuration === assetsLockDuration && newSharesLockDuration === sharesLockDuration) {
    console.log(`  No change needed.\n`);
    return;
  }

  const newConfig = {
    instantFeeBps,
    assetsLockFeeBps,
    assetsLockDuration: newAssetsLockDuration,
    sharesLockFeeBps,
    sharesLockDuration: newSharesLockDuration,
  };

  console.log(`  Updating RedemptionPolicy...`);
  const hash = await walletClient.writeContract({
    address: rpAddr,
    abi: REDEMPTION_POLICY_ABI,
    functionName: "setMechanismConfig",
    args: [trancheNum, newConfig],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, "setMechanismConfig");

  const after = await publicClient.readContract({
    address: rpAddr,
    abi: REDEMPTION_POLICY_ABI,
    functionName: "s_mechanismConfig",
    args: [trancheNum],
  });
  console.log(`  After: assets=${fmtDur(after[2])} shares=${fmtDur(after[4])}`);
  console.log(`  Done.\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
