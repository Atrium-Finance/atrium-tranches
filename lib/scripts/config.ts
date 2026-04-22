/**
 * Shared config for all SDK scripts.
 * Reads deployed addresses from deploy/deployed.json.
 */

import { createWalletClient, createPublicClient, http, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { PrimeVaultsSDK } from "../PrimeVaultsSDK";
import { TrancheId } from "../types";
import type { ContractAddresses } from "../types";
import "dotenv/config";

export const USDAI = "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF";
export const SUSDAI = "0x0B2b2B2076d95dda7817e785989fE353fe955ef9";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function loadDeployedAddresses(): ContractAddresses {
  try {
    const d = require("../../deploy/deployed.json");
    return { ...d, outputToken: SUSDAI };
  } catch {
    throw new Error("deploy/deployed.json not found — run deploy scripts first");
  }
}

export function createSDK() {
  const rpcUrl = requireEnv("ARB_RPC_URL");
  const addresses = loadDeployedAddresses();

  const sdk = new PrimeVaultsSDK({ rpcUrl, chain: arbitrum, addresses });
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });

  return { sdk, publicClient, rpcUrl, addresses };
}

export function createWallet() {
  const rpcUrl = requireEnv("ARB_RPC_URL");
  const privateKey = requireEnv("PRIVATE_KEY");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http(rpcUrl) });
  return { account, walletClient };
}

export async function waitForTx(publicClient: PublicClient, hash: Hash, label: string) {
  console.log(`  ... ${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`${label} reverted!`);
  console.log(`  OK  ${label} confirmed (block ${receipt.blockNumber})`);
  return receipt;
}

export function parseFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const TRANCHE_NAME_MAP: Record<string, TrancheId> = {
  SENIOR: TrancheId.SENIOR,
  MEZZ: TrancheId.MEZZ,
  JUNIOR: TrancheId.JUNIOR,
};

export function parseTranche(str: string): TrancheId {
  const result = TRANCHE_NAME_MAP[str.toUpperCase()];
  if (result === undefined) throw new Error(`Invalid tranche: ${str}. Use SENIOR, MEZZ, or JUNIOR`);
  return result;
}

/**
 * # Dashboard (chỉ cần RPC, không cần key)                                             
  npx tsx lib/scripts/dashboard.ts                                                     
  npx tsx lib/scripts/dashboard.ts --user 0x...                                        
  npx tsx lib/scripts/dashboard.ts --rebalance                                         
                                                                                       
  # Deposit (any tranche)
  npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 0.1
  npx tsx lib/scripts/deposit-flow.ts --tranche MEZZ --amount 0.1 --dry-run
  npx tsx lib/scripts/deposit-flow.ts --tranche JUNIOR --amount 0.1

  # Withdraw
  npx tsx lib/scripts/withdraw-flow.ts --tranche SENIOR --shares 100
  npx tsx lib/scripts/withdraw-flow.ts --tranche JUNIOR --shares 0.05 --dry-run
                                                                                       
  # Claim (sau cooldown)                                                               
  npx tsx lib/scripts/withdraw-flow.ts --claim --cooldown-id 1 --tranche SENIOR        
  npx tsx lib/scripts/withdraw-flow.ts --claim-shares --cooldown-id 1 --tranche MEZZ   
           
  ⏺ # ERC20Cooldown (ASSETS_LOCK) — default 3 days
  npx tsx lib/scripts/set-cooldown.ts --handler erc20 --duration 3d                    
                                                                                       
  # SharesCooldown (SHARES_LOCK) — default 7 days                                      
  npx tsx lib/scripts/set-cooldown.ts --handler shares --duration 7d                   
                                                                                       
  # Set to 0 for testing (instant claim)                                               
  npx tsx lib/scripts/set-cooldown.ts --tranche JUNIOR --assets-lock 0s --shares-lock 0s
 */
