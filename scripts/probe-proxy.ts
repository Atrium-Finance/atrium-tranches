/**
 * Inspect the sUSDai proxy: dump bytecode size, search for the
 * DisabledImplementation() selector in its code, and capture the raw
 * revert return-data when calling a benign view.
 */
import "dotenv/config";
import { network } from "hardhat";

const PROXY = "0x0b2b2B2076D95DDA7817e785989fE353fe955ef9" as `0x${string}`;
const IMPL  = "0x5f02c1bec4ad5de9b7abf999c1f0854d4836a049" as `0x${string}`;
const DISABLED_IMPL_SEL = "f12dfb69"; // DisabledImplementation()

async function main() {
  const n: any = network as any;
  const conn = await (n.getOrCreate ? n.getOrCreate("forkArbitrum") : n.connect("forkArbitrum"));
  const pub = await conn.viem.getPublicClient();

  const block = await pub.getBlock();
  console.log(`Fork block: ${block.number}\n`);

  for (const [label, addr] of [["PROXY", PROXY], ["IMPL", IMPL]] as const) {
    const code = await pub.getCode({ address: addr });
    const codeStr = code ?? "0x";
    const containsDisabled = codeStr.toLowerCase().includes(DISABLED_IMPL_SEL);
    console.log(`${label} ${addr}`);
    console.log(`  code size: ${(codeStr.length - 2) / 2} bytes`);
    console.log(`  contains DisabledImplementation selector (${DISABLED_IMPL_SEL}): ${containsDisabled}`);
    console.log();
  }

  // Try a benign call against the proxy and capture raw revert data.
  console.log("Calling proxy.asset() and capturing raw revert data...");
  try {
    const out = await pub.call({ to: PROXY, data: "0x38d52e0f" });
    console.log("  did not revert. data:", out.data);
  } catch (err: any) {
    // viem wraps the raw revert in cause chain
    let cur = err;
    const stops: string[] = [];
    while (cur && stops.length < 6) {
      const m = String(cur.message ?? "");
      const sig = m.match(/0x[0-9a-f]{8,}/i);
      if (sig) stops.push(sig[0]);
      cur = cur.cause;
    }
    console.log("  found return-data candidates:", stops);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
