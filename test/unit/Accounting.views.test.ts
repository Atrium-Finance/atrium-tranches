import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// TrancheId enum mirrors IPrimeCDO.sol
const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("Accounting — Part 1 (Views + Record)", () => {
  let accounting: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  beforeEach(async () => {
    [owner, cdo, other] = await ethers.getSigners();

    // Deploy dummy addresses for aprFeed and riskParams (not used in Part 1)
    const accounting_ = await ethers.getContractFactory("Accounting");
    accounting = await accounting_.deploy(owner.address, owner.address);

    // Set CDO
    await accounting.setCDO(cdo.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Constructor + Setup
  // ═══════════════════════════════════════════════════════════════════

  describe("constructor + setup", () => {
    it("should initialize srtTargetIndex to 1e18", async () => {
      expect(await accounting.s_srtTargetIndex()).to.equal(E18);
    });

    it("should set CDO address", async () => {
      expect(await accounting.s_primeCDO()).to.equal(cdo.address);
    });

    it("should revert setCDO if already set", async () => {
      await expect(accounting.setCDO(other.address))
        .to.be.revertedWithCustomError(accounting, "PrimeVaults__CDOAlreadySet");
    });

    it("should revert setCDO with zero address", async () => {
      const fresh = await (await ethers.getContractFactory("Accounting")).deploy(owner.address, owner.address);
      await expect(fresh.setCDO(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(fresh, "PrimeVaults__ZeroAddress");
    });

    it("should emit CDOSet event", async () => {
      const fresh = await (await ethers.getContractFactory("Accounting")).deploy(owner.address, owner.address);
      await expect(fresh.setCDO(cdo.address)).to.emit(fresh, "CDOSet").withArgs(cdo.address);
    });

    it("should have all TVLs at zero initially", async () => {
      expect(await accounting.s_seniorTVL()).to.equal(0);
      expect(await accounting.s_mezzTVL()).to.equal(0);
      expect(await accounting.s_juniorBaseTVL()).to.equal(0);
      expect(await accounting.s_reserveTVL()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  recordDeposit
  // ═══════════════════════════════════════════════════════════════════

  describe("recordDeposit", () => {
    it("should increase Senior TVL", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(1000n * E18);
    });

    it("should increase Mezzanine TVL", async () => {
      await accounting.connect(cdo).recordDeposit(MEZZ, 500n * E18);
      expect(await accounting.s_mezzTVL()).to.equal(500n * E18);
    });

    it("should increase Junior base TVL", async () => {
      await accounting.connect(cdo).recordDeposit(JUNIOR, 200n * E18);
      expect(await accounting.s_juniorBaseTVL()).to.equal(200n * E18);
    });

    it("should accumulate multiple deposits", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordDeposit(SENIOR, 500n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(1500n * E18);
    });

    it("should emit DepositRecorded event", async () => {
      await expect(accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18))
        .to.emit(accounting, "DepositRecorded")
        .withArgs(SENIOR, 1000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  recordWithdraw
  // ═══════════════════════════════════════════════════════════════════

  describe("recordWithdraw", () => {
    beforeEach(async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordDeposit(MEZZ, 500n * E18);
      await accounting.connect(cdo).recordDeposit(JUNIOR, 200n * E18);
    });

    it("should decrease Senior TVL", async () => {
      await accounting.connect(cdo).recordWithdraw(SENIOR, 300n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(700n * E18);
    });

    it("should decrease Mezzanine TVL", async () => {
      await accounting.connect(cdo).recordWithdraw(MEZZ, 100n * E18);
      expect(await accounting.s_mezzTVL()).to.equal(400n * E18);
    });

    it("should decrease Junior base TVL", async () => {
      await accounting.connect(cdo).recordWithdraw(JUNIOR, 50n * E18);
      expect(await accounting.s_juniorBaseTVL()).to.equal(150n * E18);
    });

    it("should clamp Senior TVL to 0 when withdraw > TVL (no underflow)", async () => {
      // _subFromTranche clamps to 0 instead of reverting; principal scales pro-rata to 0
      await accounting.connect(cdo).recordWithdraw(SENIOR, 1001n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(0n);
      expect(await accounting.s_seniorPrincipal()).to.equal(0n);
    });

    it("should emit WithdrawRecorded event", async () => {
      await expect(accounting.connect(cdo).recordWithdraw(SENIOR, 100n * E18))
        .to.emit(accounting, "WithdrawRecorded")
        .withArgs(SENIOR, 100n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  recordFee
  // ═══════════════════════════════════════════════════════════════════

  describe("recordFee", () => {
    it("should deduct from tranche and add to reserve", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordFee(SENIOR, 10n * E18);

      expect(await accounting.s_seniorTVL()).to.equal(990n * E18);
      expect(await accounting.s_reserveTVL()).to.equal(10n * E18);
    });

    it("should emit FeeRecorded event", async () => {
      await accounting.connect(cdo).recordDeposit(MEZZ, 500n * E18);
      await expect(accounting.connect(cdo).recordFee(MEZZ, 5n * E18))
        .to.emit(accounting, "FeeRecorded")
        .withArgs(MEZZ, 5n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  View functions
  // ═══════════════════════════════════════════════════════════════════

  describe("view functions", () => {
    beforeEach(async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 7_000n * E18);
      await accounting.connect(cdo).recordDeposit(MEZZ, 2_000n * E18);
      await accounting.connect(cdo).recordDeposit(JUNIOR, 800n * E18);
    });

    it("getTrancheTVL(SENIOR) should return senior TVL", async () => {
      expect(await accounting.getTrancheTVL(SENIOR)).to.equal(7_000n * E18);
    });

    it("getTrancheTVL(MEZZ) should return mezz TVL", async () => {
      expect(await accounting.getTrancheTVL(MEZZ)).to.equal(2_000n * E18);
    });

    it("getTrancheTVL(JUNIOR) should return junior base TVL", async () => {
      expect(await accounting.getTrancheTVL(JUNIOR)).to.equal(800n * E18);
    });

    it("getJuniorTVL should return junior base TVL", async () => {
      expect(await accounting.getJuniorTVL()).to.equal(800n * E18);
    });

    it("getAllTVLs should return (sr, mz, jr)", async () => {
      const [sr, mz, jr] = await accounting.getAllTVLs();
      expect(sr).to.equal(7_000n * E18);
      expect(mz).to.equal(2_000n * E18);
      expect(jr).to.equal(800n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control — onlyCDO
  // ═══════════════════════════════════════════════════════════════════

  describe("access control — onlyCDO", () => {
    it("should revert recordDeposit from non-CDO", async () => {
      await expect(accounting.connect(other).recordDeposit(SENIOR, 100n * E18))
        .to.be.revertedWithCustomError(accounting, "PrimeVaults__Unauthorized");
    });

    it("should revert recordWithdraw from non-CDO", async () => {
      await expect(accounting.connect(other).recordWithdraw(SENIOR, 100n * E18))
        .to.be.revertedWithCustomError(accounting, "PrimeVaults__Unauthorized");
    });

    it("should revert recordFee from non-CDO", async () => {
      await expect(accounting.connect(other).recordFee(SENIOR, 10n * E18))
        .to.be.revertedWithCustomError(accounting, "PrimeVaults__Unauthorized");
    });

    it("should revert updateTVL from non-CDO", async () => {
      await expect(accounting.connect(other).updateTVL(0))
        .to.be.revertedWithCustomError(accounting, "PrimeVaults__Unauthorized");
    });
  });
});
