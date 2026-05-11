import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const JUNIOR = 1;

const NONE = 0;
const ASSETS_LOCK = 1;
const SHARES_LOCK = 2;

describe("PrimeCDO — Withdrawals", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let redemptionPolicy: any;
  let erc20Cooldown: any;
  let sharesCooldown: any;
  let mockUSDai: any;
  let mockSUSDai: any;

  let owner: SignerWithAddress;
  let seniorVault: SignerWithAddress;
  let juniorVault: SignerWithAddress;
  let beneficiary: SignerWithAddress;

  const E18 = 10n ** 18n;
  const DAY = 86400;

  async function seedTVL(tranche: number, amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await accounting.connect(cdoSigner).recordDeposit(tranche, amount);
    // Match strategy assets so updateTVL doesn't see phantom gain/loss
    const stratAddr = await strategy.getAddress();
    await mockUSDai.mint(owner.address, amount);
    await mockUSDai.connect(owner).approve(await mockSUSDai.getAddress(), amount);
    await mockSUSDai.connect(owner).deposit(amount, stratAddr);
  }

  beforeEach(async () => {
    [owner, seniorVault, juniorVault, beneficiary] = await ethers.getSigners();

    // --- Tokens ---
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18);
    await mockUSDai.mint(await mockSUSDai.getAddress(), 10_000_000n * E18);

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

    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(
      predictedCDO, await mockSUSDai.getAddress(), owner.address,
    );

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      ethers.ZeroAddress, // aprFeed
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), await mockSUSDai.getAddress(), owner.address,
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);

    // Authorize CDO in cooldown contracts
    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    // Fund vaults
    await mockUSDai.mint(seniorVault.address, 100_000n * E18);
    await mockUSDai.mint(juniorVault.address, 100_000n * E18);
    await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(juniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);

    // Seed base TVL and deposit real tokens so strategy has assets
    await seedTVL(JUNIOR, 10_000n * E18);
    await seedTVL(SENIOR, 2_000n * E18);
    await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 5_000n * E18);
    // State: Sr=7K, Jr=10K → cs = 17K/7K ≈ 2.43x
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Senior — ALWAYS INSTANT, no fee, no cooldown
  // ═══════════════════════════════════════════════════════════════════

  describe("Senior withdrawal — always instant", () => {
    it("should return instant result with 0 fee at high coverage", async () => {
      // cs ≈ 2.43x — healthy
      const result = await cdo.connect(seniorVault).requestWithdraw.staticCall(
        SENIOR, 1_000n * E18, beneficiary.address, 0,
      );
      expect(result.isInstant).to.be.true;
      expect(result.feeAmount).to.equal(0);
    });

    it("should return instant even at low coverage (cs ≈ 1.18x)", async () => {
      await seedTVL(SENIOR, 50_000n * E18); // Sr=57K, Jr=10K → cs ≈ 1.18x
      const result = await cdo.connect(seniorVault).requestWithdraw.staticCall(
        SENIOR, 1_000n * E18, beneficiary.address, 0,
      );
      expect(result.isInstant).to.be.true;
      expect(result.feeAmount).to.equal(0);
    });

    it("should return instant at extreme low coverage (cs ≈ 1.01x)", async () => {
      await seedTVL(SENIOR, 990_000n * E18); // cs ≈ 1.01x
      const result = await cdo.connect(seniorVault).requestWithdraw.staticCall(
        SENIOR, 500n * E18, beneficiary.address, 0,
      );
      expect(result.isInstant).to.be.true;
      expect(result.feeAmount).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — instant when cs > 160%
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior withdrawal — instant (cs > 160%)", () => {
    it("should return instant via policy when cs is high", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(
        JUNIOR, (170n * E18) / 100n,
      );
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0);
      expect(result.cooldownDuration).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — ASSETS_LOCK when 140% < cs ≤ 160%
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior withdrawal — ASSETS_LOCK (140% < cs ≤ 160%)", () => {
    it("should return ASSETS_LOCK", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(
        JUNIOR, (150n * E18) / 100n,
      );
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(20);
      expect(result.cooldownDuration).to.equal(3 * DAY);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — SHARES_LOCK when cs ≤ 140%
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior withdrawal — SHARES_LOCK (coverage too low)", () => {
    it("should return SHARES_LOCK when cs is low", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(JUNIOR, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(100);
      expect(result.cooldownDuration).to.equal(7 * DAY);
    });

    it("should NEVER block Junior (extreme low → SHARES_LOCK with high fee)", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(JUNIOR, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(100); // 100 bps
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Fee calculation correct per mechanism
  // ═══════════════════════════════════════════════════════════════════

  describe("fee calculation", () => {
    it("should charge 0 fee for Senior (always instant)", async () => {
      const result = await cdo.connect(seniorVault).requestWithdraw.staticCall(
        SENIOR, 1_000n * E18, beneficiary.address, 0,
      );
      expect(result.feeAmount).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior ASSETS_LOCK — execute and claim path
  // ═══════════════════════════════════════════════════════════════════

  describe("claimWithdraw — ERC20Cooldown (ASSETS_LOCK)", () => {
    it("should release tokens to beneficiary after cooldown period", async () => {
      // Setup Junior at ASSETS_LOCK level (cs in (140%, 160%])
      // Sr=20K, Jr=12K → cs = 32K/20K = 1.6x → boundary, ASSETS_LOCK
      await seedTVL(SENIOR, 13_000n * E18); // Sr=15K (after 2K seed + 5K deposit + 13K seed = 20K)
      await seedTVL(JUNIOR, 2_000n * E18); // Jr=12K
      // Sr ~20K, Jr ~12K → cs = 32K/20K = 1.6x

      // Request withdrawal from Junior via direct CDO call (juniorVault is registered)
      await cdo.connect(juniorVault).requestWithdraw(
        JUNIOR, 1_000n * E18, beneficiary.address, 0,
      );

      // Wait for cooldown
      await time.increase(3 * DAY);

      const cooldownAddr = await erc20Cooldown.getAddress();
      await expect(cdo.claimWithdraw(1, cooldownAddr)).to.not.be.reverted;

      // Beneficiary should have received sUSDai
      expect(await mockSUSDai.balanceOf(beneficiary.address)).to.be.gt(0);
    });

    it("should revert claim before cooldown expires", async () => {
      await seedTVL(SENIOR, 13_000n * E18);
      await seedTVL(JUNIOR, 2_000n * E18);

      await cdo.connect(juniorVault).requestWithdraw(
        JUNIOR, 500n * E18, beneficiary.address, 0,
      );

      // Try to claim immediately (should fail)
      const cooldownAddr = await erc20Cooldown.getAddress();
      await expect(cdo.claimWithdraw(1, cooldownAddr)).to.be.reverted;
    });

    it("should revert if handler is not whitelisted", async () => {
      await expect(
        cdo.claimWithdraw(1, beneficiary.address),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__Unauthorized");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Shortfall paused → all withdrawals revert
  // ═══════════════════════════════════════════════════════════════════

  describe("shortfall paused", () => {
    it("should revert requestWithdraw for Senior when shortfall paused", async () => {
      let mockJrVault: any;
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(beneficiary.address, 10_000n * E18);

      await cdo.connect(owner).setGuardian(owner.address);
      await cdo.connect(owner).triggerShortfallPause();
      expect(await cdo.s_shortfallPaused()).to.be.true;

      await expect(
        cdo.connect(seniorVault).requestWithdraw(SENIOR, 100n * E18, beneficiary.address, 0),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should revert requestWithdraw for Junior when shortfall paused", async () => {
      let mockJrVault: any;
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      const mockJrVaultAddr = await mockJrVault.getAddress();
      await cdo.connect(owner).registerTranche(JUNIOR, mockJrVaultAddr);
      await mockJrVault.mint(beneficiary.address, 10_000n * E18);

      await cdo.connect(owner).setGuardian(owner.address);
      await cdo.connect(owner).triggerShortfallPause();
      expect(await cdo.s_shortfallPaused()).to.be.true;

      // Must call from the registered Junior vault
      const jrSigner = await ethers.getImpersonatedSigner(mockJrVaultAddr);
      await ethers.provider.send("hardhat_setBalance", [mockJrVaultAddr, "0x56BC75E2D63100000"]);
      await expect(
        cdo.connect(jrSigner).requestWithdraw(JUNIOR, 100n * E18, beneficiary.address, 0),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert requestWithdraw from non-tranche caller", async () => {
      await expect(
        cdo.connect(beneficiary).requestWithdraw(
          SENIOR, 100n * E18, beneficiary.address, 0,
        ),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__Unauthorized");
    });

    it("should revert requestWithdraw with zero amount", async () => {
      await expect(
        cdo.connect(seniorVault).requestWithdraw(
          SENIOR, 0, beneficiary.address, 0,
        ),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ZeroAmount");
    });
  });
});
