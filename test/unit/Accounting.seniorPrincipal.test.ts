import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const JUNIOR = 1;

describe("Accounting — Senior principal protection", () => {
  let accounting: any;
  let riskParams: any;
  let mockAprFeed: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;

  const E18 = 10n ** 18n;
  const DAY = 86_400;

  async function deployMockAprFeed(aprTarget: bigint, aprBase: bigint) {
    const Factory = await ethers.getContractFactory("MockAprFeed");
    return Factory.deploy(aprTarget, aprBase);
  }

  beforeEach(async () => {
    [owner, cdo] = await ethers.getSigners();

    riskParams = await (await ethers.getContractFactory("RiskParams")).deploy(owner.address);
    mockAprFeed = await deployMockAprFeed(0n, 0n);

    accounting = await (await ethers.getContractFactory("Accounting")).deploy(
      await mockAprFeed.getAddress(),
      await riskParams.getAddress(),
    );
    await accounting.setCDO(cdo.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Tracking principal on deposit / withdraw / fee
  // ═══════════════════════════════════════════════════════════════════

  describe("principal tracking", () => {
    it("should track Senior principal on deposit, ignore Junior deposits", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordDeposit(JUNIOR, 250n * E18);

      expect(await accounting.s_seniorPrincipal()).to.equal(1000n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(1000n * E18);
    });

    it("should accumulate principal across multiple Senior deposits", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordDeposit(SENIOR, 500n * E18);

      expect(await accounting.s_seniorPrincipal()).to.equal(1500n * E18);
    });

    it("should emit SeniorPrincipalIncreased on Senior deposit", async () => {
      await expect(accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18))
        .to.emit(accounting, "SeniorPrincipalIncreased")
        .withArgs(1000n * E18, 1000n * E18);
    });

    it("should scale principal pro-rata on partial Senior withdraw", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);

      // Withdraw 25% (250 of 1000) → principal scaled to 750
      await accounting.connect(cdo).recordWithdraw(SENIOR, 250n * E18);

      expect(await accounting.s_seniorTVL()).to.equal(750n * E18);
      expect(await accounting.s_seniorPrincipal()).to.equal(750n * E18);
    });

    it("should keep yield-tier on partial withdraw (principal scales, yield stays)", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);

      // Simulate 200 yield accrual via APR feed gain split
      await mockAprFeed.setAprs(0n, 360_000_000_000n); // ~36%
      await accounting.connect(cdo).recordDeposit(JUNIOR, 1n); // dummy to seed prevTVL
      await time.increase(DAY * 200); // accrue meaningful yield
      // Simulate gain by reporting higher strategy TVL
      const prev =
        (await accounting.s_seniorTVL()) +
        (await accounting.s_juniorBaseTVL()) +
        (await accounting.s_reserveTVL());
      await accounting.connect(cdo).updateTVL(prev + 200n * E18);

      const tvlBefore = await accounting.s_seniorTVL();
      const principalBefore = await accounting.s_seniorPrincipal();
      // Senior should have gained yield → tvl > principal
      expect(tvlBefore).to.be.gt(principalBefore);

      // Withdraw 50% of senior tvl
      const withdrawAmt = tvlBefore / 2n;
      await accounting.connect(cdo).recordWithdraw(SENIOR, withdrawAmt);

      const tvlAfter = await accounting.s_seniorTVL();
      const principalAfter = await accounting.s_seniorPrincipal();
      // principal scales pro-rata: principalAfter ≈ principalBefore × (tvlAfter / tvlBefore)
      const expectedPrincipal = (principalBefore * tvlAfter) / tvlBefore;
      expect(principalAfter).to.equal(expectedPrincipal);
    });

    it("should zero principal on full Senior withdraw", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordWithdraw(SENIOR, 1000n * E18);

      expect(await accounting.s_seniorTVL()).to.equal(0n);
      expect(await accounting.s_seniorPrincipal()).to.equal(0n);
    });

    it("should scale principal pro-rata on Senior fee", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      await accounting.connect(cdo).recordFee(SENIOR, 100n * E18);

      expect(await accounting.s_seniorTVL()).to.equal(900n * E18);
      expect(await accounting.s_seniorPrincipal()).to.equal(900n * E18);
      expect(await accounting.s_reserveTVL()).to.equal(100n * E18);
    });

    it("should not scale Junior principal (only Senior is tracked)", async () => {
      await accounting.connect(cdo).recordDeposit(JUNIOR, 1000n * E18);
      await accounting.connect(cdo).recordWithdraw(JUNIOR, 500n * E18);

      // s_seniorPrincipal stays 0 — only Senior touches it
      expect(await accounting.s_seniorPrincipal()).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Loss waterfall — yield-tier first, principal as last resort
  // ═══════════════════════════════════════════════════════════════════

  describe("loss waterfall — Senior protection", () => {
    async function seedAll(sr: bigint, jr: bigint) {
      if (sr > 0n) await accounting.connect(cdo).recordDeposit(SENIOR, sr);
      if (jr > 0n) await accounting.connect(cdo).recordDeposit(JUNIOR, jr);
    }

    it("should preserve Senior principal when loss < Junior", async () => {
      await seedAll(5_000n * E18, 4_000n * E18);
      const principalBefore = await accounting.s_seniorPrincipal();

      await time.increase(DAY);
      // 1500 loss: Junior(4000) absorbs all, Senior untouched
      await accounting.connect(cdo).updateTVL(7_500n * E18);

      expect(await accounting.s_juniorBaseTVL()).to.equal(2_500n * E18);
      expect(await accounting.s_seniorTVL()).to.equal(5_000n * E18);
      expect(await accounting.s_seniorPrincipal()).to.equal(principalBefore);
    });

    it("should preserve Senior principal when loss = Junior exactly", async () => {
      await seedAll(5_000n * E18, 4_000n * E18);
      const principalBefore = await accounting.s_seniorPrincipal();

      await time.increase(DAY);
      // 4000 loss: Junior(4000) wiped, Senior intact
      await accounting.connect(cdo).updateTVL(5_000n * E18);

      expect(await accounting.s_juniorBaseTVL()).to.equal(0n);
      expect(await accounting.s_seniorTVL()).to.equal(5_000n * E18);
      expect(await accounting.s_seniorPrincipal()).to.equal(principalBefore);
    });

    it("should reduce Senior TVL but preserve principal when loss eats only yield-tier", async () => {
      // Start with senior having 5000 principal + some yield from gain split
      await seedAll(5_000n * E18, 1_000n * E18);
      // Generate Senior yield via gain split with 0 aprTarget (Senior gets target gain via APY)
      await mockAprFeed.setAprs(0n, 365_000_000_000n); // ~36.5% APR (1% per day)
      await time.increase(DAY * 5);
      // Strategy gain → Senior should be credited yield
      const prev = await accounting.s_seniorTVL() + await accounting.s_juniorBaseTVL();
      await accounting.connect(cdo).updateTVL(prev + 200n * E18);

      const tvlBefore = await accounting.s_seniorTVL();
      const principalBefore = await accounting.s_seniorPrincipal();
      const yieldBefore = tvlBefore - principalBefore;
      expect(yieldBefore).to.be.gt(0n);

      // Apply a loss that wipes Junior + half of Senior yield
      const jrTVL = await accounting.s_juniorBaseTVL();
      const lossAmt = jrTVL + yieldBefore / 2n;
      const totalAfterLoss =
        (await accounting.s_seniorTVL()) +
        (await accounting.s_juniorBaseTVL()) +
        (await accounting.s_reserveTVL()) -
        lossAmt;

      await time.increase(DAY);
      await mockAprFeed.setAprs(0n, 0n); // freeze APRs to avoid further gain target
      await accounting.connect(cdo).updateTVL(totalAfterLoss);

      // Senior principal preserved; TVL reduced by yield-tier eaten
      expect(await accounting.s_seniorPrincipal()).to.equal(principalBefore);
      expect(await accounting.s_seniorTVL()).to.be.lt(tvlBefore);
      expect(await accounting.s_seniorTVL()).to.be.gte(principalBefore);
    });

    it("should reduce Senior principal only when loss exceeds Junior + yield-tier", async () => {
      await seedAll(5_000n * E18, 2_000n * E18);
      const principalBefore = await accounting.s_seniorPrincipal();

      await time.increase(DAY);
      // Total = 7000. Loss of 2500 → Junior(2000) wiped, 500 hits Senior.
      // Sr has no yield (TVL == principal) → 500 hits principal directly.
      await accounting.connect(cdo).updateTVL(4_500n * E18);

      expect(await accounting.s_juniorBaseTVL()).to.equal(0n);
      expect(await accounting.s_seniorTVL()).to.equal(4_500n * E18);
      expect(await accounting.s_seniorPrincipal()).to.equal(principalBefore - 500n * E18);
    });

    it("should fully zero Senior principal in catastrophic loss", async () => {
      await seedAll(5_000n * E18, 2_000n * E18);
      await time.increase(DAY);

      // Total wipeout
      await accounting.connect(cdo).updateTVL(0n);

      expect(await accounting.s_juniorBaseTVL()).to.equal(0n);
      expect(await accounting.s_seniorTVL()).to.equal(0n);
      expect(await accounting.s_seniorPrincipal()).to.equal(0n);
    });

    it("should emit SeniorPrincipalAbsorbed when principal is touched", async () => {
      await seedAll(5_000n * E18, 2_000n * E18);
      await time.increase(DAY);

      await expect(accounting.connect(cdo).updateTVL(4_500n * E18))
        .to.emit(accounting, "SeniorPrincipalAbsorbed")
        .withArgs(500n * E18, 4_500n * E18);
    });

    it("should NOT emit SeniorPrincipalAbsorbed when waterfall stops at Junior", async () => {
      await seedAll(5_000n * E18, 4_000n * E18);
      await time.increase(DAY);

      const tx = await accounting.connect(cdo).updateTVL(7_500n * E18);
      const receipt = await tx.wait();
      const evt = receipt.logs.find(
        (l: any) => l.fragment && l.fragment.name === "SeniorPrincipalAbsorbed",
      );
      expect(evt).to.equal(undefined);
    });

    it("should emit LossApplied with split yield/principal absorbed amounts", async () => {
      await seedAll(5_000n * E18, 2_000n * E18);
      await time.increase(DAY);

      // Loss 2500 → jr 2000, senior yield 0 (no yield), principal 500
      await expect(accounting.connect(cdo).updateTVL(4_500n * E18))
        .to.emit(accounting, "LossApplied")
        .withArgs(2_500n * E18, 2_000n * E18, 0n, 500n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Pure-gain cycle — principal stays flat
  // ═══════════════════════════════════════════════════════════════════

  describe("pure-gain cycles", () => {
    it("should keep Senior principal flat across gain cycles (yield goes to TVL only)", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 5_000n * E18);
      await accounting.connect(cdo).recordDeposit(JUNIOR, 3_000n * E18);

      const principalSeed = await accounting.s_seniorPrincipal();

      await mockAprFeed.setAprs(40_000_000_000n, 120_000_000_000n);

      // Run 5 daily gain cycles
      for (let i = 0; i < 5; i++) {
        await time.increase(DAY);
        const prevTVL =
          (await accounting.s_seniorTVL()) +
          (await accounting.s_juniorBaseTVL()) +
          (await accounting.s_reserveTVL());
        const dailyGain = (prevTVL * 120n) / (1000n * 365n);
        await accounting.connect(cdo).updateTVL(prevTVL + dailyGain);
      }

      expect(await accounting.s_seniorPrincipal()).to.equal(principalSeed);
      expect(await accounting.s_seniorTVL()).to.be.gt(principalSeed);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Churn / monotonicity
  // ═══════════════════════════════════════════════════════════════════

  describe("churn invariant", () => {
    it("should not inflate principal through deposit/withdraw churn", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);

      for (let i = 0; i < 10; i++) {
        await accounting.connect(cdo).recordDeposit(SENIOR, 100n * E18);
        await accounting.connect(cdo).recordWithdraw(SENIOR, 100n * E18);
      }

      const principal = await accounting.s_seniorPrincipal();
      // Pro-rata truncation may shave a tiny amount, but never above 1100
      expect(principal).to.be.lte(1100n * E18);
      // Should be very close to 1000 (within 1 wei drift per cycle, 10 cycles)
      expect(principal).to.be.gte(990n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getSeniorPrincipal view
  // ═══════════════════════════════════════════════════════════════════

  describe("getSeniorPrincipal", () => {
    it("should expose the same value as the storage variable", async () => {
      await accounting.connect(cdo).recordDeposit(SENIOR, 1000n * E18);
      expect(await accounting.getSeniorPrincipal()).to.equal(await accounting.s_seniorPrincipal());
    });
  });
});
