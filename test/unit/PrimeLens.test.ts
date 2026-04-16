import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("PrimeLens — Read-only aggregator", () => {
  let lens: any;
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let redemptionPolicy: any;
  let erc20Cooldown: any;
  let sharesCooldown: any;
  let seniorVault: any;
  let mezzVault: any;
  let juniorVault: any;
  let mockUSDai: any;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const E18 = 10n ** 18n;
  const DAY = 86400;

  async function seedTVL(tranche: number, amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await accounting.connect(cdoSigner).recordDeposit(tranche, amount);
    await mockUSDai.mint(await strategy.getAddress(), amount);
  }

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    // --- Tokens ---
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");

    // --- Accounting ---
    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // --- Cooldown handlers ---
    const EC20Factory = await ethers.getContractFactory("ERC20Cooldown");
    erc20Cooldown = await EC20Factory.deploy(owner.address);
    const SCFactory = await ethers.getContractFactory("SharesCooldown");
    sharesCooldown = await SCFactory.deploy(owner.address);

    // --- RedemptionPolicy ---
    const RPFactory = await ethers.getContractFactory("RedemptionPolicy");
    redemptionPolicy = await RPFactory.deploy(owner.address, await accounting.getAddress());

    // --- Predict CDO address: Strategy(+0), CDO(+1) ---
    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("MockStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockUSDai.getAddress());

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), ethers.ZeroAddress, owner.address,
    );

    // --- Deploy TrancheVaults ---
    const VaultFactory = await ethers.getContractFactory("TrancheVault");
    seniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), SENIOR, await mockUSDai.getAddress(),
      "PrimeVaults Senior", "pvSENIOR",
    );
    mezzVault = await VaultFactory.deploy(
      await cdo.getAddress(), MEZZ, await mockUSDai.getAddress(),
      "PrimeVaults Mezzanine", "pvMEZZ",
    );
    juniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), JUNIOR, await mockUSDai.getAddress(),
      "PrimeVaults Junior", "pvJUNIOR",
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, await seniorVault.getAddress());
    await cdo.connect(owner).registerTranche(MEZZ, await mezzVault.getAddress());
    await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);
    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    // --- Deploy PrimeLens ---
    const LensFactory = await ethers.getContractFactory("PrimeLens");
    lens = await LensFactory.deploy(
      await cdo.getAddress(),
      await seniorVault.getAddress(),
      await mezzVault.getAddress(),
      await juniorVault.getAddress(),
    );

    // --- Seed some TVL ---
    await seedTVL(JUNIOR, 100_000n * E18);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getTrancheInfo
  // ═══════════════════════════════════════════════════════════════════

  describe("getTrancheInfo", () => {
    it("should return correct Senior tranche info", async () => {
      await seedTVL(SENIOR, 50_000n * E18);

      const info = await lens.getTrancheInfo(SENIOR);
      expect(info.vault).to.equal(await seniorVault.getAddress());
      expect(info.name).to.equal("PrimeVaults Senior");
      expect(info.symbol).to.equal("pvSENIOR");
      expect(info.totalAssets).to.equal(50_000n * E18);
      // No deposits through vault, so totalSupply = 0
      expect(info.totalSupply).to.equal(0n);
      // Share price = 1e18 when supply is 0
      expect(info.sharePrice).to.equal(E18);
    });

    it("should return correct share price after deposits", async () => {
      await seedTVL(JUNIOR, 400_000n * E18); // ensure coverage

      await mockUSDai.mint(alice.address, 100_000n * E18);
      await mockUSDai.connect(alice).approve(await seniorVault.getAddress(), ethers.MaxUint256);
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);

      const info = await lens.getTrancheInfo(SENIOR);
      expect(info.totalAssets).to.equal(10_000n * E18);
      expect(info.totalSupply).to.equal(10_000n * E18);
      expect(info.sharePrice).to.equal(E18); // 1:1
    });

    it("should return Junior tranche info", async () => {
      const info = await lens.getTrancheInfo(JUNIOR);
      expect(info.vault).to.equal(await juniorVault.getAddress());
      expect(info.name).to.equal("PrimeVaults Junior");
      expect(info.totalAssets).to.equal(100_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getAllTranches
  // ═══════════════════════════════════════════════════════════════════

  describe("getAllTranches", () => {
    it("should return all three tranches in one call", async () => {
      await seedTVL(SENIOR, 50_000n * E18);
      await seedTVL(MEZZ, 20_000n * E18);

      const [sr, mz, jr] = await lens.getAllTranches();
      expect(sr.name).to.equal("PrimeVaults Senior");
      expect(sr.totalAssets).to.equal(50_000n * E18);
      expect(mz.name).to.equal("PrimeVaults Mezzanine");
      expect(mz.totalAssets).to.equal(20_000n * E18);
      expect(jr.name).to.equal("PrimeVaults Junior");
      expect(jr.totalAssets).to.equal(100_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getProtocolHealth
  // ═══════════════════════════════════════════════════════════════════

  describe("getProtocolHealth", () => {
    it("should return TVLs and coverage ratios", async () => {
      await seedTVL(SENIOR, 10_000n * E18);
      await seedTVL(MEZZ, 5_000n * E18);

      const health = await lens.getProtocolHealth();
      expect(health.seniorTVL).to.equal(10_000n * E18);
      expect(health.mezzTVL).to.equal(5_000n * E18);
      expect(health.juniorTVL).to.equal(100_000n * E18);
      expect(health.totalTVL).to.equal(115_000n * E18);

      // cs = (10K+5K+100K)/10K = 11.5
      expect(health.coverageSenior).to.equal(115n * E18 / 10n);
      // cm = (5K+100K)/5K = 21
      expect(health.coverageMezz).to.equal(21n * E18);

      expect(health.shortfallPaused).to.be.false;
    });

    it("should return max coverage when Senior is 0", async () => {
      const health = await lens.getProtocolHealth();
      expect(health.coverageSenior).to.equal(ethers.MaxUint256);
    });

    it("should reflect shortfall pause state", async () => {
      // Artificially pause
      const cdoAddr = await cdo.getAddress();
      // Set pause price to max so any check triggers pause
      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);

      // Create a mock Jr vault token for shortfall check
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      const mockJrVault = await TokenFactory.deploy("pvJR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(alice.address, 10_000n * E18);

      // Trigger any action to check shortfall
      await mockUSDai.mint(alice.address, 100_000n * E18);
      const srVaultAddr = await seniorVault.getAddress();
      await mockUSDai.connect(alice).approve(srVaultAddr, ethers.MaxUint256);
      try { await seniorVault.connect(alice).deposit(100n * E18, alice.address); } catch {}

      // Re-register original jr vault for lens
      await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());

      const health = await lens.getProtocolHealth();
      expect(health.shortfallPaused).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getUserPendingWithdraws
  // ═══════════════════════════════════════════════════════════════════

  describe("getUserPendingWithdraws", () => {
    it("should return empty array when user has no pending withdrawals", async () => {
      const withdraws = await lens.getUserPendingWithdraws(alice.address);
      expect(withdraws.length).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  previewWithdrawCondition
  // ═══════════════════════════════════════════════════════════════════

  describe("previewWithdrawCondition", () => {
    it("should return NONE for Senior tranche (always instant)", async () => {
      const cond = await lens.previewWithdrawCondition(SENIOR);
      expect(cond.mechanism).to.equal(0); // NONE
    });

    it("should return coverage ratios alongside mechanism", async () => {
      await seedTVL(SENIOR, 10_000n * E18);
      await seedTVL(MEZZ, 5_000n * E18);

      const cond = await lens.previewWithdrawCondition(MEZZ);
      expect(cond.coverageSenior).to.be.gt(0n);
      expect(cond.coverageMezz).to.be.gt(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getClaimableWithdraws
  // ═══════════════════════════════════════════════════════════════════

  describe("getClaimableWithdraws", () => {
    it("should return empty array when user has no claimable withdrawals", async () => {
      const claimable = await lens.getClaimableWithdraws(alice.address);
      expect(claimable.length).to.equal(0);
    });
  });

});
