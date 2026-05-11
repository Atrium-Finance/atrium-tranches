// Regression tests for audit findings L#3, L#4, L#7.

import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const E18 = 10n ** 18n;
const USDC = "0x0000000000000000000000000000000000000001";
const USDT = "0x0000000000000000000000000000000000000002";

describe("Audit low fixes (L#3, L#4, L#7)", () => {
  // ═══════════════════════════════════════════════════════════════════
  //  L#3 — getAprPair restricted to AprPairFeed
  // ═══════════════════════════════════════════════════════════════════

  describe("L#3 — SUSDaiAprPairProvider.getAprPair access control", () => {
    let provider: any;
    let mockPool: any;
    let mockVault: any;
    let owner: SignerWithAddress;
    let attacker: SignerWithAddress;
    let feedAddr: SignerWithAddress; // simulate the AprPairFeed signer

    beforeEach(async () => {
      [owner, attacker, feedAddr] = await ethers.getSigners();

      const PoolFactory = await ethers.getContractFactory("MockAavePool");
      mockPool = await PoolFactory.deploy();
      const ATokenFactory = await ethers.getContractFactory("MockAToken");
      const aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
      const aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");
      await mockPool.setAToken(USDC, await aUsdc.getAddress());
      await mockPool.setAToken(USDT, await aUsdt.getAddress());
      await mockPool.setLiquidityRate(USDC, 30_000_000_000_000_000_000_000_000n); // 3% ray
      await mockPool.setLiquidityRate(USDT, 30_000_000_000_000_000_000_000_000n);
      await aUsdc.mint(owner.address, ethers.parseUnits("1000000", 6));
      await aUsdt.mint(owner.address, ethers.parseUnits("1000000", 6));

      const VaultFactory = await ethers.getContractFactory("MockERC4626");
      mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

      const Factory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      provider = await Factory.deploy(
        await mockPool.getAddress(),
        [USDC, USDT],
        await mockVault.getAddress(),
        owner.address,
      );
    });

    it("should revert getAprPair before setAprFeed is called (no auth)", async () => {
      await expect(
        provider.connect(attacker).getAprPair()
      ).to.be.revertedWithCustomError(provider, "PrimeVaults__Unauthorized");
    });

    it("should revert getAprPair from non-AprFeed caller after setAprFeed", async () => {
      await provider.connect(owner).setAprFeed(feedAddr.address);
      await expect(
        provider.connect(attacker).getAprPair()
      ).to.be.revertedWithCustomError(provider, "PrimeVaults__Unauthorized");
    });

    it("should allow getAprPair from authorized AprFeed", async () => {
      await provider.connect(owner).setAprFeed(feedAddr.address);
      await expect(provider.connect(feedAddr).getAprPair()).to.not.be.reverted;
    });

    it("should revert setAprFeed from non-owner", async () => {
      await expect(
        provider.connect(attacker).setAprFeed(feedAddr.address)
      ).to.be.revertedWithCustomError(provider, "OwnableUnauthorizedAccount");
    });

    it("should revert setAprFeed with zero address", async () => {
      await expect(
        provider.connect(owner).setAprFeed(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(provider, "PrimeVaults__ZeroAddress");
    });

    it("should still allow getAprPairView (read-only) from anyone", async () => {
      // View path is unaffected by L#3 — anyone can read snapshot.
      await expect(provider.connect(attacker).getAprPairView()).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  L#7 — _computeBenchmarkApr clamp instead of revert
  // ═══════════════════════════════════════════════════════════════════

  describe("L#7 — SUSDaiAprPairProvider._computeBenchmarkApr clamps at BENCHMARK_MAX", () => {
    let provider: any;
    let mockPool: any;
    let mockVault: any;
    let aUsdc: any;
    let aUsdt: any;
    let owner: SignerWithAddress;

    const BENCHMARK_MAX_12DEC = 400_000_000_000n; // 40% in 12dec

    beforeEach(async () => {
      [owner] = await ethers.getSigners();
      const PoolFactory = await ethers.getContractFactory("MockAavePool");
      mockPool = await PoolFactory.deploy();
      const ATokenFactory = await ethers.getContractFactory("MockAToken");
      aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
      aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");
      await mockPool.setAToken(USDC, await aUsdc.getAddress());
      await mockPool.setAToken(USDT, await aUsdt.getAddress());
      await aUsdc.mint(owner.address, ethers.parseUnits("1000000", 6));
      await aUsdt.mint(owner.address, ethers.parseUnits("1000000", 6));

      const VaultFactory = await ethers.getContractFactory("MockERC4626");
      mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

      const Factory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      provider = await Factory.deploy(
        await mockPool.getAddress(),
        [USDC, USDT],
        await mockVault.getAddress(),
        owner.address,
      );
      await provider.connect(owner).setAprFeed(owner.address);
    });

    it("should clamp aprTarget at BENCHMARK_MAX (40%) when Aave APR spikes above cap", async () => {
      // Set both Aave rates to 100% (way above 40% cap)
      const RATE_100PCT_RAY = 1_000_000_000_000_000_000_000_000_000n; // 1e27 = 100%
      await mockPool.setLiquidityRate(USDC, RATE_100PCT_RAY);
      await mockPool.setLiquidityRate(USDT, RATE_100PCT_RAY);

      // Should NOT revert — should clamp.
      const result = await provider.connect(owner).getAprPair.staticCall();
      const aprTarget: bigint = result.aprTarget;

      // Clamped to BENCHMARK_MAX = 40% in 12dec.
      expect(aprTarget).to.equal(BENCHMARK_MAX_12DEC);
    });

    it("should pass-through aprTarget unchanged when within bounds", async () => {
      // Set rates to 5% (within 0-40% range)
      const RATE_5PCT_RAY = 50_000_000_000_000_000_000_000_000n; // 5%
      await mockPool.setLiquidityRate(USDC, RATE_5PCT_RAY);
      await mockPool.setLiquidityRate(USDT, RATE_5PCT_RAY);

      const result = await provider.connect(owner).getAprPair.staticCall();
      const aprTarget: bigint = result.aprTarget;

      // Expected: 5% in 12dec = 50_000_000_000
      expect(aprTarget).to.equal(50_000_000_000n);
    });

    it("should NOT revert when aprAvg exceeds BENCHMARK_MAX (regression: was require-revert before fix)", async () => {
      const RATE_50PCT_RAY = 500_000_000_000_000_000_000_000_000n; // 50%
      await mockPool.setLiquidityRate(USDC, RATE_50PCT_RAY);
      await mockPool.setLiquidityRate(USDT, RATE_50PCT_RAY);

      // Pre-fix: require(aprAvg <= BENCHMARK_MAX) reverted "PrimeVaults__InvalidBenchmarkApr".
      // Post-fix: clamps to 40%.
      await expect(provider.connect(owner).getAprPair()).to.not.be.reverted;
    });
  });
});
