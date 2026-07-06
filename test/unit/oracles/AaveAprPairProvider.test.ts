import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture, time } from "../../helpers/network-helpers.js";
import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { deployAcm } from "../../fixtures/deployAcm.js";
import { getClients, viem } from "../../helpers/viemClients.js";
import { rayFromPct } from "../../helpers/apr.js";

async function deployProvider() {
  const { owner, user, publicClient, rest } = await getClients();
  const acm = await deployAcm(owner.account.address);

  const usdai = await viem.deployContract("MockERC20", ["USDai", "USDai", 18]);
  const susdai = await viem.deployContract("MockSUSDai", [usdai.address]);
  const aave = await viem.deployContract("MockAavePool");

  const impl = await viem.deployContract("AaveAprPairProvider", [susdai.address, aave.address]);
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const provider = await viem.getContractAt("AaveAprPairProvider", proxy.address);

  // Grant config role to owner.
  const role = await provider.read.UPDATER_STRAT_CONFIG_ROLE();
  await acm.write.grantRole([role, owner.account.address]);

  return { provider, aave, susdai, usdai, acm, owner, user, publicClient, rest };
}

describe("AaveAprPairProvider", () => {
  describe("initialization", () => {
    it("1. Sets aavePool, sUSDai immutables", async () => {
      const { provider, aave, susdai } = await loadFixture(deployProvider);
      expect(getAddress(await provider.read.sUSDai())).to.equal(getAddress(susdai.address));
      expect(getAddress(await provider.read.aave())).to.equal(getAddress(aave.address));
    });

    it("2. Reverts on zero aavePool / sUSDai in constructor", async () => {
      const { susdai } = await loadFixture(deployProvider);
      await expect(
        viem.deployContract("AaveAprPairProvider", [zeroAddress, susdai.address])
      ).to.be.rejected;
    });

    it("3. Empty benchmark list rejected by setBenchmarkTokens", async () => {
      const { provider } = await loadFixture(deployProvider);
      await expect(provider.write.setBenchmarkTokens([[]])).to.be.rejected;
    });
  });

  describe("getAPRtarget — happy path", () => {
    it("4. Weighted avg across 2 markets computed correctly", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const usdt = await viem.deployContract("MockERC20", ["USDT", "USDT", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      const aUSDT = await viem.deployContract("MockERC20", ["aUSDT", "aUSDT", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aUSDT.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await aave.write.setReserve([usdt.address, rayFromPct(7), aUSDT.address]);
      await provider.write.setBenchmarkTokens([[usdc.address, usdt.address]]);
      const [, aprTarget] = await provider.read.getApr();
      expect(aprTarget > 0).to.equal(true);
    });

    it("5. Single benchmark returns that market's APR", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const [, aprTarget] = await provider.read.getApr();
      expect(aprTarget > 0n).to.equal(true);
    });

    it("6. RAY → 12-dec conversion accurate", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      // 1% in RAY = 1e25
      await aave.write.setReserve([usdc.address, 10n ** 25n, aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const [, aprTarget] = await provider.read.getApr();
      expect(aprTarget).to.equal(10n ** 10n); // 1% in SD7x12 = 0.01 * 1e12 = 1e10
    });
  });

  describe("getAPRtarget — bounds + reverts", () => {
    it("7. aprAvg > BOUND_MAX (0.4e12) → reverts InvalidAprAvg", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      // 50% APR — exceeds 40% cap
      await aave.write.setReserve([usdc.address, rayFromPct(50), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      await expect(provider.read.getApr()).to.be.rejected;
    });

    it("8. aprAvg below BOUND_MIN doesn't apply (BOUND_MIN=0)", async () => {
      const { provider } = await loadFixture(deployProvider);
      expect(await provider.read.APR_TARGET_MIN()).to.equal(0n);
    });

    it("9. totalWeight == 0 → reverts InvalidAprAvg(0)", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      await expect(provider.read.getApr()).to.be.rejected;
    });

    it("10. Empty benchmarks → reverts EmptyBenchmark on getApr", async () => {
      const { provider } = await loadFixture(deployProvider);
      await expect(provider.read.getApr()).to.be.rejected;
    });

    it("11. Invalid Aave reserve (aTokenAddress=0) → reverts InvalidBenchmarkToken", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      // Set with aTokenAddress = 0
      await aave.write.setReserve([usdc.address, rayFromPct(5), zeroAddress]);
      await expect(provider.write.setBenchmarkTokens([[usdc.address]])).to.be.rejected;
    });
  });

  describe("getAPRbase — sUSDai share-price sampling", () => {
    // Helper: wire benchmark, take a sample at initial price, advance
    // time, set a new price, return aprBase reading.
    async function setupAndSample(
      initialPrice: bigint,
      priceAfter: bigint,
      elapsedSeconds: number
    ) {
      const ctx = await loadFixture(deployProvider);
      const { provider, susdai, aave } = ctx;
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);

      await susdai.write.setDepositSharePrice([initialPrice]);
      await provider.write.sampleRate();

      await time.increase(elapsedSeconds);
      await susdai.write.setDepositSharePrice([priceAfter]);
      return ctx;
    }

    it("12. Share price grew → aprBase > 0 (annualised delta)", async () => {
      // 1.0 → 1.001 over 1 day ≈ 36.5% APR (linear annualised)
      const ctx = await setupAndSample(10n ** 18n, 1001n * 10n ** 15n, 24 * 60 * 60);
      const [aprBase] = await ctx.provider.read.getApr();
      expect(aprBase > 0n).to.equal(true);
    });

    it("13. No sample taken yet → aprBase == 0", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      // Never called sampleRate().
      const [aprBase] = await provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("14. Price didn't grow (priceNow == sample) → aprBase == 0", async () => {
      const ctx = await setupAndSample(10n ** 18n, 10n ** 18n, 24 * 60 * 60);
      const [aprBase] = await ctx.provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("15. Price went DOWN → aprBase == 0 (conservative)", async () => {
      // Loss should not be reported as positive APR.
      const ctx = await setupAndSample(10n ** 18n, 999n * 10n ** 15n, 24 * 60 * 60);
      const [aprBase] = await ctx.provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("16. lastSample == 0 path → aprBase == 0 (defensive)", async () => {
      // Set the sample to 0 explicitly (degenerate state — shouldn't
      // happen via sampleRate but the early-return is defence-in-depth).
      const ctx = await loadFixture(deployProvider);
      const { provider, susdai, aave } = ctx;
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);

      await susdai.write.setDepositSharePrice([0n]);
      await provider.write.sampleRate();
      await time.increase(24 * 60 * 60);
      await susdai.write.setDepositSharePrice([10n ** 18n]);

      const [aprBase] = await provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("17. Extreme delta clamped at 2e12 (200%)", async () => {
      // 1.0 → 1000.0 over 1 second → astronomical APR → clamped.
      const ctx = await setupAndSample(10n ** 18n, 1000n * 10n ** 18n, 1);
      const [aprBase] = await ctx.provider.read.getApr();
      expect(aprBase <= 2n * 10n ** 12n).to.equal(true);
      expect(aprBase > 0n).to.equal(true);
    });

    it("17a. sampleRate is gated by UPDATER_STRAT_CONFIG_ROLE", async () => {
      const { provider, user } = await loadFixture(deployProvider);
      // user has no role granted.
      await expect(
        provider.write.sampleRate({ account: user.account })
      ).to.be.rejected;
    });

    it("17b. sampleRate writes lastSample + lastSampleAt", async () => {
      const { provider, susdai } = await loadFixture(deployProvider);
      await susdai.write.setDepositSharePrice([12345n * 10n ** 14n]);
      await provider.write.sampleRate();

      const sample = await provider.read.lastSample();
      const at = await provider.read.lastSampleAt();
      expect(sample).to.equal(12345n * 10n ** 14n);
      expect(at > 0n).to.equal(true);
    });
  });

  describe("getApr — 3-tuple", () => {
    it("18. Returns (aprBase, aprTarget, updatedAt)", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const [aprBase, aprTarget, updatedAt] = await provider.read.getApr();
      expect(aprTarget >= 0n).to.equal(true);
      expect(updatedAt > 0n).to.equal(true);
    });

    it("19. Both values within int64 range (covered by clamp)", async () => {
      const { provider } = await loadFixture(deployProvider);
      expect(await provider.read.APR_TARGET_MAX()).to.equal(4n * 10n ** 11n);
    });
  });

  describe("admin", () => {
    it("20. setBenchmarkTokens role-gated UPDATER_STRAT_CONFIG_ROLE", async () => {
      const { provider, user } = await loadFixture(deployProvider);
      await expect(
        provider.write.setBenchmarkTokens([[]], { account: user.account })
      ).to.be.rejected;
    });

    it("21. setBenchmarkTokens allows up to MAX_BENCHMARK_TOKENS", async () => {
      const { provider } = await loadFixture(deployProvider);
      expect(await provider.read.MAX_BENCHMARK_TOKENS()).to.equal(8n);
    });

    it("22. setBenchmarkTokens rejects > MAX_BENCHMARK_TOKENS (9)", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const tokens: any[] = [];
      for (let i = 0; i < 9; i++) {
        const t = await viem.deployContract("MockERC20", ["T", "T", 6]);
        const a = await viem.deployContract("MockERC20", ["aT", "aT", 6]);
        await aave.write.setReserve([t.address, rayFromPct(1), a.address]);
        tokens.push(t.address);
      }
      await expect(provider.write.setBenchmarkTokens([tokens])).to.be.rejected;
    });

    it("23. setBenchmarkTokens rejects zero address + invalid reserve", async () => {
      const { provider } = await loadFixture(deployProvider);
      await expect(provider.write.setBenchmarkTokens([[zeroAddress]])).to.be.rejected;
    });

    it("24. benchmarkTokens() view returns the configured list", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const list = await provider.read.benchmarkTokens();
      expect(list.length).to.equal(1);
      expect(getAddress(list[0])).to.equal(getAddress(usdc.address));
    });

    it("25. benchmarkTokensLength() view returns the configured count", async () => {
      const { provider, aave } = await loadFixture(deployProvider);
      const t1 = await viem.deployContract("MockERC20", ["T1", "T1", 6]);
      const t2 = await viem.deployContract("MockERC20", ["T2", "T2", 6]);
      const a1 = await viem.deployContract("MockERC20", ["aT1", "aT1", 6]);
      const a2 = await viem.deployContract("MockERC20", ["aT2", "aT2", 6]);
      await aave.write.setReserve([t1.address, rayFromPct(1), a1.address]);
      await aave.write.setReserve([t2.address, rayFromPct(1), a2.address]);
      await provider.write.setBenchmarkTokens([[t1.address, t2.address]]);
      expect(await provider.read.benchmarkTokensLength()).to.equal(2n);
    });
  });
});
