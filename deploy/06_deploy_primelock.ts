/**
 * Deploy Step 06 — PrimeLock (governance timelock, 24-hour delay)
 *
 * Deploys PrimeLock (wrapper over OZ TimelockController) with:
 *   - minDelay: 24 hours (hardcoded in PrimeLock.sol)
 *   - proposers: [OPS_MULTISIG]
 *   - executors: [OPS_MULTISIG, address(0)] — anyone can execute after delay
 *   - admin: address(0) — roles immutable after deploy
 *
 * Post-deploy: Ops Multisig must schedule grantRole(CANCELLER_ROLE, Guardian)
 * as its first proposal.
 *
 * Usage:
 *   # Update GOVERNANCE.OPS_MULTISIG and GOVERNANCE.GUARDIAN_MULTISIG in addresses.ts first
 *   npx hardhat run deploy/06_deploy_primelock.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { DEFAULTS, GOVERNANCE, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  if (GOVERNANCE.OPS_MULTISIG === hre.ethers.ZeroAddress) {
    throw new Error("GOVERNANCE.OPS_MULTISIG not set in deploy/addresses.ts");
  }
  if (GOVERNANCE.GUARDIAN_MULTISIG === hre.ethers.ZeroAddress) {
    throw new Error("GOVERNANCE.GUARDIAN_MULTISIG not set in deploy/addresses.ts");
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Deploy PrimeLock
  // ═══════════════════════════════════════════════════════════════════

  const proposers = [GOVERNANCE.OPS_MULTISIG];
  const executors = [GOVERNANCE.OPS_MULTISIG, hre.ethers.ZeroAddress]; // 0x0 = anyone
  const admin = hre.ethers.ZeroAddress; // no admin → roles immutable

  console.log(`  Delay:     ${DEFAULTS.PRIMELOCK_DELAY} seconds (${DEFAULTS.PRIMELOCK_DELAY / 3_600} hours)`);
  console.log(`  Proposers: ${proposers.join(", ")}`);
  console.log(`  Executors: ${executors.join(", ")}`);
  console.log(`  Admin:     ${admin} (immutable)\n`);

  const PrimeLockFactory = await hre.ethers.getContractFactory("PrimeLock");
  const primeLock = await PrimeLockFactory.deploy(proposers, executors, admin);
  await primeLock.waitForDeployment();
  const primeLockAddr = await primeLock.getAddress();
  console.log(`  PrimeLock: ${primeLockAddr}\n`);

  // Note: Ops Multisig must schedule grantRole(CANCELLER_ROLE, Guardian) as its first
  // proposal after deploy, since deployer has no PROPOSER_ROLE to do it directly.
  console.log(`  NOTE: Ops Multisig must propose grantRole(CANCELLER_ROLE, Guardian) as first action.\n`);

  saveDeployed({ primeLock: primeLockAddr });
  console.log(`  Saved primeLock address to deploy/deployed.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
