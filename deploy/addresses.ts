/**
 * Arbitrum mainnet contract addresses used by the deploy scripts.
 */
export const ARBITRUM = {
  SUSDAI: "0x0B2b2B2076d95dda7817e785989fE353fe955ef9",
  USDAI: "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF",
  AAVE_V3_POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  // Aave benchmark tokens on Arbitrum (used by SUSDaiAprPairProvider for aprTarget)
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native USDC
  USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
} as const;

/** @notice Stablecoin set used as Aave benchmark for sUSDai aprTarget */
export const AAVE_BENCHMARK_TOKENS = [ARBITRUM.USDC, ARBITRUM.USDT] as const;

/**
 * Default protocol parameters for MVP deployment.
 */
export const DEFAULTS = {
  MIN_COVERAGE_DEPOSIT: BigInt("1050000000000000000"), // 1.05e18 = 105%
  SHORTFALL_PAUSE_PRICE: BigInt("900000000000000000"), // 0.90e18 = 90%
  APR_STALE_AFTER: 30 * 86_400, // 30 days
  PRIMELOCK_DELAY: 24 * 3_600, // 24 hours — governance delay (hardcoded in PrimeLock.sol)
} as const;

/**
 * SHORT cooldown durations for mainnet end-to-end testing.
 * Set TEST_MODE=1 in env to apply these instead of production defaults (3d/7d).
 */
export const TEST_COOLDOWNS = {
  ASSETS_LOCK: 30, // 30s
  SHARES_LOCK: 1 * 60, // 5 minutes
} as const;

/**
 * Governance multisig addresses — placeholder zero addresses until real Safes deployed.
 * Update these before running deploy/06_deploy_timelock.ts.
 */
export const GOVERNANCE = {
  OPS_MULTISIG: "0x0000000000000000000000000000000000000000",
  GUARDIAN_MULTISIG: "0x0000000000000000000000000000000000000000",
} as const;

/**
 * Deployed addresses — populated by deploy scripts, consumed by configure + verify.
 */
export interface DeployedAddresses {
  // Shared (01)
  riskParams: string;
  erc20Cooldown: string;
  sharesCooldown: string;
  // Market (02)
  aprProvider: string;
  aprFeed: string;
  accounting: string;
  strategy: string;
  redemptionPolicy: string;
  primeCDO: string;
  seniorVault: string;
  juniorVault: string;
  // Periphery (04)
  primeLens: string;
  // Governance (06)
  primeLock?: string;
}

export function loadDeployed(): DeployedAddresses {
  try {
    return require("./deployed.json");
  } catch {
    throw new Error("deployed.json not found — run deploy scripts first");
  }
}

export function saveDeployed(addresses: Partial<DeployedAddresses>) {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "deployed.json");
  let existing: Partial<DeployedAddresses> = {};
  try {
    existing = require(file);
  } catch {}
  const merged = { ...existing, ...addresses };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}

/**
 * ⏺ # Step 1 — Shared infrastructure                                                     
  npx hardhat run deploy/01_deploy_shared.ts --network arbitrum                        
                                                                                       
  # Step 2 — Market contracts (Strategy, CDO, Vaults)                                  
  npx hardhat run deploy/02_deploy_market.ts --network arbitrum                        
                                                                                       
  # Step 3 — Wire everything together                                                  
  KEEPER_ADDRESS=0x... npx hardhat run deploy/03_configure.ts --network arbitrum       
                                                                                       
  # Step 4 — PrimeLens (read-only aggregator)                                          
  npx hardhat run deploy/04_deploy_lens.ts --network arbitrum   
 */
