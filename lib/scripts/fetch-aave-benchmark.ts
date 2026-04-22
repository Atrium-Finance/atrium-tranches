/**
 * Fetch Aave benchmark rates for USDC/USDT on Ethereum mainnet.
 * Computes aToken-supply-weighted average APR (same formula as SUSDaiAprPairProvider).
 *
 * Usage:
 *   ETH_RPC_URL=<url> npx tsx lib/scripts/fetch-aave-benchmark.ts
 */

import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

// Aave v3 Pool on Ethereum mainnet
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

// Ethereum mainnet tokens
const TOKENS: Record<string, `0x${string}`> = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
};

const RAY_TO_12DEC = 1_000_000_000_000_000n; // 1e15

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

const ERC20_ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function fmtApr12(val: bigint): string {
  return `${(Number(val) / 1e10).toFixed(4)}%`;
}

async function main() {
  const rpcUrl = process.env.ETH_RPC_URL;
  if (!rpcUrl) throw new Error("Missing env: ETH_RPC_URL");

  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  console.log(`\n  Aave V3 Benchmark — Ethereum Mainnet`);
  console.log(`  Pool: ${AAVE_V3_POOL}`);
  console.log(`  ───────────────────────────────────`);

  let weightedSum = 0n;
  let totalWeight = 0n;

  for (const [name, address] of Object.entries(TOKENS)) {
    const reserveData = await client.readContract({
      address: AAVE_V3_POOL as `0x${string}`,
      abi: AAVE_POOL_ABI,
      functionName: "getReserveData",
      args: [address],
    });

    const rate = BigInt(reserveData.currentLiquidityRate) / RAY_TO_12DEC;
    const aToken = reserveData.aTokenAddress;

    const [supply, decimals] = await Promise.all([
      client.readContract({ address: aToken, abi: ERC20_ABI, functionName: "totalSupply" }),
      client.readContract({ address: aToken, abi: ERC20_ABI, functionName: "decimals" }),
    ]);

    weightedSum += supply * rate;
    totalWeight += supply;

    console.log(
      `  ${name.padEnd(6)} | rate=${fmtApr12(rate).padEnd(10)} | aToken=${aToken} | supply=${formatUnits(supply, decimals)}`,
    );
  }

  const benchmark = totalWeight > 0n ? weightedSum / totalWeight : 0n;

  console.log(`  ───────────────────────────────────`);
  console.log(`  Benchmark APR (weighted avg) = ${fmtApr12(benchmark)}`);
  console.log();
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
