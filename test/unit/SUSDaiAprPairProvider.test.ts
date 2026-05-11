import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("SUSDaiAprPairProvider", () => {
  let provider: any;
  let mockPool: any;
  let mockVault: any;
  let aUsdc: any;
  let aUsdt: any;

  const USDC = "0x0000000000000000000000000000000000000001";
  const USDT = "0x0000000000000000000000000000000000000002";
  const E18 = 10n ** 18n;

  // 3% in ray = 3e25. In 12dec = 3e25 / 1e15 = 3e10
  const RATE_USDC_RAY = 30_000_000_000_000_000_000_000_000n;
  const RATE_USDT_RAY = 50_000_000_000_000_000_000_000_000n;
  const RATE_USDC_12 = 30_000_000_000n;
  const RATE_USDT_12 = 50_000_000_000n;

  async function deployFresh() {
    const [owner] = await ethers.getSigners();

    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    // Set aToken addresses in pool (fix #2)
    await mockPool.setAToken(USDC, await aUsdc.getAddress());
    await mockPool.setAToken(USDT, await aUsdt.getAddress());
    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);
    await aUsdc.mint(owner.address, ethers.parseUnits("1000000", 18));
    await aUsdt.mint(owner.address, ethers.parseUnits("1000000", 18));

    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

    const Factory = await ethers.getContractFactory("SUSDaiAprPairProvider");
    provider = await Factory.deploy(
      await mockPool.getAddress(),
      [USDC, USDT],
      await mockVault.getAddress(),
      owner.address, // L#3: owner sets the AprPairFeed authorization
    );
    // L#3: tests call getAprPair() directly from `owner` signer; authorize owner as feed proxy.
    await provider.connect(owner).setAprFeed(owner.address);
  }

  beforeEach(deployFresh);

  // ═══════════════════════════════════════════════════════════════════
  //  getAprPair — shifts snapshots
  // ═══════════════════════════════════════════════════════════════════

  describe("getAprPair (mutate)", () => {
    it("should shift snapshots on each call", async () => {
      const [prevBefore] = await provider.s_prevSnapshot();
      expect(prevBefore).to.equal(0);

      await time.increase(3600);
      await provider.getAprPair(); // shifts constructor snapshot → prev

      const [prevAfter] = await provider.s_prevSnapshot();
      expect(prevAfter).to.equal(E18);
    });

    it("should return aprBase = 0 on first call (only 1 snapshot)", async () => {
      await time.increase(1);
      const [aprTarget, aprBase] = await provider.getAprPair.staticCall();
      expect(aprTarget).to.equal((RATE_USDC_12 + RATE_USDT_12) / 2n); // 4%
      expect(aprBase).to.equal(0);
    });

    it("should return correct APRs on second call (2 snapshots)", async () => {
      await time.increase(86400);
      await provider.getAprPair(); // first call: seeds prev

      const dailyGrowth = (E18 * 15n) / (100n * 365n);
      await mockVault.setRate(E18 + dailyGrowth);

      await time.increase(86400);
      const [aprTarget, aprBase] = await provider.getAprPair.staticCall();

      expect(aprTarget).to.equal(40_000_000_000n); // 4%
      // ~15% → ~150_000_000_000 in 12dec
      const expected15 = 150_000_000_000n;
      const diff = aprBase > expected15 ? aprBase - expected15 : expected15 - aprBase;
      expect(diff).to.be.lt(expected15 / 10n); // within 10%
    });

    it("should emit SnapshotShifted event", async () => {
      await time.increase(3600);
      await expect(provider.getAprPair()).to.emit(provider, "SnapshotShifted");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getAprPairView — does NOT shift snapshots
  // ═══════════════════════════════════════════════════════════════════

  describe("getAprPairView (view)", () => {
    it("should NOT shift snapshots", async () => {
      await time.increase(3600);
      // Call view — should not change state
      await provider.getAprPairView();

      const [prevRate] = await provider.s_prevSnapshot();
      expect(prevRate).to.equal(0); // still zero — no shift happened
    });

    it("should return same aprTarget as getAprPair", async () => {
      await time.increase(3600);
      const [viewTarget] = await provider.getAprPairView();
      const [mutateTarget] = await provider.getAprPair.staticCall();
      expect(viewTarget).to.equal(mutateTarget);
    });

    it("should return aprBase from existing snapshots after getAprPair was called", async () => {
      await time.increase(86400);
      await provider.getAprPair(); // shifts snapshots

      const dailyGrowth = (E18 * 15n) / (100n * 365n);
      await mockVault.setRate(E18 + dailyGrowth);

      await time.increase(86400);
      await provider.getAprPair(); // second shift

      // Now view should return APR from stored snapshots
      const [, aprBase] = await provider.getAprPairView();
      expect(aprBase).to.not.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Negative APR (rate decrease)
  // ═══════════════════════════════════════════════════════════════════

  describe("negative APR", () => {
    it("should return negative aprBase when rate decreases", async () => {
      await time.increase(86400);
      await provider.getAprPair();

      await mockVault.setRate(E18 - E18 / 20n); // 5% loss
      await time.increase(86400);
      const [, aprBase] = await provider.getAprPair.staticCall();
      expect(aprBase).to.be.lt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Clamping — extreme rate jump (fix #4)
  // ═══════════════════════════════════════════════════════════════════

  describe("strategy APR clamping", () => {
    it("should clamp aprBase at +200% for extreme rate jump", async () => {
      await time.increase(86400);
      await provider.getAprPair();

      // 10x rate jump in 1 day → way above 200% APR
      await mockVault.setRate(E18 * 10n);
      await time.increase(86400);
      const [, aprBase] = await provider.getAprPair.staticCall();

      // Should be clamped at +200% = 2_000_000_000_000
      expect(aprBase).to.equal(2_000_000_000_000n);
    });

    it("should clamp aprBase at -50% for extreme rate drop", async () => {
      await time.increase(86400);
      await provider.getAprPair();

      // Rate drops to near zero in 1 day
      await mockVault.setRate(1n); // almost zero
      await time.increase(86400);
      const [, aprBase] = await provider.getAprPair.staticCall();

      expect(aprBase).to.equal(-500_000_000_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Aave weighted avg — different supplies
  // ═══════════════════════════════════════════════════════════════════

  describe("benchmark weighted average", () => {
    it("should weight by aToken totalSupply (read from getReserveData)", async () => {
      const [signer] = await ethers.getSigners();
      await aUsdc.mint(signer.address, ethers.parseUnits("1000000", 18)); // now 2M

      await time.increase(1);
      const [aprTarget] = await provider.getAprPairView();

      // (2M × 3% + 1M × 5%) / 3M = 3.667%
      const expected = (2_000_000n * RATE_USDC_12 + 1_000_000n * RATE_USDT_12) / 3_000_000n;
      expect(aprTarget).to.equal(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Benchmark cap (fix #3)
  // ═══════════════════════════════════════════════════════════════════

  describe("benchmark cap", () => {
    it("should cap benchmark at 40% (BENCHMARK_MAX)", async () => {
      // Set 60% rate on USDC (way above 40%)
      const rate60Ray = 600_000_000_000_000_000_000_000_000n; // 60% in ray
      await mockPool.setLiquidityRate(USDC, rate60Ray);
      await mockPool.setLiquidityRate(USDT, rate60Ray);

      await time.increase(1);
      const [aprTarget] = await provider.getAprPairView();

      expect(aprTarget).to.equal(400_000_000_000n); // 40% cap
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  aTokenAddress from getReserveData (fix #2)
  // ═══════════════════════════════════════════════════════════════════

  describe("aToken from getReserveData", () => {
    it("should read aTokenAddress from pool, not use hardcoded immutables", async () => {
      // Deploy a new aToken and point pool to it
      const ATokenFactory = await ethers.getContractFactory("MockAToken");
      const newAUsdc = await ATokenFactory.deploy("aUSDC-v2", "aUSDC-v2");
      const [signer] = await ethers.getSigners();
      await newAUsdc.mint(signer.address, ethers.parseUnits("5000000", 18));

      // Update pool to point USDC → new aToken
      await mockPool.setAToken(USDC, await newAUsdc.getAddress());

      await time.increase(1);
      const [aprTarget] = await provider.getAprPairView();

      // Now: 5M USDC (new) + 1M USDT → weighted avg
      // (5M × 3% + 1M × 5%) / 6M = (150K + 50K)/6M = 3.333%
      const expected = (5_000_000n * RATE_USDC_12 + 1_000_000n * RATE_USDT_12) / 6_000_000n;
      expect(aprTarget).to.equal(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Snapshot shifting correctness
  // ═══════════════════════════════════════════════════════════════════

  describe("snapshot shifting", () => {
    it("should shift prev ← latest, latest ← current on each getAprPair call", async () => {
      // After constructor: latest = {rate: 1e18, ts: deploy}
      await time.increase(3600);
      await provider.getAprPair(); // shift 1

      const rate2 = E18 + E18 / 100n;
      await mockVault.setRate(rate2);
      await time.increase(3600);
      await provider.getAprPair(); // shift 2

      const [latestRate] = await provider.s_latestSnapshot();
      const [prevRate] = await provider.s_prevSnapshot();
      expect(latestRate).to.equal(rate2);
      expect(prevRate).to.equal(E18); // was latest after first shift
    });
  });
});
