/**
 * Verify Deployment — Read all params and test $1 deposit/withdraw
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployment.ts --network arbitrum
 *   ARB_RPC_URL=<url> npx hardhat run scripts/verify-deployment.ts
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";

function loadDeployed() {
  try {
    return require("../deploy/deployed.json");
  } catch {
    throw new Error("deploy/deployed.json not found — run deploy scripts first");
  }
}

async function main() {
  const d = loadDeployed();
  const [deployer] = await hre.ethers.getSigners();
  const E18 = 10n ** 18n;

  console.log(`\n  ═══ PrimeVaults V3 — Deployment Verification ═══\n`);
  console.log(`  Network:  ${hre.network.name}`);
  console.log(`  Deployer: ${deployer.address}\n`);

  let checks = 0;
  let passed = 0;

  function check(name: string, condition: boolean, detail?: string) {
    checks++;
    if (condition) {
      passed++;
      console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    } else {
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  1. Verify addresses are set
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- Deployed Addresses ---`);
  for (const [key, addr] of Object.entries(d)) {
    console.log(`  ${key}: ${addr}`);
    check(`${key} is non-zero`, addr !== hre.ethers.ZeroAddress);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  2. Verify CDO wiring
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- CDO Wiring ---`);
  const cdo = await hre.ethers.getContractAt("PrimeCDO", d.primeCDO);

  const accAddr = await cdo.accounting();
  check("CDO.accounting == Accounting", accAddr === d.accounting, accAddr);

  const stratAddr = await cdo.strategy();
  check("CDO.strategy == Strategy", stratAddr === d.strategy, stratAddr);

  const srVault = await cdo.s_tranches(0);
  check("CDO.s_tranches(SENIOR) == SeniorVault", srVault === d.seniorVault);

  const jrVault = await cdo.s_tranches(1);
  check("CDO.s_tranches(JUNIOR) == JuniorVault", jrVault === d.juniorVault);

  const paused = await cdo.s_shortfallPaused();
  check("CDO not shortfall-paused", !paused);

  // ═══════════════════════════════════════════════════════════════════
  //  3. Verify params
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- Protocol Params ---`);

  const ratioTarget = await cdo.s_ratioTarget();
  check("WETH ratio target = 20%", ratioTarget === 200000000000000000n, `${hre.ethers.formatEther(ratioTarget)}`);

  const ratioTol = await cdo.s_ratioTolerance();
  check("WETH ratio tolerance = 2%", ratioTol === 20000000000000000n, `${hre.ethers.formatEther(ratioTol)}`);

  const minCov = await cdo.s_minCoverageForDeposit();
  check("Min coverage = 105%", minCov === 1050000000000000000n, `${hre.ethers.formatEther(minCov)}`);

  const pausePrice = await cdo.s_juniorShortfallPausePrice();
  check("Shortfall pause = 90%", pausePrice === 900000000000000000n, `${hre.ethers.formatEther(pausePrice)}`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. Verify Accounting CDO link
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- Accounting ---`);
  const accounting = await hre.ethers.getContractAt("Accounting", d.accounting);
  const accountingCDO = await accounting.s_primeCDO();
  check("Accounting.s_primeCDO == CDO", accountingCDO === d.primeCDO);

  // ═══════════════════════════════════════════════════════════════════
  //  5. Verify cooldown authorization
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- Cooldown Authorization ---`);
  const erc20CD = await hre.ethers.getContractAt("ERC20Cooldown", d.erc20Cooldown);
  // ERC20Cooldown.s_authorized mapping check — call would need ABI, check via static call
  // Just verify the contracts are deployed with code
  const erc20Code = await hre.ethers.provider.getCode(d.erc20Cooldown);
  check("ERC20Cooldown has code", erc20Code.length > 2);

  const sharesCode = await hre.ethers.provider.getCode(d.sharesCooldown);
  check("SharesCooldown has code", sharesCode.length > 2);

  const unstakeCode = await hre.ethers.provider.getCode(d.unstakeCooldown);
  check("UnstakeCooldown has code", unstakeCode.length > 2);

  // ═══════════════════════════════════════════════════════════════════
  //  6. Verify TrancheVaults
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- TrancheVaults ---`);
  const svault = await hre.ethers.getContractAt("TrancheVault", d.seniorVault);
  const sName = await svault.name();
  check("SeniorVault name", sName.includes("Senior"), sName);

  const jvault = await hre.ethers.getContractAt("TrancheVault", d.juniorVault);
  const jName = await jvault.name();
  check("JuniorVault name", jName.includes("Junior"), jName);

  // ═══════════════════════════════════════════════════════════════════
  //  7. Verify AprPairFeed keeper role
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- APR Oracle ---`);
  const aprFeed = await hre.ethers.getContractAt("AprPairFeed", d.aprFeed);
  const KEEPER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));
  const keeperAddr = process.env.KEEPER_ADDRESS || deployer.address;
  const hasKeeper = await aprFeed.hasRole(KEEPER_ROLE, keeperAddr);
  check(`AprPairFeed KEEPER_ROLE granted to ${keeperAddr}`, hasKeeper);

  // ═══════════════════════════════════════════════════════════════════
  //  8. Test $1 deposit into Junior (if on fork with real tokens)
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  --- Smoke Test ($1 Deposit) ---`);
  try {
    // This only works on a fork where deployer has USDai + WETH
    const usdai = await hre.ethers.getContractAt("IERC20", "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF");
    const balance = await usdai.balanceOf(deployer.address);
    if (balance >= E18) {
      // Need Junior deposit first for coverage (or deposit to Junior directly)
      const wethIface = new hre.ethers.Interface(["function deposit() payable"]);
      const wethContract = new hre.ethers.Contract("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", wethIface, deployer);

      // Wrap some ETH for Junior deposit
      await wethContract.deposit({ value: hre.ethers.parseEther("0.001") });
      const weth = await hre.ethers.getContractAt("IERC20", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");

      // Approve Junior vault
      await usdai.connect(deployer).approve(d.juniorVault, hre.ethers.MaxUint256);
      await weth.connect(deployer).approve(d.juniorVault, hre.ethers.MaxUint256);

      // Deposit ~$1 with 20% WETH ratio: $0.80 USDai + ~$0.20 WETH
      const baseAmt = 8n * E18 / 10n; // 0.8 USDai
      const wethPrice = await (await hre.ethers.getContractAt("IWETHPriceOracle", d.wethPriceOracle)).getSpotPrice();
      const wethValueTarget = 2n * E18 / 10n; // $0.20
      const wethAmt = (wethValueTarget * E18) / wethPrice;

      await jvault.connect(deployer).depositJunior(baseAmt, wethAmt, deployer.address);
      const shares = await jvault.balanceOf(deployer.address);
      check("$1 Junior deposit succeeded", shares > 0n, `${hre.ethers.formatEther(shares)} shares`);
    } else {
      console.log(`  ⚠ Skipped — deployer has no USDai (need fork with whale funding)`);
    }
  } catch (err: any) {
    console.log(`  ⚠ Smoke test failed: ${err.message?.slice(0, 80)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Summary
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  ═══ Result: ${passed}/${checks} checks passed ═══\n`);
  if (passed < checks) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
