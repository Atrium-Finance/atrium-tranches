/**
 * Deploy Step 09 — Redeploy SUSDaiAprPairProvider + setProvider on AprPairFeed
 *
 * Deploys a new SUSDaiAprPairProvider (with updated benchmark formula)
 * and points the existing AprPairFeed to it via setProvider().
 *
 * No other contracts need redeployment — Accounting reads from AprPairFeed (immutable ref).
 *
 * Usage:
 *   npx hardhat run deploy/09_redeploy_apr_provider.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { ARBITRUM, AAVE_BENCHMARK_TOKENS, loadDeployed, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployed = loadDeployed();
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}`);
  console.log(`  AprPairFeed: ${deployed.aprFeed}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. Deploy new SUSDaiAprPairProvider
  // ═══════════════════════════════════════════════════════════════════

  const ProviderFactory = await hre.ethers.getContractFactory("SUSDaiAprPairProvider");
  const newProvider = await ProviderFactory.deploy(
    ARBITRUM.AAVE_V3_POOL,
    [...AAVE_BENCHMARK_TOKENS],
    ARBITRUM.SUSDAI,
  );
  await newProvider.waitForDeployment();
  const newProviderAddr = await newProvider.getAddress();
  console.log(`  New AprProvider:  ${newProviderAddr}`);
  console.log(`  Old AprProvider:  ${deployed.aprProvider}`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. Call AprPairFeed.setProvider(newProvider)
  // ═══════════════════════════════════════════════════════════════════

  const aprFeed = await hre.ethers.getContractAt("AprPairFeed", deployed.aprFeed);
  const tx = await aprFeed.setProvider(newProviderAddr);
  await tx.wait();
  console.log(`  setProvider tx:   ${tx.hash}`);

  // Verify — read back provider
  const currentProvider = await aprFeed.s_provider();
  if (currentProvider.toLowerCase() !== newProviderAddr.toLowerCase()) {
    throw new Error(`Provider mismatch! Expected ${newProviderAddr}, got ${currentProvider}`);
  }
  console.log(`  ✓ AprPairFeed.s_provider = ${currentProvider}`);

  // ═══════════════════════════════════════════════════════════════════
  //  3. Save new address
  // ═══════════════════════════════════════════════════════════════════

  saveDeployed({ aprProvider: newProviderAddr });
  console.log(`  ✓ deployed.json updated\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
