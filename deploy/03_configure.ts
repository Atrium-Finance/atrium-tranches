/**
 * Deploy Step 03 — Configure all wiring between contracts
 *
 * Actions:
 *   - Set CDO in Accounting (one-time)
 *   - Register vaults in CDO
 *   - Authorize CDO in cooldown contracts
 *   - Set coverage gate params
 *   - Grant KEEPER_ROLE on AprPairFeed (PrimeCDO + optional bot keeper)
 *   - If TEST_MODE=1: override RedemptionPolicy cooldowns to short test durations
 *     (ASSETS_LOCK = 3min, SHARES_LOCK = 5min) for all 3 tranches
 *
 * Requires: deploy/01 and deploy/02 have been run.
 *
 * Usage:
 *   npx hardhat run deploy/03_configure.ts --network arbitrum
 *   TEST_MODE=1 npx hardhat run deploy/03_configure.ts --network arbitrum
 *   KEEPER_ADDRESS=0x... TEST_MODE=1 npx hardhat run deploy/03_configure.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { DEFAULTS, TEST_COOLDOWNS, loadDeployed } from "./addresses";

const TRANCHES = [
  { id: 0, name: "SENIOR" },
  { id: 1, name: "MEZZ" },
  { id: 2, name: "JUNIOR" },
] as const;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = loadDeployed();
  const keeperAddr = process.env.KEEPER_ADDRESS;
  const testMode = process.env.TEST_MODE === "1";

  console.log(`\n  Deployer:  ${deployer.address}`);
  console.log(`  Network:   ${hre.network.name}`);
  console.log(`  Test mode: ${testMode ? "ON (3min/5min cooldowns)" : "OFF (defaults 3d/7d)"}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. Set CDO in Accounting (one-time)
  // ═══════════════════════════════════════════════════════════════════

  const accounting = await hre.ethers.getContractAt("Accounting", d.accounting);
  await (await accounting.setCDO(d.primeCDO)).wait();
  console.log(`  ✓ Accounting.setCDO(${d.primeCDO})`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. Register vaults in CDO
  // ═══════════════════════════════════════════════════════════════════

  const cdo = await hre.ethers.getContractAt("PrimeCDO", d.primeCDO);
  for (const t of TRANCHES) {
    const vault = t.id === 0 ? d.seniorVault : t.id === 1 ? d.mezzVault : d.juniorVault;
    await (await cdo.registerTranche(t.id, vault)).wait();
    console.log(`  ✓ CDO.registerTranche(${t.name}, ${vault})`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  3. Authorize CDO in cooldown contracts
  // ═══════════════════════════════════════════════════════════════════

  const erc20Cooldown = await hre.ethers.getContractAt("ERC20Cooldown", d.erc20Cooldown);
  await (await erc20Cooldown.setAuthorized(d.primeCDO, true)).wait();
  console.log(`  ✓ ERC20Cooldown.setAuthorized(CDO)`);

  const sharesCooldown = await hre.ethers.getContractAt("SharesCooldown", d.sharesCooldown);
  await (await sharesCooldown.setAuthorized(d.primeCDO, true)).wait();
  console.log(`  ✓ SharesCooldown.setAuthorized(CDO)`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. Set coverage gate params
  // ═══════════════════════════════════════════════════════════════════

  await (await cdo.setMinCoverageForDeposit(DEFAULTS.MIN_COVERAGE_DEPOSIT)).wait();
  console.log(`  ✓ CDO.setMinCoverageForDeposit(105%)`);

  await (await cdo.setJuniorShortfallPausePrice(DEFAULTS.SHORTFALL_PAUSE_PRICE)).wait();
  console.log(`  ✓ CDO.setJuniorShortfallPausePrice(90%)`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. Grant KEEPER_ROLE on AprPairFeed
  // ═══════════════════════════════════════════════════════════════════

  const aprFeed = await hre.ethers.getContractAt("AprPairFeed", d.aprFeed);
  const KEEPER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));

  // PrimeCDO needs KEEPER_ROLE to auto-push APR data on every deposit/withdraw
  await (await aprFeed.grantRole(KEEPER_ROLE, d.primeCDO)).wait();
  console.log(`  ✓ AprPairFeed.grantRole(KEEPER_ROLE, PrimeCDO)`);

  if (keeperAddr) {
    await (await aprFeed.grantRole(KEEPER_ROLE, keeperAddr)).wait();
    console.log(`  ✓ AprPairFeed.grantRole(KEEPER_ROLE, ${keeperAddr}) — backup keeper`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  6. TEST MODE: override RedemptionPolicy cooldowns to short durations
  // ═══════════════════════════════════════════════════════════════════

  if (testMode) {
    const rp = await hre.ethers.getContractAt("RedemptionPolicy", d.redemptionPolicy);

    for (const t of TRANCHES) {
      const current = await rp.s_mechanismConfig(t.id);
      const newConfig = {
        instantFeeBps: current[0],
        assetsLockFeeBps: current[1],
        assetsLockDuration: BigInt(TEST_COOLDOWNS.ASSETS_LOCK),
        sharesLockFeeBps: current[3],
        sharesLockDuration: BigInt(TEST_COOLDOWNS.SHARES_LOCK),
      };
      await (await rp.setMechanismConfig(t.id, newConfig)).wait();
      console.log(
        `  ✓ RedemptionPolicy.setMechanismConfig(${t.name}, assets=${TEST_COOLDOWNS.ASSETS_LOCK}s, shares=${TEST_COOLDOWNS.SHARES_LOCK}s)`,
      );
    }
  }

  console.log(`\n  ✓ All configuration complete!`);
  console.log(`  Next: npx hardhat run deploy/04_deploy_lens.ts --network arbitrum\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
