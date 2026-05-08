/**
 * Deploy Step 02 — sUSDai Market contracts
 *
 * Deploys: SUSDaiAprPairProvider, AprPairFeed, Accounting, RedemptionPolicy,
 *          SUSDaiStrategy, PrimeCDO, TrancheVault × 2
 *
 * Requires: deploy/01_deploy_shared.ts has been run (reads deployed.json).
 *
 * Note: Strategy and CDO form a circular dependency (Strategy needs CDO address
 *       in constructor). We predict CDO address via CREATE nonce.
 *       Deploy order: Strategy(+0) → CDO(+1).
 *
 * Usage:
 *   npx hardhat run deploy/02_deploy_market.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { ARBITRUM, AAVE_BENCHMARK_TOKENS, DEFAULTS, loadDeployed, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const shared = loadDeployed();
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. SUSDaiAprPairProvider
  // ═══════════════════════════════════════════════════════════════════

  const ProviderFactory = await hre.ethers.getContractFactory("SUSDaiAprPairProvider");
  const aprProvider = await ProviderFactory.deploy(
    ARBITRUM.AAVE_V3_POOL,
    [...AAVE_BENCHMARK_TOKENS], // USDC + USDT + DAI on Arbitrum
    ARBITRUM.SUSDAI,
  );
  await aprProvider.waitForDeployment();
  const aprProviderAddr = await aprProvider.getAddress();
  console.log(`  AprProvider:       ${aprProviderAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. AprPairFeed
  // ═══════════════════════════════════════════════════════════════════

  const FeedFactory = await hre.ethers.getContractFactory("AprPairFeed");
  const aprFeed = await FeedFactory.deploy(deployer.address, aprProviderAddr, DEFAULTS.APR_STALE_AFTER);
  await aprFeed.waitForDeployment();
  const aprFeedAddr = await aprFeed.getAddress();
  console.log(`  AprPairFeed:       ${aprFeedAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  3. Accounting
  // ═══════════════════════════════════════════════════════════════════

  const AccFactory = await hre.ethers.getContractFactory("Accounting");
  const accounting = await AccFactory.deploy(aprFeedAddr, shared.riskParams);
  await accounting.waitForDeployment();
  const accountingAddr = await accounting.getAddress();
  console.log(`  Accounting:        ${accountingAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. RedemptionPolicy
  // ═══════════════════════════════════════════════════════════════════

  const RPFactory = await hre.ethers.getContractFactory("RedemptionPolicy");
  const redemptionPolicy = await RPFactory.deploy(deployer.address, accountingAddr);
  await redemptionPolicy.waitForDeployment();
  const redemptionPolicyAddr = await redemptionPolicy.getAddress();
  console.log(`  RedemptionPolicy:  ${redemptionPolicyAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. Predict CDO address: Strategy(+0), CDO(+1)
  // ═══════════════════════════════════════════════════════════════════

  const nonceBefore = await hre.ethers.provider.getTransactionCount(deployer.address);
  const predictedCDO = hre.ethers.getCreateAddress({ from: deployer.address, nonce: nonceBefore + 1 });
  console.log(`  PrimeCDO (pred):   ${predictedCDO}`);

  // ═══════════════════════════════════════════════════════════════════
  //  6. SUSDaiStrategy
  // ═══════════════════════════════════════════════════════════════════

  const StratFactory = await hre.ethers.getContractFactory("SUSDaiStrategy");
  const strategy = await StratFactory.deploy(predictedCDO, ARBITRUM.SUSDAI, deployer.address);
  await strategy.waitForDeployment();
  const strategyAddr = await strategy.getAddress();
  console.log(`  SUSDaiStrategy:    ${strategyAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  7. PrimeCDO
  // ═══════════════════════════════════════════════════════════════════

  const CDOFactory = await hre.ethers.getContractFactory("PrimeCDO");
  const primeCDO = await CDOFactory.deploy(
    accountingAddr,
    strategyAddr,
    aprFeedAddr,
    redemptionPolicyAddr,
    shared.erc20Cooldown,
    shared.sharesCooldown,
    ARBITRUM.SUSDAI,
    deployer.address,
  );
  await primeCDO.waitForDeployment();
  const primeCDOAddr = await primeCDO.getAddress();
  console.log(`  PrimeCDO:          ${primeCDOAddr}`);

  if (primeCDOAddr !== predictedCDO) {
    throw new Error(`CDO address mismatch! predicted=${predictedCDO} actual=${primeCDOAddr}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  8. TrancheVault × 2
  // ═══════════════════════════════════════════════════════════════════

  const VaultFactory = await hre.ethers.getContractFactory("TrancheVault");

  const seniorVault = await VaultFactory.deploy(primeCDOAddr, 0, ARBITRUM.USDAI, "Prime Senior sUSDai", "srUSDai");
  await seniorVault.waitForDeployment();
  const seniorVaultAddr = await seniorVault.getAddress();
  console.log(`  SeniorVault:       ${seniorVaultAddr}`);

  const juniorVault = await VaultFactory.deploy(primeCDOAddr, 1, ARBITRUM.USDAI, "Prime Junior sUSDai", "jrUSDai");
  await juniorVault.waitForDeployment();
  const juniorVaultAddr = await juniorVault.getAddress();
  console.log(`  JuniorVault:       ${juniorVaultAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  Save
  // ═══════════════════════════════════════════════════════════════════

  saveDeployed({
    aprProvider: aprProviderAddr,
    aprFeed: aprFeedAddr,
    accounting: accountingAddr,
    strategy: strategyAddr,
    redemptionPolicy: redemptionPolicyAddr,
    primeCDO: primeCDOAddr,
    seniorVault: seniorVaultAddr,
    juniorVault: juniorVaultAddr,
  });

  console.log(`\n  ✓ sUSDai market deployed. Saved to deploy/deployed.json`);
  console.log(`  Next: npx hardhat run deploy/03_configure.ts --network arbitrum\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
