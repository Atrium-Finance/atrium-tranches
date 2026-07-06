/**
 * Pre-flight check for fork tests — verifies every configured Arbitrum
 * address actually has code (or a balance, for whales) at the current
 * forked block. Run via `pnpm test:fork:check`.
 */
import "dotenv/config";
import { network } from "hardhat";
import { getAddress } from "viem";
import { ARBITRUM_ADDRESSES } from "../test/fork/helpers/addresses.js";

const ZERO = "0x0000000000000000000000000000000000000000";

async function main(): Promise<void> {
  if (process.env.FORK_TESTS !== "true") {
    // eslint-disable-next-line no-console
    console.error(
      "FORK_TESTS=true required. Use `pnpm test:fork:check`."
    );
    process.exit(1);
  }
  if (!process.env.ARBITRUM_RPC_URL) {
    // eslint-disable-next-line no-console
    console.error("ARBITRUM_RPC_URL missing — set it in .env");
    process.exit(1);
  }

  const n: any = network as any;
  const conn = await (n.getOrCreate
    ? n.getOrCreate("forkArbitrum")
    : n.connect("forkArbitrum"));
  const publicClient = await conn.viem.getPublicClient();

  // eslint-disable-next-line no-console
  console.log("Checking Arbitrum addresses...\n");

  let warnings = 0;
  let errors = 0;

  for (const [name, addr] of Object.entries(ARBITRUM_ADDRESSES) as [
    string,
    string,
  ][]) {
    if (addr === ZERO) {
      // eslint-disable-next-line no-console
      console.warn(`⚠️  ${name}: not configured (placeholder zero address)`);
      warnings++;
      continue;
    }

    try {
      const code = await publicClient.getCode({
        address: addr as `0x${string}`,
      });

      if (!code || code === "0x") {
        // Probably an EOA (whale) — check balance instead.
        const balance = await publicClient.getBalance({
          address: addr as `0x${string}`,
        });

        if (name.startsWith("whale")) {
          // eslint-disable-next-line no-console
          console.log(
            `✓ ${name}: ${addr} (EOA, balance ${balance})`
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(`✗ ${name}: ${addr} has no code on chain`);
          errors++;
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(`✓ ${name}: ${addr} (contract)`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`✗ ${name}: error checking — ${err}`);
      errors++;
    }
  }

  // ---- Forked block info ----
  // Diagnostic value: the user's choice (or default "latest") changes
  // what implementation slot resolves to. Reporting it up-front so
  // failure messages name a concrete block.
  const forkedBlock = await publicClient.getBlock();
  // eslint-disable-next-line no-console
  console.log(
    `\nForked at block ${forkedBlock.number} ` +
      `(${new Date(Number(forkedBlock.timestamp) * 1000).toISOString()})`
  );

  // ---- Functional probe: sUSDai + USDai must actually respond ----
  // The bytecode-only check above doesn't catch a proxy whose
  // implementation is disabled — every call would revert at runtime
  // even though `getCode` reports non-empty bytecode. Calling a cheap
  // ERC-4626 view here turns that latent failure into a clear
  // pre-flight error. For each broken proxy, also dump the ERC-1967
  // implementation slot so the user can verify on Arbiscan which
  // implementation contract is misbehaving.
  const ERC1967_IMPL_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

  // Use previewDeposit instead of previewRedeem — USD.AI's sUSDai on
  // Arbitrum is in a "deposit-only" pre-launch state where withdraw-side
  // selectors (previewRedeem, previewWithdraw) revert
  // DisabledImplementation(). previewDeposit lives on the deposit-side
  // path and works, so it's a reliable functional probe.
  const previewDepositAbi = [
    {
      type: "function",
      name: "previewDeposit",
      stateMutability: "view",
      inputs: [{ name: "assets", type: "uint256" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const;

  const balanceOfAbi = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const;

  async function dumpImplementationSlot(
    label: string,
    proxy: `0x${string}`
  ): Promise<void> {
    try {
      const raw = await publicClient.getStorageAt({
        address: proxy,
        slot: ERC1967_IMPL_SLOT,
      });
      if (!raw || raw === "0x" || /^0x0+$/.test(raw)) {
        // eslint-disable-next-line no-console
        console.error(
          `   ERC-1967 implementation slot on ${label} is EMPTY — the ` +
            `proxy has never been pointed at an implementation (or the ` +
            `slot was zeroed). This is not a fork-block issue.`
        );
      } else {
        // Last 20 bytes of the 32-byte slot.
        const implAddr = "0x" + raw.slice(-40);
        // eslint-disable-next-line no-console
        console.error(
          `   ERC-1967 implementation on ${label}: ${implAddr} — ` +
            `verify this address on Arbiscan; it's the contract reverting ` +
            `on every selector.`
        );
      }
    } catch (slotErr) {
      // eslint-disable-next-line no-console
      console.error(`   (failed to read ERC-1967 slot: ${slotErr})`);
    }
  }

  async function probe(
    label: string,
    addr: string,
    fn: () => Promise<unknown>
  ): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`\nProbing ${label} functional state...`);
    try {
      const result = await fn();
      // eslint-disable-next-line no-console
      console.log(`✓ ${label} responded — returned ${result}`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const isDisabledImpl = msg.includes("0xf12dfb69");
      // eslint-disable-next-line no-console
      console.error(
        `✗ ${label} reverted at this block — ` +
          (isDisabledImpl
            ? `DisabledImplementation() (0xf12dfb69). The proxy at ${addr} ` +
              `points at an implementation that reverts on every call.`
            : `unexpected revert: ${msg.slice(0, 200)}`)
      );
      await dumpImplementationSlot(label, getAddress(addr));
      errors++;
    }
  }

  const sUSDai = ARBITRUM_ADDRESSES.sUSDai as string;
  if (sUSDai !== ZERO) {
    await probe("sUSDai.previewDeposit(1e18)", sUSDai, () =>
      publicClient.readContract({
        address: getAddress(sUSDai),
        abi: previewDepositAbi,
        functionName: "previewDeposit",
        args: [10n ** 18n],
      })
    );
  }

  const USDai = ARBITRUM_ADDRESSES.USDai as string;
  if (USDai !== ZERO) {
    await probe("USDai.balanceOf(zero)", USDai, () =>
      publicClient.readContract({
        address: getAddress(USDai),
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: ["0x0000000000000000000000000000000000000000"],
      })
    );
  }

  // eslint-disable-next-line no-console
  console.log(`\n${warnings} warnings, ${errors} errors\n`);

  if (errors > 0) {
    // eslint-disable-next-line no-console
    console.error("Fix errors before running fork tests.");
    process.exit(1);
  }

  if (warnings > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "Some addresses unconfigured. Suites depending on them will skip."
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
