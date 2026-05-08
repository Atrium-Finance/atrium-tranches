// Regression test for audit finding H#1:
// "PrimeCDO.requestWithdraw — stale baseAmount across in-call loss waterfall"
//
// Scenario: TrancheVault quotes baseAmount = convertToAssets(shares) BEFORE calling
// PrimeCDO.requestWithdraw. CDO then runs _updateAccounting(), which can apply a loss
// waterfall (e.g. sUSDai rate drop) that lowers the tranche TVL. Without the fix, the
// stale baseAmount is used to compute fee + withdraw, letting the user over-extract
// from the strategy at the expense of Senior holders.
//
// Fix: PrimeCDO recomputes baseAmount from (vaultShares × freshTVL / vaultSupply)
// after _updateAccounting. This regression test proves the recompute happens.

import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const JUNIOR = 1;

const E18 = 10n ** 18n;

describe("PrimeCDO — H#1 stale baseAmount race", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let redemptionPolicy: any;
  let erc20Cooldown: any;
  let sharesCooldown: any;
  let mockUSDai: any;
  let mockSUSDai: any;
  let seniorVault: any;
  let juniorVault: any;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let beneficiary: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, beneficiary] = await ethers.getSigners();

    // Tokens — use MockStakedUSDai because it backs sUSDai shares with USDai (real strategy expects this).
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18); // rate = 1.0
    // Pre-fund sUSDai vault with USDai so deposits/withdraws can settle
    await mockUSDai.mint(await mockSUSDai.getAddress(), 10_000_000n * E18);

    // Risk + accounting
    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // Cooldowns
    const EC20Factory = await ethers.getContractFactory("ERC20Cooldown");
    erc20Cooldown = await EC20Factory.deploy(owner.address);
    const SCFactory = await ethers.getContractFactory("SharesCooldown");
    sharesCooldown = await SCFactory.deploy(owner.address);

    // RedemptionPolicy
    const RPFactory = await ethers.getContractFactory("RedemptionPolicy");
    redemptionPolicy = await RPFactory.deploy(owner.address, await accounting.getAddress());

    // Predict CDO (Strategy +0, CDO +1)
    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockSUSDai.getAddress(), owner.address);

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      ethers.ZeroAddress, // aprFeed
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), await mockSUSDai.getAddress(), owner.address,
    );

    // Real TrancheVaults (so totalSupply/share math works)
    const VaultFactory = await ethers.getContractFactory("TrancheVault");
    seniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), SENIOR, await mockUSDai.getAddress(),
      "PrimeVaults Senior", "pvSENIOR",
    );
    juniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), JUNIOR, await mockUSDai.getAddress(),
      "PrimeVaults Junior", "pvJUNIOR",
    );

    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, await seniorVault.getAddress());
    await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());
    await cdo.connect(owner).setJuniorShortfallPausePrice(0); // disable auto-pause for the test

    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    // Fund Alice with USDai
    await mockUSDai.mint(alice.address, 1_000_000n * E18);
    await mockUSDai.connect(alice).approve(await seniorVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(alice).approve(await juniorVault.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Core regression: SHARES_LOCK path exposes the bug via fee accounting.
  //
  //  Flow:
  //    1. Alice deposits Sr=8000 + Jr=2000 USDai (cs = 10000/8000 = 1.25 → SHARES_LOCK).
  //    2. Strategy ends up holding 10000 sUSDai (rate 1.0 at deposit).
  //    3. Drop sUSDai rate to 0.95 → strategy.totalAssets() = 9500 → loss = 500.
  //    4. Alice calls juniorVault.requestWithdraw(allShares).
  //       - TrancheVault quotes baseAmount = totalAssets() = 2000 (stale Junior TVL).
  //       - CDO._updateAccounting applies loss waterfall → Junior TVL drops 2000 → 1500.
  //       - With fix: baseAmount recomputed to freshTVL = 1500 (full drain).
  //       - Without fix: baseAmount remains 2000.
  //       - Junior SHARES_LOCK fee = 100 bps → fee = 0.01 × baseAmount.
  //       - With fix: feeAmount = 15 USDai. Without fix: feeAmount = 20 USDai.
  // ═══════════════════════════════════════════════════════════════════

  it("should recompute baseAmount from post-update TVL when sUSDai rate drops mid-call", async () => {
    // Deposit Sr=8000, Jr=2000 → cs = 1.25 → SHARES_LOCK for Junior
    await juniorVault.connect(alice).deposit(2_000n * E18, alice.address);
    await seniorVault.connect(alice).deposit(8_000n * E18, alice.address);

    // Sanity: Junior holds 2000 shares & 2000 base TVL
    expect(await juniorVault.totalSupply()).to.equal(2_000n * E18);
    expect(await accounting.s_juniorBaseTVL()).to.equal(2_000n * E18);

    // Strategy holds 10000 sUSDai backing 10000 USDai value
    const stratBalance = await mockSUSDai.balanceOf(await strategy.getAddress());
    expect(stratBalance).to.equal(10_000n * E18);

    // Drop sUSDai rate 5% → strategy.totalAssets() = 9500 → loss waterfall on next _updateAccounting
    await mockSUSDai.setRate((95n * E18) / 100n);

    // Alice withdraws ALL Junior shares → triggers CDO.requestWithdraw with vaultShares = totalSupply.
    // At entry to TrancheVault.requestWithdraw, baseAmount captured = 2000 (pre-_updateAccounting).
    const tx = await juniorVault.connect(alice).requestWithdraw(2_000n * E18, beneficiary.address);
    const receipt = await tx.wait();

    // Locate FeeRecorded event from Accounting (recordFee is called by CDO with the post-update baseAmount × feeBps).
    const accountingIface = accounting.interface;
    const feeRecordedTopic = accountingIface.getEvent("FeeRecorded").topicHash;
    const feeLogs = receipt.logs.filter((l: any) => l.topics[0] === feeRecordedTopic);
    expect(feeLogs.length).to.equal(1);
    const feeEvent = accountingIface.parseLog(feeLogs[0])!;

    const tranche = Number(feeEvent.args.tranche);
    const feeAmount: bigint = feeEvent.args.feeAmount;
    expect(tranche).to.equal(JUNIOR);

    // After fix: baseAmount = freshTVL = 1500 USDai (Junior absorbed 500 loss).
    //            fee = 1500 × 100 / 10_000 = 15 USDai.
    // Without fix: fee would have been 1500 × 100 / 10_000 = 20 USDai (using stale 2000).
    const expectedWithFix = (1_500n * E18 * 100n) / 10_000n; // 15 USDai
    const expectedWithoutFix = (2_000n * E18 * 100n) / 10_000n; // 20 USDai

    expect(feeAmount).to.equal(expectedWithFix);
    expect(feeAmount).to.not.equal(expectedWithoutFix);
  });

  it("should partial-rate baseAmount = vaultShares × freshTVL / vaultSupply", async () => {
    // Alice deposits Sr=8000 + Jr=4000 → cs = 12000/8000 = 1.50 → Junior ASSETS_LOCK (140-160%).
    await juniorVault.connect(alice).deposit(4_000n * E18, alice.address);
    await seniorVault.connect(alice).deposit(8_000n * E18, alice.address);

    expect(await juniorVault.totalSupply()).to.equal(4_000n * E18);

    // Drop sUSDai rate 5% → loss = 0.05 × 12000 = 600 → Junior 4000 - 600 = 3400.
    // Post-loss cs = 11400 / 8000 = 1.425 → still ASSETS_LOCK band (140-160%).
    await mockSUSDai.setRate((95n * E18) / 100n);

    // Alice withdraws HALF her Junior shares (2000 of 4000) → partial redeem.
    // After fix: baseAmount = 2000 × 3400 / 4000 = 1700.
    // Without fix: baseAmount = convertToAssets(2000) = 2000 (stale).
    // ASSETS_LOCK fee = 20 bps → with fix = 1700 × 20 / 10000 = 3.4; without = 2000 × 20 / 10000 = 4.0.
    const tx = await juniorVault.connect(alice).requestWithdraw(2_000n * E18, beneficiary.address);
    const receipt = await tx.wait();

    const feeRecordedTopic = accounting.interface.getEvent("FeeRecorded").topicHash;
    const feeLog = receipt.logs.find((l: any) => l.topics[0] === feeRecordedTopic);
    expect(feeLog).to.not.be.undefined;
    const feeEvent = accounting.interface.parseLog(feeLog)!;
    const feeAmount: bigint = feeEvent.args.feeAmount;

    const expectedWithFix = (1_700n * E18 * 20n) / 10_000n; // 3.4 USDai
    const expectedWithoutFix = (2_000n * E18 * 20n) / 10_000n; // 4.0 USDai

    expect(feeAmount).to.equal(expectedWithFix);
    expect(feeAmount).to.not.equal(expectedWithoutFix);
  });

  it("should re-quote baseAmount UPWARD when sUSDai rate rises mid-call (gain path)", async () => {
    // Sr=8000, Jr=2000 → cs = 10000/8000 = 1.25 → Junior SHARES_LOCK band.
    await juniorVault.connect(alice).deposit(2_000n * E18, alice.address);
    await seniorVault.connect(alice).deposit(8_000n * E18, alice.address);

    // Rate rises 5% → strategy.totalAssets() = 10500 → gain = 500.
    // With aprFeed = ZeroAddress, Senior APY = 0 → seniorGainTarget = 0 →
    // gain split: reserveCut = 25 (5% bps), Junior residual = 475.
    // → fresh Junior TVL = 2000 + 475 = 2475 (Alice's full position grows).
    await mockSUSDai.setRate((105n * E18) / 100n);

    const tx = await juniorVault.connect(alice).requestWithdraw(2_000n * E18, beneficiary.address);
    const receipt = await tx.wait();

    const feeRecordedTopic = accounting.interface.getEvent("FeeRecorded").topicHash;
    const feeLog = receipt.logs.find((l: any) => l.topics[0] === feeRecordedTopic);
    expect(feeLog).to.not.be.undefined;
    const feeEvent = accounting.interface.parseLog(feeLog)!;
    const feeAmount: bigint = feeEvent.args.feeAmount;

    // After fix: full drain → baseAmount = freshTVL = 2475 (Alice captures her gain).
    //            SHARES_LOCK fee = 100 bps → fee = 2475 × 100 / 10000 = 24.75 USDai.
    // Without fix: stale baseAmount = 2000 → fee = 20 USDai (Alice loses 4.75 of gain to old rounding).
    const expectedWithFix = (2_475n * E18 * 100n) / 10_000n; // 24.75 USDai
    const expectedWithoutFix = (2_000n * E18 * 100n) / 10_000n; // 20 USDai

    expect(feeAmount).to.equal(expectedWithFix);
    expect(feeAmount).to.not.equal(expectedWithoutFix);
  });

  it("should leave fee unchanged when no loss occurs in _updateAccounting (no race)", async () => {
    // No rate drop → strategy.totalAssets() matches Accounting → no loss waterfall.
    await juniorVault.connect(alice).deposit(2_000n * E18, alice.address);
    await seniorVault.connect(alice).deposit(8_000n * E18, alice.address);

    // requestWithdraw without any rate manipulation. Junior cs = 1.25 → SHARES_LOCK.
    const tx = await juniorVault.connect(alice).requestWithdraw(2_000n * E18, beneficiary.address);
    const receipt = await tx.wait();

    const feeRecordedTopic = accounting.interface.getEvent("FeeRecorded").topicHash;
    const feeLog = receipt.logs.find((l: any) => l.topics[0] === feeRecordedTopic);
    expect(feeLog).to.not.be.undefined;
    const feeEvent = accounting.interface.parseLog(feeLog)!;
    const feeAmount: bigint = feeEvent.args.feeAmount;

    // No race → freshTVL == quoted TVL == 2000 → fee = 2000 × 100 / 10000 = 20.
    expect(feeAmount).to.equal((2_000n * E18 * 100n) / 10_000n);
  });

  it("should revert if vaultShares = 0 after the recompute path is enforced", async () => {
    // Direct call to CDO simulating a misuse — bypassing TrancheVault.
    // Empty Junior tranche (no shares minted) → vaultSupply = 0 → freshTVL irrelevant → revert.
    await ethers.provider.send("hardhat_setBalance", [await juniorVault.getAddress(), "0x56BC75E2D63100000"]);
    const vaultSigner = await ethers.getImpersonatedSigner(await juniorVault.getAddress());

    await expect(
      cdo.connect(vaultSigner).requestWithdraw(JUNIOR, 100n * E18, beneficiary.address, 0)
    ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ZeroAmount");
  });
});
