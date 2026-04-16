/**
 * Read-only dashboard — tranche info, Junior position, withdraw conditions, user requests.
 *
 * Usage:
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts --user 0x...
 */

import { formatUnits } from "viem";
import { createSDK, parseFlag } from "./config";
import { CooldownType, TrancheId } from "../types";

const MECHANISM_NAMES: Record<number, string> = {
  [CooldownType.NONE]: "NONE (instant)",
  [CooldownType.ASSETS_LOCK]: "ASSETS_LOCK",
  [CooldownType.SHARES_LOCK]: "SHARES_LOCK",
};

function fmtUSD(val: bigint): string {
  return `$${formatUnits(val, 18)}`;
}

const UINT256_MAX = 2n ** 256n - 1n;

function fmtPct(val: bigint): string {
  if (val >= UINT256_MAX) return "∞";
  return `${(Number(val) / 1e16).toFixed(2)}%`;
}

function fmtHours(seconds: bigint): string {
  const h = Number(seconds) / 3600;
  return h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

async function main() {
  const args = process.argv.slice(2);
  const { sdk } = createSDK();

  // ─────────────────────────────────────────────────────────────────
  //  Tranches
  // ─────────────────────────────────────────────────────────────────

  console.log(`\n  Tranches`);
  console.log(`  ───────────────────────────────────`);

  for (const id of [TrancheId.SENIOR, TrancheId.MEZZ, TrancheId.JUNIOR]) {
    const t = await sdk.getTrancheById(id);
    console.log(
      `  ${id}: ${t.symbol} | assets=${fmtUSD(t.totalAssets)} | supply=${formatUnits(t.totalSupply, 18)} | price=${formatUnits(t.sharePrice, 18)} | APY=${fmtPct(t.apy)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────
  //  Withdraw Conditions (preview with 1 share)
  // ─────────────────────────────────────────────────────────────────

  console.log(`\n  Withdraw Conditions`);
  console.log(`  ───────────────────────────────────`);
  for (const id of [TrancheId.SENIOR, TrancheId.MEZZ, TrancheId.JUNIOR]) {
    const w = await sdk.previewWithdraw(id, 10n ** 18n);
    const mech = MECHANISM_NAMES[w.mechanism] ?? String(w.mechanism);
    const fee = `${Number(w.feeBps) / 100}%`;
    const cd = w.cooldownDuration > 0n ? fmtHours(w.cooldownDuration) : "-";
    console.log(`  ${id}: ${mech} | fee=${fee} | cooldown=${cd}`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  User Withdraw Requests
  // ─────────────────────────────────────────────────────────────────

  let userAddr = parseFlag(args, "--user");
  if (!userAddr && process.env.PRIVATE_KEY) {
    const { privateKeyToAccount } = await import("viem/accounts");
    userAddr = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`).address;
  }

  if (userAddr) {
    const requests = await sdk.getUserWithdrawRequests(userAddr);
    console.log(`\n  Withdraw Requests — ${userAddr}`);
    console.log(`  ───────────────────────────────────`);
    if (requests.length === 0) {
      console.log(`  (none)`);
    }
    for (const r of requests) {
      const status = r.isClaimable
        ? "CLAIMABLE"
        : r.timeRemaining > 0n
          ? `${fmtHours(r.timeRemaining)} left`
          : "PENDING";
      console.log(
        `  #${r.requestId} | ${formatUnits(r.amount, 18)} | ${status} | handler=${r.handler.slice(0, 10)}...`,
      );
    }
  }

  console.log();
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
