import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("PrimeCDO — Deposits (per-tranche coverage)", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let mockUSDai: any;
  let mockSUSDai: any;

  let owner: SignerWithAddress;
  let seniorVault: SignerWithAddress;
  let mezzVault: SignerWithAddress;
  let juniorVault: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

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
    [owner, seniorVault, mezzVault, juniorVault, other] = await ethers.getSigners();

    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18);
    await mockUSDai.mint(await mockSUSDai.getAddress(), 10_000_000n * E18);

    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // Predict CDO address: Strategy(+0), CDO(+1)
    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(
      predictedCDO, await mockUSDai.getAddress(), await mockSUSDai.getAddress(), owner.address,
    );

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
      await mockSUSDai.getAddress(), owner.address,
    );

    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(MEZZ, mezzVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);

    await mockUSDai.mint(seniorVault.address, 100_000n * E18);
    await mockUSDai.mint(mezzVault.address, 100_000n * E18);
    await mockUSDai.mint(juniorVault.address, 100_000n * E18);
    await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(mezzVault).approve(await cdo.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(juniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Senior deposit — cs = (Sr+Mz+Jr)/Sr
  // ═══════════════════════════════════════════════════════════════════

  describe("Senior deposit — healthy cs", () => {
    beforeEach(async () => {
      // Sr=1K, Jr=10K → cs = 11K/1K = 11x >> 1.05x ✓
      await seedTVL(SENIOR, 1_000n * E18);
      await seedTVL(JUNIOR, 10_000n * E18);
    });

    it("should succeed when cs > 105%", async () => {
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 1_000n * E18),
      ).to.not.be.reverted;
    });

    it("should record deposit in accounting", async () => {
      const before = await accounting.s_seniorTVL();
      await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 1_000n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(before + 1_000n * E18);
    });
  });

  describe("Senior deposit — low cs", () => {
    it("should allow first Senior deposit (empty protocol → cs=max)", async () => {
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 1_000n * E18),
      ).to.not.be.reverted;
    });

    it("should revert when cs < 105% (Sr very large vs Jr+Mz)", async () => {
      // Sr=100K, Jr=1K, Mz=0 → cs = 101K/100K = 1.01x < 1.05x
      await seedTVL(SENIOR, 100_000n * E18);
      await seedTVL(JUNIOR, 1_000n * E18);
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 1_000n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__CoverageTooLow");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Mezz deposit — cm = (Mz+Jr)/Mz
  // ═══════════════════════════════════════════════════════════════════

  describe("Mezz deposit — healthy cm", () => {
    it("should succeed when cm > 105%", async () => {
      // Mz=1K, Jr=10K → cm = 11K/1K = 11x ✓
      await seedTVL(MEZZ, 1_000n * E18);
      await seedTVL(JUNIOR, 10_000n * E18);
      await expect(
        cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18),
      ).to.not.be.reverted;
    });
  });

  describe("Mezz deposit — low cm (even if cs is fine)", () => {
    it("should revert when cm < 105% even if cs is healthy", async () => {
      // Sr=1K, Mz=100K, Jr=1K
      // cs = (1K+100K+1K)/1K = 102x ✓ (very healthy for Sr)
      // cm = (100K+1K)/100K = 1.01x < 1.05x ✗ (Mz gate blocks)
      await seedTVL(SENIOR, 1_000n * E18);
      await seedTVL(MEZZ, 100_000n * E18);
      await seedTVL(JUNIOR, 1_000n * E18);
      await expect(
        cdo.connect(mezzVault).deposit(MEZZ, await mockUSDai.getAddress(), 500n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__CoverageTooLow");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior deposit — ALWAYS allowed (uses deposit(), coverage gate skipped)
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior deposit — always allowed", () => {
    it("should succeed even when cs and cm < 105%", async () => {
      // Deliberately bad coverage for both Sr and Mz
      await seedTVL(SENIOR, 100_000n * E18);
      await seedTVL(MEZZ, 100_000n * E18);
      await seedTVL(JUNIOR, 1_000n * E18);
      // cs ≈ 1.01x, cm ≈ 1.01x — both < 1.05x

      await expect(
        cdo.connect(juniorVault).deposit(JUNIOR, await mockUSDai.getAddress(), 10_000n * E18),
      ).to.not.be.reverted;
    });

    it("should succeed on empty protocol", async () => {
      await expect(
        cdo.connect(juniorVault).deposit(JUNIOR, await mockUSDai.getAddress(), 10_000n * E18),
      ).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Shortfall paused → all deposits revert
  // ═══════════════════════════════════════════════════════════════════

  describe("shortfall paused", () => {
    let mockJrVault: any;

    beforeEach(async () => {
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());

      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await mockJrVault.mint(other.address, 10_000n * E18);
    });

    it("should revert all deposits when shortfall paused", async () => {
      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);
      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should allow deposits after unpause", async () => {
      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);
      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      await cdo.connect(owner).unpauseShortfall();
      await cdo.connect(owner).setJuniorShortfallPausePrice(0);
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Scenario: Junior absorbs loss → shortfall pause
  // ═══════════════════════════════════════════════════════════════════

  describe("scenario: Junior absorbs loss → shortfall pause", () => {
    let mockJrVault: any;

    beforeEach(async () => {
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(other.address, 10_000n * E18);
    });

    it("should auto-pause when Junior pricePerShare < 90%", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      // Simulate 20% loss: Jr TVL 10K → 8K AND reduce strategy assets to match
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      // Burn matching sUSDai from strategy so updateTVL sees the loss
      const stratAddr = await strategy.getAddress();
      const stratSigner = await ethers.getImpersonatedSigner(stratAddr);
      await ethers.provider.send("hardhat_setBalance", [stratAddr, "0x56BC75E2D63100000"]);
      await mockSUSDai.connect(stratSigner).transfer(owner.address, 2_000n * E18);

      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;
    });

    it("should NOT pause if loss < 10%", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      await accounting.connect(await ethers.getImpersonatedSigner(cdoAddr)).recordWithdraw(JUNIOR, 500n * E18);

      try { await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18); } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert deposit from non-tranche caller", async () => {
      await expect(
        cdo.connect(other).deposit(SENIOR, await mockUSDai.getAddress(), 1_000n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__Unauthorized");
    });

    it("should revert deposit with zero amount", async () => {
      await seedTVL(SENIOR, 1_000n * E18);
      await seedTVL(JUNIOR, 10_000n * E18);
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 0),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ZeroAmount");
    });
  });
});
