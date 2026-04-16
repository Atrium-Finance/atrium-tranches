/**
 * Arbitrum mainnet contract addresses used by the deploy scripts.
 */
export const ARBITRUM = {
  SUSDAI: "0x0B2b2B2076d95dda7817e785989fE353fe955ef9",
  USDAI: "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF",
  AAVE_V3_POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  CHAINLINK_ETH_USD: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  UNISWAP_V3_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_V3_QUOTER: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
} as const;

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
  mezzVault: string;
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
