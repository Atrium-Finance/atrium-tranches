/**
 * Map exactly which ERC-4626 / vesting functions work vs revert on
 * `0x5f02c1be...`. The error-selector match in earlier probes was
 * matching the contract address prefix (also "0x5f02c1be") — this
 * probe inspects the raw revert data byte-by-byte.
 */
import "dotenv/config";
import { network } from "hardhat";
import { encodeAbiParameters, parseAbiParameters } from "viem";

const TARGET = "0x5f02c1bec4ad5de9b7abf999c1f0854d4836a049" as `0x${string}`;
const DISABLED_IMPL_SEL = "0xf12dfb69";

const CALLS = [
  { name: "name()",                              data: "0x06fdde03" },
  { name: "symbol()",                            data: "0x95d89b41" },
  { name: "decimals()",                          data: "0x313ce567" },
  { name: "asset()",                             data: "0x38d52e0f" },
  { name: "totalSupply()",                       data: "0x18160ddd" },
  { name: "totalAssets()",                       data: "0x01e1d114" },
  { name: "paused()",                            data: "0x5c975abb" },
  { name: "DOMAIN_SEPARATOR()",                  data: "0x3644e515" },
  { name: "previewDeposit(1e18)",                data: "0xef8b30f7" + "0".repeat(63) + "0" },
  // The ERC-4626 selectors that take a uint256 arg:
  // previewDeposit(uint256) = 0xef8b30f7
  // previewMint(uint256)    = 0xb3d7f6b9
  // previewWithdraw(uint256)= 0x0a28a477
  // previewRedeem(uint256)  = 0x4cdad506
  // convertToShares(uint256)= 0xc6e6f592
  // convertToAssets(uint256)= 0x07a2d13a
  // maxDeposit(address)     = 0x402d267d
  // maxRedeem(address)      = 0xd905777e
];

// Build all uint256-arg calls with arg = 1e18
function uintCall(sel: string) {
  const arg = encodeAbiParameters(parseAbiParameters("uint256"), [10n ** 18n]);
  return sel + arg.slice(2);
}

const UINT_CALLS = [
  { name: "previewDeposit(1e18)",  data: uintCall("0xef8b30f7") },
  { name: "previewMint(1e18)",     data: uintCall("0xb3d7f6b9") },
  { name: "previewWithdraw(1e18)", data: uintCall("0x0a28a477") },
  { name: "previewRedeem(1e18)",   data: uintCall("0x4cdad506") },
  { name: "convertToShares(1e18)", data: uintCall("0xc6e6f592") },
  { name: "convertToAssets(1e18)", data: uintCall("0x07a2d13a") },
];

async function main() {
  const n: any = network as any;
  const conn = await (n.getOrCreate ? n.getOrCreate("forkArbitrum") : n.connect("forkArbitrum"));
  const pub = await conn.viem.getPublicClient();

  console.log(`Target: ${TARGET}`);
  console.log(`Block:  ${(await pub.getBlock()).number}\n`);

  async function tryCall(name: string, data: string) {
    try {
      const r = await pub.call({ to: TARGET, data: data as `0x${string}` });
      const len = r.data ? (r.data.length - 2) / 2 : 0;
      console.log(`✓ ${name.padEnd(32)} (${len} bytes returned)`);
    } catch (err: any) {
      // viem includes a `data` property somewhere in the error chain
      // with the raw revert bytes. Walk the cause chain to find it.
      let cur = err;
      let raw: string | undefined;
      while (cur) {
        if (cur.data && typeof cur.data === "string" && cur.data.startsWith("0x")) {
          raw = cur.data;
          break;
        }
        // Some viem errors expose return data under `cause.data`.
        if (cur.cause?.data && typeof cur.cause.data === "string") {
          raw = cur.cause.data;
          break;
        }
        cur = cur.cause;
      }
      const tag = raw
        ? raw.startsWith(DISABLED_IMPL_SEL)
          ? `DisabledImplementation() (${DISABLED_IMPL_SEL})`
          : `revert ${raw.slice(0, 10)} (${raw.length === 2 ? "no reason" : raw})`
        : `revert (no data captured)`;
      console.log(`✗ ${name.padEnd(32)} ${tag}`);
    }
  }

  for (const c of CALLS) await tryCall(c.name, c.data);
  for (const c of UINT_CALLS) await tryCall(c.name, c.data);
}

main().catch((e) => { console.error(e); process.exit(1); });
