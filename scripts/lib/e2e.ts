import { network } from "hardhat";
import { readFileSync } from "node:fs";

/**
 * Shared helpers for the E2E scripts (Hardhat 3 connection model).
 */

/** Connect to the target network (default: arbitrum). */
export async function connect() {
  const name = process.env.ATRIUM_NETWORK ?? "arbitrum";
  return await (network as any).connect(name);
}

/** Load the Ignition deployment's address book. */
export function loadAddresses(chainId = "42161"): Record<string, string> {
  const path = `ignition/deployments/chain-${chainId}/deployed_addresses.json`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No deployment at ${path}. Run \`pnpm deploy:mainnet\` first.`);
  }
  return JSON.parse(raw);
}

/** First address whose key ends with one of the given suffixes. */
export function pick(addrs: Record<string, string>, ...suffixes: string[]): string {
  for (const s of suffixes) {
    const key = Object.keys(addrs).find((k) => k.endsWith(s));
    if (key) return addrs[key];
  }
  throw new Error(`address [${suffixes.join(", ")}] not found in deployment`);
}

/** Load the `Atrium` parameter block (external token addresses, etc.). */
export function loadParams(file = "ignition/parameters/mainnet.json"): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8")).Atrium;
}
