import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("Governance — Guardian role", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let mockUSDai: any;
  let mockSUSDai: any;

  let owner: SignerWithAddress;
  let guardian: SignerWithAddress;
  let seniorVault: SignerWithAddress;
  let mezzVault: SignerWithAddress;
  let juniorVault: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  beforeEach(async () => {
    [owner, guardian, seniorVault, mezzVault, juniorVault, other] = await ethers.getSigners();

    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18);
    await mockUSDai.mint(await mockSUSDai.getAddress(), 10_000_000n * E18);

    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockSUSDai.getAddress(), owner.address);

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(),
      await strategy.getAddress(),
      ethers.ZeroAddress, // aprFeed
      ethers.ZeroAddress, // redemptionPolicy
      ethers.ZeroAddress, // erc20Cooldown
      ethers.ZeroAddress, // sharesCooldown
      await mockSUSDai.getAddress(),
      owner.address,
    );

    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(MEZZ, mezzVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PrimeCDO — setGuardian
  // ═══════════════════════════════════════════════════════════════════

  describe("PrimeCDO — setGuardian", () => {
    it("should allow owner to set guardian", async () => {
      await expect(cdo.connect(owner).setGuardian(guardian.address))
        .to.emit(cdo, "GuardianSet")
        .withArgs(guardian.address);
      expect(await cdo.s_guardian()).to.equal(guardian.address);
    });

    it("should revert when non-owner calls setGuardian", async () => {
      await expect(cdo.connect(other).setGuardian(guardian.address)).to.be.reverted;
    });

    it("should allow owner to clear guardian (zero address)", async () => {
      await cdo.connect(owner).setGuardian(guardian.address);
      await cdo.connect(owner).setGuardian(ethers.ZeroAddress);
      expect(await cdo.s_guardian()).to.equal(ethers.ZeroAddress);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PrimeCDO — triggerShortfallPause
  // ═══════════════════════════════════════════════════════════════════

  describe("PrimeCDO — triggerShortfallPause", () => {
    beforeEach(async () => {
      await cdo.connect(owner).setGuardian(guardian.address);
    });

    it("should allow guardian to trigger emergency pause", async () => {
      await expect(cdo.connect(guardian).triggerShortfallPause())
        .to.emit(cdo, "EmergencyPauseTriggered")
        .withArgs(guardian.address);
      expect(await cdo.s_shortfallPaused()).to.equal(true);
    });

    it("should revert when non-guardian calls triggerShortfallPause", async () => {
      await expect(cdo.connect(other).triggerShortfallPause()).to.be.reverted;
    });

    it("should revert when owner (not guardian) calls triggerShortfallPause", async () => {
      await expect(cdo.connect(owner).triggerShortfallPause()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PrimeCDO — unpauseShortfall (owner or guardian)
  // ═══════════════════════════════════════════════════════════════════

  describe("PrimeCDO — unpauseShortfall", () => {
    beforeEach(async () => {
      await cdo.connect(owner).setGuardian(guardian.address);
      await cdo.connect(guardian).triggerShortfallPause();
    });

    it("should allow owner to unpause", async () => {
      await expect(cdo.connect(owner).unpauseShortfall()).to.emit(cdo, "ShortfallUnpaused");
      expect(await cdo.s_shortfallPaused()).to.equal(false);
    });

    it("should allow guardian to unpause", async () => {
      await expect(cdo.connect(guardian).unpauseShortfall()).to.emit(cdo, "ShortfallUnpaused");
      expect(await cdo.s_shortfallPaused()).to.equal(false);
    });

    it("should revert when non-owner non-guardian calls unpause", async () => {
      await expect(cdo.connect(other).unpauseShortfall()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PrimeCDO — Guardian does NOT have owner-only powers
  // ═══════════════════════════════════════════════════════════════════

  describe("PrimeCDO — Guardian permission boundaries", () => {
    beforeEach(async () => {
      await cdo.connect(owner).setGuardian(guardian.address);
    });

    it("should revert when guardian calls setMinCoverageForDeposit", async () => {
      await expect(cdo.connect(guardian).setMinCoverageForDeposit(2n * E18)).to.be.reverted;
    });

    it("should revert when guardian calls setJuniorShortfallPausePrice", async () => {
      await expect(cdo.connect(guardian).setJuniorShortfallPausePrice(0)).to.be.reverted;
    });

    it("should revert when guardian calls registerTranche", async () => {
      await expect(cdo.connect(guardian).registerTranche(SENIOR, other.address)).to.be.reverted;
    });

    it("should revert when guardian calls claimReserve", async () => {
      await expect(cdo.connect(guardian).claimReserve(guardian.address)).to.be.reverted;
    });

    it("should revert when guardian calls setGuardian", async () => {
      await expect(cdo.connect(guardian).setGuardian(other.address)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  BaseStrategy — Guardian can pause/unpause
  // ═══════════════════════════════════════════════════════════════════

  describe("BaseStrategy — Guardian pause", () => {
    beforeEach(async () => {
      await strategy.connect(owner).setGuardian(guardian.address);
    });

    it("should allow owner to pause", async () => {
      await strategy.connect(owner).pause();
      expect(await strategy.paused()).to.equal(true);
    });

    it("should allow guardian to pause", async () => {
      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.equal(true);
    });

    it("should allow guardian to unpause", async () => {
      await strategy.connect(owner).pause();
      await strategy.connect(guardian).unpause();
      expect(await strategy.paused()).to.equal(false);
    });

    it("should revert when non-owner non-guardian calls pause", async () => {
      await expect(strategy.connect(other).pause()).to.be.reverted;
    });

    it("should emit GuardianSet event", async () => {
      await expect(strategy.connect(owner).setGuardian(other.address))
        .to.emit(strategy, "GuardianSet")
        .withArgs(other.address);
    });
  });
});
