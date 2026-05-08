import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const NONE = 0;
const ASSETS_LOCK = 1;
const SHARES_LOCK = 2;

const SENIOR = 0;
const JUNIOR = 1;

const E18 = 10n ** 18n;
const DAY = 86400;

describe("RedemptionPolicy", () => {
  let policy: any;
  let accounting: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async () => {
    [owner, cdo, other] = await ethers.getSigners();

    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, owner.address);
    await accounting.setCDO(cdo.address);

    const PolicyFactory = await ethers.getContractFactory("RedemptionPolicy");
    policy = await PolicyFactory.deploy(owner.address, await accounting.getAddress());
  });

  async function seedTVLs(sr: bigint, jr: bigint) {
    if (sr > 0n) await accounting.connect(cdo).recordDeposit(SENIOR, sr);
    if (jr > 0n) await accounting.connect(cdo).recordDeposit(JUNIOR, jr);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  getCoverage
  // ═══════════════════════════════════════════════════════════════════

  describe("getCoverage", () => {
    it("should compute cs correctly", async () => {
      await seedTVLs(7_000n * E18, 3_000n * E18);
      const cs = await policy.getCoverage();
      // cs = (7K + 3K) / 7K = 10K * E18 / 7K
      expect(cs).to.equal((10_000n * E18) / 7_000n);
    });

    it("should return max uint256 for cs when Sr=0", async () => {
      await seedTVLs(0n, 2_000n * E18);
      const cs = await policy.getCoverage();
      expect(cs).to.equal(ethers.MaxUint256);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Senior: always instant
  // ═══════════════════════════════════════════════════════════════════

  describe("Senior — always instant", () => {
    it("should return NONE regardless of coverage", async () => {
      const r1 = await policy.evaluateForCoverage(SENIOR, E18);
      expect(r1.mechanism).to.equal(NONE);
      expect(r1.feeBps).to.equal(0);
      expect(r1.cooldownDuration).to.equal(0);

      const r2 = await policy.evaluateForCoverage(SENIOR, 5n * E18);
      expect(r2.mechanism).to.equal(NONE);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior: based on cs only (single-dimensional)
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior — based on cs", () => {
    it("should return NONE (instant) when cs > 160%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, (161n * E18) / 100n);
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0); // instant fee = 0
      expect(result.cooldownDuration).to.equal(0);
    });

    it("should return ASSETS_LOCK when 140% < cs <= 160%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, (150n * E18) / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(20);
      expect(result.cooldownDuration).to.equal(3 * DAY);
    });

    it("should return ASSETS_LOCK at cs = 141%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, (141n * E18) / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should return SHARES_LOCK when cs <= 140%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, (140n * E18) / 100n);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(100);
      expect(result.cooldownDuration).to.equal(7 * DAY);
    });

    it("should return SHARES_LOCK when cs = 100%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return SHARES_LOCK at cs exactly 140%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, (14n * E18) / 10n);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return ASSETS_LOCK at cs exactly 160% (not > 160%)", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, (16n * E18) / 10n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  evaluate() with live accounting
  // ═══════════════════════════════════════════════════════════════════

  describe("evaluate with live accounting", () => {
    it("should return instant for Senior regardless of TVL", async () => {
      await seedTVLs(10_000n * E18, 100n * E18);
      const result = await policy.evaluate(SENIOR);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should return correct Junior policy based on live cs (high cs → instant)", async () => {
      // Sr=1K, Jr=2K → cs = 3K/1K = 3x > 160% → instant
      await seedTVLs(1_000n * E18, 2_000n * E18);
      const result = await policy.evaluate(JUNIOR);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should return SHARES_LOCK for Junior when cs is low", async () => {
      // Sr=8K, Jr=2K → cs = 10K/8K = 1.25x ≤ 140% → SHARES_LOCK
      await seedTVLs(8_000n * E18, 2_000n * E18);
      const result = await policy.evaluate(JUNIOR);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setJuniorParams (2 args now)
  // ═══════════════════════════════════════════════════════════════════

  describe("setJuniorParams", () => {
    it("should update Junior thresholds", async () => {
      // Tighten: instant cs>200%, asset lock cs>170%
      await policy
        .connect(owner)
        .setJuniorParams((200n * E18) / 100n, (170n * E18) / 100n);

      // cs=180% → was instant (old thresholds), now ASSETS_LOCK
      const result = await policy.evaluateForCoverage(JUNIOR, (180n * E18) / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should revert if instantCs <= assetLockCs", async () => {
      await expect(
        policy.connect(owner).setJuniorParams((14n * E18) / 10n, (16n * E18) / 10n),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__InvalidThresholds");
    });

    it("should revert if equal", async () => {
      await expect(
        policy.connect(owner).setJuniorParams((15n * E18) / 10n, (15n * E18) / 10n),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__InvalidThresholds");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        policy.connect(other).setJuniorParams(2n * E18, E18),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });

    it("should emit JuniorParamsUpdated event", async () => {
      await expect(
        policy.connect(owner).setJuniorParams((200n * E18) / 100n, (170n * E18) / 100n),
      )
        .to.emit(policy, "JuniorParamsUpdated")
        .withArgs((200n * E18) / 100n, (170n * E18) / 100n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setMechanismConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setMechanismConfig", () => {
    it("should update fees and durations for a tranche", async () => {
      await policy.connect(owner).setMechanismConfig(JUNIOR, {
        instantFeeBps: 5,
        assetsLockFeeBps: 25,
        assetsLockDuration: 5 * DAY,
        sharesLockFeeBps: 75,
        sharesLockDuration: 14 * DAY,
      });

      // Instant
      const r1 = await policy.evaluateForCoverage(JUNIOR, 2n * E18);
      expect(r1.feeBps).to.equal(5);

      // Assets lock
      const r2 = await policy.evaluateForCoverage(JUNIOR, (150n * E18) / 100n);
      expect(r2.feeBps).to.equal(25);
      expect(r2.cooldownDuration).to.equal(5 * DAY);

      // Shares lock
      const r3 = await policy.evaluateForCoverage(JUNIOR, E18);
      expect(r3.feeBps).to.equal(75);
      expect(r3.cooldownDuration).to.equal(14 * DAY);
    });

    it("should revert if instantFeeBps > MAX_FEE_BPS", async () => {
      await expect(
        policy.connect(owner).setMechanismConfig(SENIOR, {
          instantFeeBps: 1001,
          assetsLockFeeBps: 0,
          assetsLockDuration: 0,
          sharesLockFeeBps: 0,
          sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert if assetsLockFeeBps > MAX_FEE_BPS", async () => {
      await expect(
        policy.connect(owner).setMechanismConfig(SENIOR, {
          instantFeeBps: 0,
          assetsLockFeeBps: 1001,
          assetsLockDuration: 0,
          sharesLockFeeBps: 0,
          sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert if sharesLockFeeBps > MAX_FEE_BPS", async () => {
      await expect(
        policy.connect(owner).setMechanismConfig(SENIOR, {
          instantFeeBps: 0,
          assetsLockFeeBps: 0,
          assetsLockDuration: 0,
          sharesLockFeeBps: 1001,
          sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        policy.connect(other).setMechanismConfig(SENIOR, {
          instantFeeBps: 0,
          assetsLockFeeBps: 0,
          assetsLockDuration: 0,
          sharesLockFeeBps: 0,
          sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setAccounting
  // ═══════════════════════════════════════════════════════════════════

  describe("setAccounting", () => {
    it("should allow owner to set accounting", async () => {
      const newAcc = ethers.Wallet.createRandom().address;
      await policy.connect(owner).setAccounting(newAcc);
      expect(await policy.s_accounting()).to.equal(newAcc);
    });

    it("should revert from non-owner", async () => {
      await expect(
        policy.connect(other).setAccounting(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Default init values
  // ═══════════════════════════════════════════════════════════════════

  describe("default init values", () => {
    it("should have correct Junior default thresholds", async () => {
      const p = await policy.s_juniorParams();
      expect(p.instantCs).to.equal((16n * E18) / 10n);
      expect(p.assetLockCs).to.equal((14n * E18) / 10n);
    });

    it("should have correct default Junior mechanism config", async () => {
      const [instantFee, assetsLockFee, assetsLockDur, sharesLockFee, sharesLockDur] = await policy.s_mechanismConfig(JUNIOR);
      expect(instantFee).to.equal(0);
      expect(assetsLockFee).to.equal(20);
      expect(assetsLockDur).to.equal(3 * DAY);
      expect(sharesLockFee).to.equal(100);
      expect(sharesLockDur).to.equal(7 * DAY);
    });

    it("should have correct default Senior mechanism config (always instant, 0 fee)", async () => {
      const [instantFee, assetsLockFee, assetsLockDur, sharesLockFee, sharesLockDur] = await policy.s_mechanismConfig(SENIOR);
      expect(instantFee).to.equal(0);
      expect(assetsLockFee).to.equal(0);
      expect(assetsLockDur).to.equal(0);
      expect(sharesLockFee).to.equal(0);
      expect(sharesLockDur).to.equal(0);
    });
  });
});
