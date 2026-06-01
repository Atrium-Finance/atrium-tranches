/**
 * Probe sUSDai proxy + implementation for clues about ownership / state.
 * Runs against the live `forkArbitrum` connection.
 */
import "dotenv/config";
import { network } from "hardhat";
import { encodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";

const PROXY = "0x0b2b2B2076D95DDA7817e785989fE353fe955ef9" as `0x${string}`;
const IMPL  = "0x5f02c1bec4ad5de9b7abf999c1f0854d4836a049" as `0x${string}`;

// Selectors to probe — common functions on ERC-4626 / Ownable / AccessControl.
const PROBES = [
  { name: "name()",                        sel: "0x06fdde03", outType: "string"  },
  { name: "symbol()",                      sel: "0x95d89b41", outType: "string"  },
  { name: "decimals()",                    sel: "0x313ce567", outType: "uint8"   },
  { name: "asset()",                       sel: "0x38d52e0f", outType: "address" },
  { name: "totalSupply()",                 sel: "0x18160ddd", outType: "uint256" },
  { name: "totalAssets()",                 sel: "0x01e1d114", outType: "uint256" },
  { name: "owner()",                       sel: "0x8da5cb5b", outType: "address" },
  { name: "implementation()",              sel: "0x5c60da1b", outType: "address" },
  { name: "paused()",                      sel: "0x5c975abb", outType: "bool"    },
  { name: "DOMAIN_SEPARATOR()",            sel: "0x3644e515", outType: "bytes32" },
  { name: "version()",                     sel: "0x54fd4d50", outType: "string"  },
  { name: "VERSION()",                     sel: "0xffa1ad74", outType: "string"  },
  { name: "lastDistributionTimestamp()",   sel: "0x18db0e6d", outType: "uint256" },
  { name: "unvestedAmount()",              sel: "0x0e72ed5f", outType: "uint256" },
  { name: "DEFAULT_ADMIN_ROLE()",          sel: "0xa217fddf", outType: "bytes32" },
  { name: "UPGRADE_INTERFACE_VERSION()",   sel: "0xad3cb1cc", outType: "string"  },
];

async function main() {
  const n: any = network as any;
  const conn = await (n.getOrCreate ? n.getOrCreate("forkArbitrum") : n.connect("forkArbitrum"));
  const pub = await conn.viem.getPublicClient();

  const block = await pub.getBlock();
  console.log(`Fork block: ${block.number}\n`);

  async function probe(target: `0x${string}`, label: string) {
    console.log(`===== ${label} (${target}) =====`);
    for (const p of PROBES) {
      try {
        const result = await pub.call({ to: target, data: p.sel as `0x${string}` });
        if (!result.data || result.data === "0x") {
          console.log(`  ${p.name.padEnd(34)} → empty`);
          continue;
        }
        try {
          const decoded = decodeAbiParameters(parseAbiParameters(p.outType), result.data);
          let v = String(decoded[0]);
          if (v.length > 80) v = v.slice(0, 80) + "...";
          console.log(`  ${p.name.padEnd(34)} → ${v}`);
        } catch {
          console.log(`  ${p.name.padEnd(34)} → raw ${result.data.slice(0, 40)}...`);
        }
      } catch (err: any) {
        const m = String(err?.message ?? err);
        const sig = m.match(/0x[0-9a-f]{8}/i);
        console.log(`  ${p.name.padEnd(34)} ✗ revert ${sig ? sig[0] : "(no data)"}`);
      }
    }
    console.log();
  }

  await probe(PROXY, "PROXY");
  await probe(IMPL,  "IMPLEMENTATION");

  // ---- ERC-1967 storage slots ----
  console.log("===== Proxy storage slots =====");
  const slots = {
    "ERC-1967 implementation": "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    "ERC-1967 admin":          "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
    "ERC-1967 beacon":         "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    "EIP-1822 proxiableUUID":  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
  };
  for (const [name, slot] of Object.entries(slots)) {
    const v = await pub.getStorageAt({ address: PROXY, slot: slot as `0x${string}` });
    console.log(`  ${name.padEnd(34)} ${v}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
