/**
 * Standalone test — Deploy SUSDaiAprPairProvider + AprPairFeed and verify
 * aprTarget (Aave benchmark) and aprBase (sUSDai growth) values.
 *
 * Steps:
 *   1. Deploy provider with [USDC, USDT, DAI] benchmark on Arbitrum Aave v3
 *   2. Deploy AprPairFeed wrapping the provider
 *   3. Sanity check: query Aave directly for each benchmark token's currentLiquidityRate
 *      and compare against provider's aprTarget
 *   4. Check sUSDai initial rate (convertToAssets(1e18))
 *   5. Call updateRoundData (push first round)
 *   6. Wait, then call again to get aprBase from rate growth
 *
 * Usage:
 *   npx hardhat run deploy/test_apr_feed.ts --network arbitrum
 *
 * Env optional:
 *   WAIT_SECONDS=600  (how long to wait between snapshots — default 60s)
 *
 * NOTE: Standalone — does NOT save addresses to deployed.json. Pure test.
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { ARBITRUM, AAVE_BENCHMARK_TOKENS, DEFAULTS } from "./addresses";

const APR_12DEC = 10n ** 12n;
const SECONDS_PER_YEAR = 365n * 86_400n;

const AAVE_POOL_ABI: any[] = [
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
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const ERC20_ABI: any[] = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
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
];

const SUSDAI_ABI: any[] = [
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "convertToAssets",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

function fmtPct12(v: bigint): string {
  // 12-decimal APR → percent
  return `${(Number(v) / Number(APR_12DEC) * 100).toFixed(4)}%`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const waitSec = Number(process.env.WAIT_SECONDS ?? "60");

  console.log(`\n  ╔═══════════════════════════════════════════════════════╗`);
  console.log(`  ║  AprPairFeed — Standalone Sanity Test                  ║`);
  console.log(`  ╚═══════════════════════════════════════════════════════╝`);
  console.log(`  Network:    ${hre.network.name}`);
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  Wait gap:   ${waitSec}s\n`);

  // ─── 1. Sanity check Aave benchmark tokens directly ──────────────
  console.log(`  ─── Aave currentLiquidityRate per benchmark token ───`);
  const pool = await hre.ethers.getContractAt(AAVE_POOL_ABI, ARBITRUM.AAVE_V3_POOL);

  let weightedSum = 0n;
  let totalSupply = 0n;
  for (const token of AAVE_BENCHMARK_TOKENS) {
    const erc = await hre.ethers.getContractAt(ERC20_ABI, token);
    const symbol = await erc.symbol();
    const decimals = await erc.decimals();

    const reserve = await pool.getReserveData(token);
    const aRate = reserve.currentLiquidityRate; // RAY (1e27)
    const aSupply = await (await hre.ethers.getContractAt(ERC20_ABI, reserve.aTokenAddress)).totalSupply();

    // Convert RAY → 12dec APR (matches provider math)
    const apr12 = aRate / 10n ** 15n; // RAY_TO_12DEC = 1e15
    weightedSum += aSupply * apr12;
    totalSupply += aSupply;

    console.log(
      `    ${symbol.padEnd(6)} | aToken supply=${(Number(aSupply) / 10 ** Number(decimals)).toFixed(0).padStart(15)} | rate=${fmtPct12(apr12)}`,
    );
  }

  const expectedAprTarget = totalSupply > 0n ? weightedSum / totalSupply : 0n;
  console.log(`\n  Expected weighted-avg aprTarget: ${fmtPct12(expectedAprTarget)}`);

  // ─── 2. Check sUSDai initial rate ────────────────────────────────
  console.log(`\n  ─── sUSDai vault state ───`);
  const sUSDai = await hre.ethers.getContractAt(SUSDAI_ABI, ARBITRUM.SUSDAI);
  const rate0 = await sUSDai.convertToAssets(10n ** 18n);
  console.log(`  convertToAssets(1e18) = ${rate0}  (raw)`);
  console.log(`                        = ${(Number(rate0) / 1e18).toFixed(6)} USDai per sUSDai`);

  // ─── 3. Deploy provider ──────────────────────────────────────────
  console.log(`\n  ─── Deploying SUSDaiAprPairProvider ───`);
  const ProviderFactory = await hre.ethers.getContractFactory("SUSDaiAprPairProvider");
  const provider = await ProviderFactory.deploy(
    ARBITRUM.AAVE_V3_POOL,
    [...AAVE_BENCHMARK_TOKENS],
    ARBITRUM.SUSDAI,
  );
  await provider.waitForDeployment();
  const providerAddr = await provider.getAddress();
  console.log(`  Provider: ${providerAddr}`);

  // ─── 4. Deploy feed ──────────────────────────────────────────────
  console.log(`\n  ─── Deploying AprPairFeed ───`);
  const FeedFactory = await hre.ethers.getContractFactory("AprPairFeed");
  const feed = await FeedFactory.deploy(deployer.address, providerAddr, DEFAULTS.APR_STALE_AFTER);
  await feed.waitForDeployment();
  const feedAddr = await feed.getAddress();
  console.log(`  Feed: ${feedAddr}`);

  // Grant deployer KEEPER_ROLE so we can call updateRoundData
  const KEEPER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));
  await (await feed.grantRole(KEEPER_ROLE, deployer.address)).wait();
  console.log(`  ✓ Granted KEEPER_ROLE to deployer`);

  // ─── 5. View feed data immediately (provider view fallback) ──────
  console.log(`\n  ─── getAprPairView() — initial state (only 1 snapshot, aprBase should be 0) ───`);
  const view0 = await provider.getAprPairView();
  console.log(`  aprTarget: ${fmtPct12(view0.aprTarget)}`);
  console.log(`  aprBase:   ${fmtPct12(view0.aprBase)}`);
  console.log(`  ts:        ${view0.timestamp}`);

  // Compare aprTarget against expected
  const diff = view0.aprTarget > expectedAprTarget
    ? view0.aprTarget - expectedAprTarget
    : expectedAprTarget - view0.aprTarget;
  if (diff < 10n) {
    console.log(`  ✓ aprTarget matches expected (diff=${diff})`);
  } else {
    console.log(`  ⚠ aprTarget mismatch: provider=${view0.aprTarget} expected=${expectedAprTarget}`);
  }

  // ─── 6. First updateRoundData (shifts snapshot) ──────────────────
  console.log(`\n  ─── updateRoundData() #1 — push first round ───`);
  await (await feed.updateRoundData()).wait();
  const round1 = await feed.latestRoundData();
  console.log(`  Round ${round1.answeredInRound}: aprTarget=${fmtPct12(round1.aprTarget)} | aprBase=${fmtPct12(round1.aprBase)} | ts=${round1.updatedAt}`);

  // ─── 7. Wait, then update again ──────────────────────────────────
  console.log(`\n  Waiting ${waitSec}s for sUSDai rate growth...`);
  await sleep(waitSec * 1000);

  console.log(`\n  ─── updateRoundData() #2 — should now have non-zero aprBase ───`);
  await (await feed.updateRoundData()).wait();
  const round2 = await feed.latestRoundData();
  console.log(`  Round ${round2.answeredInRound}: aprTarget=${fmtPct12(round2.aprTarget)} | aprBase=${fmtPct12(round2.aprBase)} | ts=${round2.updatedAt}`);

  // Read provider snapshots directly — these are the EXACT rates the contract used
  const prevSnap = await provider.s_prevSnapshot();
  const latestSnap = await provider.s_latestSnapshot();
  const prevRate = BigInt(prevSnap.rate);
  const latestRate = BigInt(latestSnap.rate);
  const prevTs = BigInt(prevSnap.timestamp);
  const latestTs = BigInt(latestSnap.timestamp);

  console.log(`\n  ─── Snapshot verification (using contract's actual snapshots) ───`);
  console.log(`  prevSnapshot:   rate=${prevRate} ts=${prevTs}`);
  console.log(`  latestSnapshot: rate=${latestRate} ts=${latestTs}`);

  if (latestRate > prevRate && latestTs > prevTs) {
    const growth = ((latestRate - prevRate) * 10n ** 18n) / prevRate;
    const deltaT = latestTs - prevTs;
    const annualizedApr = (growth * SECONDS_PER_YEAR) / deltaT;
    const apr12 = annualizedApr / 10n ** 6n;
    console.log(`  growth:        ${growth} (1e18 scale)`);
    console.log(`  deltaT:        ${deltaT}s`);
    console.log(`  manual APR:    ${fmtPct12(apr12)}  ← should match Round 2 aprBase exactly`);
  } else {
    console.log(`  ⚠ No growth detected in snapshots — may need longer wait`);
  }

  console.log(`\n  ✓ Test complete.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
