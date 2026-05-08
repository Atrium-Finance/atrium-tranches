/**
 * Deploy Step 04 — PrimeLens (read-only aggregator)
 *
 * Deploys: PrimeLens
 *
 * Requires: deploy/01-03 have been run (CDO must have vaults registered).
 * PrimeLens reads immutables from PrimeCDO in its constructor.
 *
 * Usage:
 *   npx hardhat run deploy/04_deploy_lens.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { loadDeployed, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = loadDeployed();
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  const LensFactory = await hre.ethers.getContractFactory("PrimeLens");
  const primeLens = await LensFactory.deploy(d.primeCDO, d.seniorVault, d.juniorVault);
  await primeLens.waitForDeployment();
  const primeLensAddr = await primeLens.getAddress();
  console.log(`  PrimeLens:         ${primeLensAddr}`);

  saveDeployed({ primeLens: primeLensAddr });

  console.log(`\n  ✓ PrimeLens deployed. Saved to deploy/deployed.json`);
  console.log(`  Deployment complete!\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
