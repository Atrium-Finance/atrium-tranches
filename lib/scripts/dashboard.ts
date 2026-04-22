/**
 * Read-only dashboard — tranche info, Junior position, withdraw conditions, user requests.
 *
 * Usage:
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts --user 0x...
 */

import { formatUnits, type PublicClient } from "viem";
import { createSDK, parseFlag } from "./config";
import { CooldownType, TrancheId } from "../types";
import { APR_PAIR_FEED_ABI } from "../abis";

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

function fmtApr12(val: bigint): string {
  // APR feed uses 12 decimals (1% = 1e10)
  return `${(Number(val) / 1e10).toFixed(4)}%`;
}

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const RAY_TO_12DEC = 1_000_000_000_000_000n; // 1e15
const BENCHMARK_MAX = 400_000_000_000n; // 40% in 12dec

const AAVE_POOL_ABI = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveData",
    outputs: [
      {
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_TOTAL_SUPPLY_ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Replicates SUSDaiAprPairProvider._computeBenchmarkApr() off-chain.
 * Reads Aave reserve data + aToken supply for each benchmark token,
 * computes supply-weighted average APR (12 decimals).
 */
async function computeBenchmarkAprOffchain(
  publicClient: PublicClient,
  benchmarkTokens: string[],
): Promise<{ apr: bigint; details: { token: string; rate: bigint; aToken: string; supply: bigint }[] }> {
  const details: { token: string; rate: bigint; aToken: string; supply: bigint }[] = [];

  for (const token of benchmarkTokens) {
    const reserveData = await publicClient.readContract({
      address: AAVE_POOL as `0x${string}`,
      abi: AAVE_POOL_ABI,
      functionName: "getReserveData",
      args: [token as `0x${string}`],
    });

    const rate = BigInt(reserveData.currentLiquidityRate) / RAY_TO_12DEC;
    const aToken = reserveData.aTokenAddress;

    const supply = await publicClient.readContract({
      address: aToken as `0x${string}`,
      abi: ERC20_TOTAL_SUPPLY_ABI,
      functionName: "totalSupply",
    });

    details.push({ token, rate, aToken, supply });
  }

  let weightedSum = 0n;
  let totalSupply = 0n;
  for (const d of details) {
    weightedSum += d.supply * d.rate;
    totalSupply += d.supply;
  }

  let apr = totalSupply > 0n ? weightedSum / totalSupply : 0n;
  if (apr > BENCHMARK_MAX) apr = BENCHMARK_MAX;

  return { apr, details };
}

async function main() {
  const args = process.argv.slice(2);
  const { sdk, publicClient, addresses } = createSDK();

  // ─────────────────────────────────────────────────────────────────
  //  APR Feed
  // ─────────────────────────────────────────────────────────────────

  const providerAddr = addresses.aprProvider as `0x${string}`;
  const providerAbi = [
    {
      inputs: [],
      name: "getAprPairView",
      outputs: [
        { name: "aprTarget", type: "int64" },
        { name: "aprBase", type: "int64" },
        { name: "timestamp", type: "uint64" },
      ],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "benchmarkTokenCount",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [{ name: "", type: "uint256" }],
      name: "s_benchmarkTokens",
      outputs: [{ name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
  ] as const;

  console.log(`\n  APR Feed (${addresses.aprFeed})`);
  console.log(`  ───────────────────────────────────`);
  const [round, liveApr, tokenCount] = await Promise.all([
    publicClient.readContract({
      address: addresses.aprFeed as `0x${string}`,
      abi: APR_PAIR_FEED_ABI,
      functionName: "latestRoundData",
    }),
    publicClient.readContract({
      address: providerAddr,
      abi: providerAbi,
      functionName: "getAprPairView",
    }),
    publicClient.readContract({
      address: providerAddr,
      abi: providerAbi,
      functionName: "benchmarkTokenCount",
    }),
  ]);

  const benchmarkTokens: string[] = [];
  for (let i = 0; i < Number(tokenCount); i++) {
    const token = await publicClient.readContract({
      address: providerAddr,
      abi: providerAbi,
      functionName: "s_benchmarkTokens",
      args: [BigInt(i)],
    });
    benchmarkTokens.push(token);
  }
  const updatedAt = new Date(Number(round.updatedAt) * 1000);
  const staleMinutes = Math.floor((Date.now() - updatedAt.getTime()) / 60_000);
  console.log(
    `  [cached]  aprTarget=${fmtApr12(BigInt(round.aprTarget))}  aprBase=${fmtApr12(BigInt(round.aprBase))}  (round #${round.answeredInRound}, ${staleMinutes}m ago)`,
  );
  console.log(`  [live]    aprTarget=${fmtApr12(BigInt(liveApr[0]))}  aprBase=${fmtApr12(BigInt(liveApr[1]))}`);
  if (BigInt(round.aprTarget) !== BigInt(liveApr[0]) || BigInt(round.aprBase) !== BigInt(liveApr[1])) {
    console.log(`  ⚠ cache stale — live rates differ from cached round`);
  }
  console.log(`  benchmarkTokens = [${benchmarkTokens.join(", ")}]`);

  // ─────────────────────────────────────────────────────────────────
  //  Benchmark APR — off-chain recompute vs contract
  // ─────────────────────────────────────────────────────────────────

  console.log(`\n  Benchmark APR (off-chain recompute)`);
  console.log(`  ───────────────────────────────────`);
  const { apr: offchainApr, details: tokenDetails } = await computeBenchmarkAprOffchain(publicClient, benchmarkTokens);
  for (const d of tokenDetails) {
    console.log(
      `  ${d.token} | rate=${fmtApr12(d.rate)} | aToken=${d.aToken} | supply=${d.supply.toString()}`,
    );
  }
  console.log(`  offchain aprTarget = ${fmtApr12(offchainApr)}`);
  console.log(`  contract aprTarget = ${fmtApr12(BigInt(liveApr[0]))}`);
  if (offchainApr === BigInt(liveApr[0])) {
    console.log(`  ✓ match`);
  } else {
    const diff = Number(offchainApr - BigInt(liveApr[0])) / 1e10;
    console.log(`  ✗ diff = ${diff > 0 ? "+" : ""}${diff.toFixed(4)}%`);
  }

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
