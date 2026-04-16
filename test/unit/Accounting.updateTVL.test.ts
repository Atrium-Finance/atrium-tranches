import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("Accounting — updateTVL (gain splitting + loss waterfall)", () => {
  let accounting: any;
  let riskParams: any;
  let mockAprFeed: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;

  const E18 = 10n ** 18n;
  const DAY = 86_400;

  /**
   * @dev Deploy a minimal MockAprFeed that returns configurable APR values.
   */
  async function deployMockAprFeed(aprTarget: bigint, aprBase: bigint) {
    const Factory = await ethers.getContractFactory("MockAprFeed");
    return Factory.deploy(aprTarget, aprBase);
  }

  beforeEach(async () => {
    [owner, cdo] = await ethers.getSigners();

    riskParams = await (await ethers.getContractFactory("RiskParams")).deploy(owner.address);

    // Deploy mock APR feed with 0 APR initially
    mockAprFeed = await deployMockAprFeed(0n, 0n);

    accounting = await (await ethers.getContractFactory("Accounting")).deploy(
      await mockAprFeed.getAddress(), await riskParams.getAddress(),
    );
    await accounting.setCDO(cdo.address);
  });

  async function seedAll(sr: bigint, mz: bigint, jr: bigint) {
    if (sr > 0n) await accounting.connect(cdo).recordDeposit(SENIOR, sr);
    if (mz > 0n) await accounting.connect(cdo).recordDeposit(MEZZ, mz);
    if (jr > 0n) await accounting.connect(cdo).recordDeposit(JUNIOR, jr);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  C5 — Gain Distribution Cases
  // ═══════════════════════════════════════════════════════════════════

  describe("gain splitting (C5)", () => {
    it("CASE A: full yield → Senior target, Mezz target, Junior residual", async () => {
      await seedAll(7_000_000n * E18, 2_000_000n * E18, 1_000_000n * E18);

      // Set APR: aprBase=12%, aprTarget=4% (int64 × 12dec: 12% = 0.12e12 = 120_000_000_000)
      await mockAprFeed.setAprs(40_000_000_000n, 120_000_000_000n); // 4%, 12%

      // Advance 1 day
      await time.increase(DAY);

      // Strategy gain = 12% annual on 10M base for 1 day ≈ $3,288
      // prevStrategyTVL = 7M + 2M + 1M + 0 (reserve) = 10M
      // currentStrategyTVL = 10M + gain
      const prevTotal = 10_000_000n * E18;
      const dailyGain = (prevTotal * 120n) / (1000n * 365n); // ~3,288e18
      const currentTotal = prevTotal + dailyGain;

      const srBefore = await accounting.s_seniorTVL();
      const mzBefore = await accounting.s_mezzTVL();
      const jrBefore = await accounting.s_juniorBaseTVL();

      await accounting.connect(cdo).updateTVL(currentTotal);

      const srAfter = await accounting.s_seniorTVL();
      const mzAfter = await accounting.s_mezzTVL();
      const jrAfter = await accounting.s_juniorBaseTVL();
      const reserveAfter = await accounting.s_reserveTVL();

      // All tranches should have gained
      expect(srAfter).to.be.gt(srBefore);
      expect(mzAfter).to.be.gt(mzBefore);
      expect(jrAfter).to.be.gt(jrBefore);
      expect(reserveAfter).to.be.gt(0n);

      // Total distributed = gain
      const totalDistributed = (srAfter - srBefore) + (mzAfter - mzBefore) + (jrAfter - jrBefore) + reserveAfter;
      // Should approximately equal the gain (within rounding)
      expect(totalDistributed).to.be.gte(dailyGain - E18);
      expect(totalDistributed).to.be.lte(dailyGain + E18);
    });

    it("CASE A: Senior gets target APR, Junior gets residual with 0 APR feed", async () => {
      await seedAll(5_000n * E18, 2_000n * E18, 3_000n * E18);

      // 0 APR from feed → Senior target = 0, Mezz target = 0 → all gain goes to Junior (residual)
      await time.increase(DAY);

      const gain = 100n * E18; // $100 gain
      const prevTotal = 10_000n * E18;
      await accounting.connect(cdo).updateTVL(prevTotal + gain);

      // Reserve cut = 5% of 100 = 5
      const reserveCut = (gain * 500n) / 10_000n;
      const netGain = gain - reserveCut;

      // With 0 APR: seniorTarget=0, mezzTarget=0 → all net goes to Junior
      expect(await accounting.s_seniorTVL()).to.equal(5_000n * E18); // unchanged
      expect(await accounting.s_mezzTVL()).to.equal(2_000n * E18); // unchanged
      expect(await accounting.s_juniorBaseTVL()).to.equal(3_000n * E18 + netGain);
      expect(await accounting.s_reserveTVL()).to.equal(reserveCut);
    });

    it("CASE C: insufficient yield → Senior gets all, Mezz/Junior nothing", async () => {
      await seedAll(9_000_000n * E18, 500_000n * E18, 500_000n * E18);

      // High APR so Senior target exceeds net gain
      await mockAprFeed.setAprs(200_000_000_000n, 200_000_000_000n); // 20%, 20%

      await time.increase(DAY);

      // Tiny gain: only $10
      const prevTotal = 10_000_000n * E18;
      const tinyGain = 10n * E18;
      await accounting.connect(cdo).updateTVL(prevTotal + tinyGain);

      // Senior target for 9M at 20% for 1 day ≈ $4,932 > $9.50 net gain
      // So Senior gets all net gain, Mezz/Junior get 0
      const reserveCut = (tinyGain * 500n) / 10_000n;
      const netGain = tinyGain - reserveCut;

      expect(await accounting.s_seniorTVL()).to.equal(9_000_000n * E18 + netGain);
      expect(await accounting.s_mezzTVL()).to.equal(500_000n * E18); // unchanged
      expect(await accounting.s_juniorBaseTVL()).to.equal(500_000n * E18); // unchanged
    });

    it("should not change TVLs when deltaT is 0", async () => {
      await seedAll(1_000n * E18, 500n * E18, 500n * E18);

      // No time advance → deltaT = 0
      const srBefore = await accounting.s_seniorTVL();
      await accounting.connect(cdo).updateTVL(2_100n * E18);

      // No change because deltaT = 0
      expect(await accounting.s_seniorTVL()).to.equal(srBefore);
    });

    it("should emit GainSplit event", async () => {
      await seedAll(1_000n * E18, 0n, 0n);
      await time.increase(DAY);

      await expect(
        accounting.connect(cdo).updateTVL(1_100n * E18),
      ).to.emit(accounting, "GainSplit");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  C2 — Reserve Cut
  // ═══════════════════════════════════════════════════════════════════

  describe("reserve cut (C2)", () => {
    it("should take 5% reserve on positive gain (default 500 bps)", async () => {
      await seedAll(0n, 0n, 10_000n * E18);
      await time.increase(DAY);

      const gain = 1_000n * E18;
      await accounting.connect(cdo).updateTVL(10_000n * E18 + gain);

      // reserve = 1000 × 5% = 50
      expect(await accounting.s_reserveTVL()).to.equal(50n * E18);
    });

    it("should take 0 reserve on loss", async () => {
      await seedAll(0n, 0n, 10_000n * E18);
      await time.increase(DAY);

      // Loss: current < prev
      await accounting.connect(cdo).updateTVL(9_000n * E18);

      expect(await accounting.s_reserveTVL()).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  D4 — Loss Waterfall
  // ═══════════════════════════════════════════════════════════════════

  describe("loss waterfall (D4)", () => {
    it("should absorb loss from Junior first", async () => {
      await seedAll(5_000n * E18, 2_000n * E18, 3_000n * E18);
      await time.increase(DAY);

      // Loss = $500 (< Jr TVL of $3K)
      await accounting.connect(cdo).updateTVL(9_500n * E18);

      expect(await accounting.s_juniorBaseTVL()).to.equal(2_500n * E18); // 3K - 500
      expect(await accounting.s_mezzTVL()).to.equal(2_000n * E18); // unchanged
      expect(await accounting.s_seniorTVL()).to.equal(5_000n * E18); // unchanged
    });

    it("should cascade to Mezzanine when Junior depleted", async () => {
      await seedAll(5_000n * E18, 2_000n * E18, 1_000n * E18);
      await time.increase(DAY);

      // Loss = $1,500 (> Jr TVL of $1K)
      await accounting.connect(cdo).updateTVL(6_500n * E18);

      expect(await accounting.s_juniorBaseTVL()).to.equal(0n); // wiped
      expect(await accounting.s_mezzTVL()).to.equal(1_500n * E18); // 2K - 500
      expect(await accounting.s_seniorTVL()).to.equal(5_000n * E18); // unchanged
    });

    it("should cascade to Senior when Mezz depleted", async () => {
      await seedAll(5_000n * E18, 1_000n * E18, 500n * E18);
      await time.increase(DAY);

      // Loss = $2,000 (> Jr + Mz = $1,500)
      await accounting.connect(cdo).updateTVL(4_500n * E18);

      expect(await accounting.s_juniorBaseTVL()).to.equal(0n); // wiped
      expect(await accounting.s_mezzTVL()).to.equal(0n); // wiped
      expect(await accounting.s_seniorTVL()).to.equal(4_500n * E18); // 5K - 500
    });

    it("should emit LossApplied event", async () => {
      await seedAll(0n, 0n, 5_000n * E18);
      await time.increase(DAY);

      await expect(
        accounting.connect(cdo).updateTVL(4_000n * E18),
      ).to.emit(accounting, "LossApplied");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getSeniorAPY
  // ═══════════════════════════════════════════════════════════════════

  describe("getSeniorAPY (E5)", () => {
    it("should return 0 when APR feed returns 0", async () => {
      expect(await accounting.getSeniorAPY()).to.equal(0n);
    });

    it("should return MAX(aprTarget, aprBase × (1 - RP1))", async () => {
      await seedAll(7_000_000n * E18, 2_000_000n * E18, 1_250_000n * E18);
      // aprTarget=4%, aprBase=12%
      await mockAprFeed.setAprs(40_000_000_000n, 120_000_000_000n);

      const apr = await accounting.getSeniorAPY();
      // Should be > 4% (aprTarget) since 12% × (1 - RP1) > 4%
      expect(apr).to.be.gt(40_000_000_000n * 1_000_000n); // > 4% in 18dec
      // Should be < 12%
      expect(apr).to.be.lt(120_000_000_000n * 1_000_000n); // < 12%
    });

    it("should return aprTarget when aprBase × (1-RP1) < aprTarget", async () => {
      await seedAll(9_000_000n * E18, 500_000n * E18, 500_000n * E18);
      // aprTarget=10%, aprBase=5% → 5% × (1 - RP1) < 10% → returns 10%
      await mockAprFeed.setAprs(100_000_000_000n, 50_000_000_000n);

      const apr = await accounting.getSeniorAPY();
      // Should be approximately 10% (the floor)
      const tenPct18 = 100_000_000_000n * 1_000_000n; // 10% in 18dec
      expect(apr).to.equal(tenPct18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getMezzAPY
  // ═══════════════════════════════════════════════════════════════════

  describe("getMezzAPY (E6)", () => {
    it("should return 0 when APR feed returns 0", async () => {
      expect(await accounting.getMezzAPY()).to.equal(0n);
    });

    it("should return aprBase × (1 + RP1 × subLev) × (1 - RP2)", async () => {
      await seedAll(7_000_000n * E18, 2_000_000n * E18, 1_250_000n * E18);
      await mockAprFeed.setAprs(40_000_000_000n, 120_000_000_000n);

      const apr = await accounting.getMezzAPY();
      // Mezz APR should be > aprBase (12%) due to RP1 bonus
      expect(apr).to.be.gt(120_000_000_000n * 1_000_000n); // > 12% in 18dec
    });
  });
});
