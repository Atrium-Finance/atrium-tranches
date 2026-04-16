import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

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
  let mezzVault: SignerWithAddress;
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
    [owner, seniorVault, mezzVault, juniorVault, beneficiary] = await ethers.getSigners();

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
      predictedCDO, await mockUSDai.getAddress(), await mockSUSDai.getAddress(),
      owner.address,
    );

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), await mockSUSDai.getAddress(), owner.address,
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(MEZZ, mezzVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
    await cdo.connect(owner).setJuniorShortfallPausePrice(0); // disable for tests

    // Authorize CDO in cooldown contracts
    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    // Fund vaults
    await mockUSDai.mint(seniorVault.address, 100_000n * E18);
    await mockUSDai.mint(mezzVault.address, 100_000n * E18);
    await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(mezzVault).approve(await cdo.getAddress(), ethers.MaxUint256);

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
  //  Mezz — instant at cs > 160%
  // ═══════════════════════════════════════════════════════════════════

  describe("Mezz withdrawal — instant (cs > 160%)", () => {
    beforeEach(async () => {
      await seedTVL(MEZZ, 1_000n * E18);
      await cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 2_000n * E18);
      // Sr=7K, Mz=3K, Jr=10K → cs = 20K/7K ≈ 2.86x > 160%
    });

    it("should return instant result with 0 fee", async () => {
      const result = await cdo.connect(mezzVault).requestWithdraw.staticCall(
        MEZZ, 500n * E18, beneficiary.address, 0,
      );
      expect(result.isInstant).to.be.true;
      expect(result.feeAmount).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Mezz — ASSETS_LOCK at 140% < cs ≤ 160%
  // ═══════════════════════════════════════════════════════════════════

  describe("Mezz withdrawal — ASSETS_LOCK (140% < cs ≤ 160%)", () => {
    beforeEach(async () => {
      // Sr=20K, Mz=1.5K, Jr=10K → cs = 31.5K/20K ≈ 1.575x → 140% < 1.575 ≤ 160%
      await seedTVL(SENIOR, 13_000n * E18);
      await seedTVL(MEZZ, 1_000n * E18);
      await cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18);
    });

    it("should return ASSETS_LOCK with fee and cooldown handler", async () => {
      const result = await cdo.connect(mezzVault).requestWithdraw.staticCall(
        MEZZ, 500n * E18, beneficiary.address, 0,
      );
      expect(result.isInstant).to.be.false;
      expect(result.appliedCooldownType).to.equal(1); // ASSETS_LOCK
      expect(result.cooldownHandler).to.equal(await erc20Cooldown.getAddress());
      // Mezz assetsLock fee = 10 bps → 500 * 10/10000 = 0.5
      expect(result.feeAmount).to.equal(5n * E18 / 10n);
    });

    it("should deduct fee and add to reserve", async () => {
      const reserveBefore = await accounting.s_reserveTVL();
      await cdo.connect(mezzVault).requestWithdraw(
        MEZZ, 1_000n * E18, beneficiary.address, 0,
      );
      const reserveAfter = await accounting.s_reserveTVL();
      // 10 bps of 1K = 1 USDai
      expect(reserveAfter - reserveBefore).to.equal(1n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Mezz — SHARES_LOCK at cs ≤ 140%
  // ═══════════════════════════════════════════════════════════════════

  describe("Mezz withdrawal — SHARES_LOCK (cs ≤ 140%)", () => {
    it("should return SHARES_LOCK at cs ≤ 140% via policy evaluation", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(MEZZ, 130n * E18 / 100n, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(50);
      expect(result.cooldownDuration).to.equal(7 * DAY);
    });

    it("should return SHARES_LOCK at cs exactly 140% (not > 140%)", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(MEZZ, 14n * E18 / 10n, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — instant when cs > 160% AND cm > 150%
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior withdrawal — instant (cs > 160% AND cm > 150%)", () => {
    it("should return instant via policy when both coverages high", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(
        JUNIOR, 170n * E18 / 100n, 160n * E18 / 100n,
      );
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0);
      expect(result.cooldownDuration).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — ASSETS_LOCK when cs > 140% AND cm > 130%
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior withdrawal — ASSETS_LOCK (cs > 140% AND cm > 130%)", () => {
    it("should return ASSETS_LOCK when both pass mid thresholds but not instant", async () => {
      // cs=150% (≤160%), cm=140% (≤150%) → not instant. cm>130% && cs>140% → ASSETS_LOCK
      const result = await redemptionPolicy.evaluateForCoverage(
        JUNIOR, 150n * E18 / 100n, 140n * E18 / 100n,
      );
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(20);
      expect(result.cooldownDuration).to.equal(3 * DAY);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — SHARES_LOCK when cs ≤ 140% OR cm ≤ 130%
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior withdrawal — SHARES_LOCK (coverage too low)", () => {
    it("should return SHARES_LOCK when both coverages low", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(JUNIOR, E18, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(100);
      expect(result.cooldownDuration).to.equal(7 * DAY);
    });

    it("should return SHARES_LOCK when cs=200% but cm=120% (cm fails)", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(
        JUNIOR, 200n * E18 / 100n, 120n * E18 / 100n,
      );
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return SHARES_LOCK when cm=200% but cs=130% (cs fails)", async () => {
      const result = await redemptionPolicy.evaluateForCoverage(
        JUNIOR, 130n * E18 / 100n, 200n * E18 / 100n,
      );
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should NEVER block Junior (extreme low → SHARES_LOCK with high fee)", async () => {
      // Even at cs=100%, cm=100% → still allowed, just SHARES_LOCK
      const result = await redemptionPolicy.evaluateForCoverage(JUNIOR, E18, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(100); // 100 bps — highest Jr shares lock fee
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior — fees higher than Mezz at same mechanism
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior fees higher than Mezz", () => {
    it("ASSETS_LOCK: Junior 20 bps > Mezz 10 bps", async () => {
      // Both in ASSETS_LOCK range
      const mzResult = await redemptionPolicy.evaluateForCoverage(MEZZ, 150n * E18 / 100n, E18);
      const jrResult = await redemptionPolicy.evaluateForCoverage(JUNIOR, 150n * E18 / 100n, 140n * E18 / 100n);
      expect(mzResult.mechanism).to.equal(ASSETS_LOCK);
      expect(jrResult.mechanism).to.equal(ASSETS_LOCK);
      expect(jrResult.feeBps).to.be.gt(mzResult.feeBps);
    });

    it("SHARES_LOCK: Junior 100 bps > Mezz 50 bps", async () => {
      const mzResult = await redemptionPolicy.evaluateForCoverage(MEZZ, E18, E18);
      const jrResult = await redemptionPolicy.evaluateForCoverage(JUNIOR, E18, E18);
      expect(mzResult.mechanism).to.equal(SHARES_LOCK);
      expect(jrResult.mechanism).to.equal(SHARES_LOCK);
      expect(jrResult.feeBps).to.be.gt(mzResult.feeBps);
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

    it("should charge correct Mezz ASSETS_LOCK fee (10 bps)", async () => {
      // Setup cs ≈ 1.575x
      await seedTVL(SENIOR, 13_000n * E18);
      await seedTVL(MEZZ, 1_000n * E18);
      await cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18);

      const result = await cdo.connect(mezzVault).requestWithdraw.staticCall(
        MEZZ, 1_000n * E18, beneficiary.address, 0,
      );
      // 10 bps of 1K = 1
      expect(result.feeAmount).to.equal(1n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Claim after cooldown succeeds
  // ═══════════════════════════════════════════════════════════════════

  describe("claimWithdraw — ERC20Cooldown (ASSETS_LOCK)", () => {
    it("should release tokens to beneficiary after cooldown period", async () => {
      // Setup Mezz ASSETS_LOCK
      await seedTVL(SENIOR, 13_000n * E18);
      await seedTVL(MEZZ, 1_000n * E18);
      await cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18);

      // Request withdrawal → ERC20Cooldown
      await cdo.connect(mezzVault).requestWithdraw(
        MEZZ, 1_000n * E18, beneficiary.address, 0,
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
      await seedTVL(MEZZ, 1_000n * E18);
      await cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18);

      await cdo.connect(mezzVault).requestWithdraw(
        MEZZ, 500n * E18, beneficiary.address, 0,
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

      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);
      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      await expect(
        cdo.connect(seniorVault).requestWithdraw(SENIOR, 100n * E18, beneficiary.address, 0),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should revert requestWithdraw for Mezz when shortfall paused", async () => {
      let mockJrVault: any;
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(beneficiary.address, 10_000n * E18);

      await seedTVL(MEZZ, 1_000n * E18);
      await cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18);

      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);
      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      await expect(
        cdo.connect(mezzVault).requestWithdraw(MEZZ, 100n * E18, beneficiary.address, 0),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should revert requestWithdraw for Junior when shortfall paused", async () => {
      let mockJrVault: any;
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      const mockJrVaultAddr = await mockJrVault.getAddress();
      await cdo.connect(owner).registerTranche(JUNIOR, mockJrVaultAddr);
      await mockJrVault.mint(beneficiary.address, 10_000n * E18);

      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);
      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      // Must call from the registered Junior vault (mockJrVault), not juniorVault signer
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
