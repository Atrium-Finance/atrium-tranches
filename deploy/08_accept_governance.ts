/**
 * Deploy Step 08 — Generate PrimeLock proposal payload to accept ownership.
 *
 * After 07_transfer_governance.ts runs, PrimeLock is pending owner of all
 * Ownable2Step contracts. Ops Multisig must schedule a batch proposal on
 * PrimeLock that calls acceptOwnership() on each contract.
 *
 * This script generates the proposal payload (targets, values, datas, predecessor,
 * salt) that Ops Multisig can submit via Safe UI (calling PrimeLock.scheduleBatch).
 *
 * Usage (read-only — prints payload):
 *   npx hardhat run deploy/08_accept_governance.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { DEFAULTS, loadDeployed } from "./addresses";

async function main() {
  const d = loadDeployed();

  if (!d.primeLock) {
    throw new Error("PrimeLock not deployed — run 06_deploy_primelock.ts first");
  }

  const ownables = [
    { name: "PrimeCDO", address: d.primeCDO },
    { name: "RiskParams", address: d.riskParams },
    { name: "RedemptionPolicy", address: d.redemptionPolicy },
    { name: "ERC20Cooldown", address: d.erc20Cooldown },
    { name: "SharesCooldown", address: d.sharesCooldown },
    { name: "Strategy", address: d.strategy },
  ];

  // Build batch proposal: each call is acceptOwnership() on a contract
  const iface = new hre.ethers.Interface(["function acceptOwnership()"]);
  const calldata = iface.encodeFunctionData("acceptOwnership");

  const targets = ownables.map((c) => c.address);
  const values = ownables.map(() => 0);
  const payloads = ownables.map(() => calldata);
  const predecessor = hre.ethers.ZeroHash;
  const salt = hre.ethers.id("PrimeVaults.AcceptOwnership.v1");
  const delay = DEFAULTS.PRIMELOCK_DELAY;

  console.log(`\n  === PrimeLock.scheduleBatch payload ===\n`);
  console.log(`  PrimeLock:    ${d.primeLock}`);
  console.log(`  Delay:       ${delay} seconds (${delay / 86_400} days)`);
  console.log(`  Targets:`);
  ownables.forEach((c, i) => console.log(`    [${i}] ${c.name.padEnd(20)} ${c.address}`));
  console.log(`  Calldata:    ${calldata}   (acceptOwnership())`);
  console.log(`  Predecessor: ${predecessor}`);
  console.log(`  Salt:        ${salt}\n`);

  // Encode the scheduleBatch call that Ops Multisig will submit via Safe
  const timelockIface = new hre.ethers.Interface([
    "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
    "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  ]);

  const scheduleCalldata = timelockIface.encodeFunctionData("scheduleBatch", [
    targets,
    values,
    payloads,
    predecessor,
    salt,
    delay,
  ]);
  const executeCalldata = timelockIface.encodeFunctionData("executeBatch", [
    targets,
    values,
    payloads,
    predecessor,
    salt,
  ]);

  console.log(`  === Safe TX #1 (schedule — submit now) ===`);
  console.log(`  To:       ${d.primeLock}`);
  console.log(`  Value:    0`);
  console.log(`  Data:     ${scheduleCalldata}\n`);

  console.log(`  === Safe TX #2 (execute — submit after ${delay / 86_400}d delay) ===`);
  console.log(`  To:       ${d.primeLock}`);
  console.log(`  Value:    0`);
  console.log(`  Data:     ${executeCalldata}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
