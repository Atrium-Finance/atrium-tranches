/**
 * Deploy Step 07 — Transfer governance ownership to PrimeLock (Stage 3)
 *
 * Transfers ownership/admin roles from deployer (or Ops EOA) → PrimeLock.
 * After this script runs, Ops Multisig must submit proposals through PrimeLock
 * (with 24-hour delay) to perform `acceptOwnership()` on each Ownable2Step contract.
 *
 * This script should be run by the current OWNER of all contracts (deployer or Ops Multisig).
 *
 * Steps performed:
 *   1. Call `transferOwnership(PrimeLock)` on all Ownable2Step contracts
 *   2. Grant DEFAULT_ADMIN_ROLE to PrimeLock on AprPairFeed
 *   3. Renounce DEFAULT_ADMIN_ROLE from current signer on AprPairFeed
 *   4. Call `setGuardian(GUARDIAN_MULTISIG)` on PrimeCDO and Strategy (if current signer is owner)
 *
 * Usage:
 *   npx hardhat run deploy/07_transfer_governance.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { GOVERNANCE, loadDeployed } from "./addresses";

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const d = loadDeployed();

  if (!d.primeLock) {
    throw new Error("PrimeLock not deployed — run 06_deploy_primelock.ts first");
  }
  if (GOVERNANCE.GUARDIAN_MULTISIG === hre.ethers.ZeroAddress) {
    throw new Error("GOVERNANCE.GUARDIAN_MULTISIG not set in deploy/addresses.ts");
  }

  console.log(`\n  Current signer: ${signer.address}`);
  console.log(`  PrimeLock:       ${d.primeLock}`);
  console.log(`  Guardian:       ${GOVERNANCE.GUARDIAN_MULTISIG}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. Set Guardian on PrimeCDO and Strategy (before transferring ownership)
  // ═══════════════════════════════════════════════════════════════════

  console.log(`  Setting guardian on PrimeCDO...`);
  const primeCDO = await hre.ethers.getContractAt("PrimeCDO", d.primeCDO);
  await (await primeCDO.setGuardian(GOVERNANCE.GUARDIAN_MULTISIG)).wait();

  console.log(`  Setting guardian on Strategy...`);
  const strategy = await hre.ethers.getContractAt("SUSDaiStrategy", d.strategy);
  await (await strategy.setGuardian(GOVERNANCE.GUARDIAN_MULTISIG)).wait();

  // ═══════════════════════════════════════════════════════════════════
  //  2. transferOwnership(PrimeLock) on all Ownable2Step contracts
  // ═══════════════════════════════════════════════════════════════════

  const ownables = [
    { name: "PrimeCDO", address: d.primeCDO, factory: "PrimeCDO" },
    { name: "RiskParams", address: d.riskParams, factory: "RiskParams" },
    { name: "RedemptionPolicy", address: d.redemptionPolicy, factory: "RedemptionPolicy" },
    { name: "ERC20Cooldown", address: d.erc20Cooldown, factory: "ERC20Cooldown" },
    { name: "SharesCooldown", address: d.sharesCooldown, factory: "SharesCooldown" },
    { name: "Strategy", address: d.strategy, factory: "SUSDaiStrategy" },
  ];

  for (const c of ownables) {
    console.log(`  Transferring ownership: ${c.name} → PrimeLock`);
    const contract = await hre.ethers.getContractAt(c.factory, c.address);
    await (await (contract as any).transferOwnership(d.primeLock)).wait();
  }

  // ═══════════════════════════════════════════════════════════════════
  //  3. AprPairFeed (AccessControl) — grant DEFAULT_ADMIN_ROLE to PrimeLock
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  Granting DEFAULT_ADMIN_ROLE on AprPairFeed → PrimeLock`);
  const aprFeed = await hre.ethers.getContractAt("AprPairFeed", d.aprFeed);
  const DEFAULT_ADMIN_ROLE = hre.ethers.ZeroHash;
  await (await aprFeed.grantRole(DEFAULT_ADMIN_ROLE, d.primeLock)).wait();

  console.log(`  Renouncing DEFAULT_ADMIN_ROLE from signer`);
  await (await aprFeed.renounceRole(DEFAULT_ADMIN_ROLE, signer.address)).wait();

  console.log(`\n  === Transfer complete ===`);
  console.log(`  PrimeLock is now the pending owner of all contracts.`);
  console.log(`  Ops Multisig must propose batch acceptOwnership() via PrimeLock.`);
  console.log(`  Use deploy/08_accept_governance.ts to generate the proposal payload.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
