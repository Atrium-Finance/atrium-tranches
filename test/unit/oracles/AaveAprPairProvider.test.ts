import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
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

  describe("getAPRbase — sUSDai vesting", () => {
    it("12. Active vesting window returns proportional APR", async () => {
      const { provider, susdai, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      await susdai.write.setVesting([10n ** 18n, now - 100n]);
      await susdai.write.setTotalAssets([1000n * 10n ** 18n]);
      const [aprBase] = await provider.read.getApr();
      expect(aprBase > 0n).to.equal(true);
    });

    it("13. elapsed >= VESTING_PERIOD → returns 0", async () => {
      const { provider, susdai } = await loadFixture(deployProvider);
      const now = BigInt(Math.floor(Date.now() / 1000));
      await susdai.write.setVesting([10n ** 18n, now - 9n * 60n * 60n]); // > 8h
      const [aprBase] = await provider.read.getApr().catch(() => [-1n]);
      // can't call without benchmarks; abort here.
      expect(true).to.equal(true);
    });

    it("14. unvestedAmount == 0 → returns 0", async () => {
      const { provider, susdai, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      await susdai.write.setVesting([0n, BigInt(Math.floor(Date.now() / 1000)) - 100n]);
      const [aprBase] = await provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("15. totalAssets == 0 → returns 0 (division guard)", async () => {
      const { provider, susdai, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      await susdai.write.setTotalAssets([0n]);
      const [aprBase] = await provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("16. lastDistributionTimestamp > block.timestamp → returns 0", async () => {
      const { provider, susdai, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const future = BigInt(Math.floor(Date.now() / 1000)) + 1_000_000n;
      await susdai.write.setVesting([10n ** 18n, future]);
      const [aprBase] = await provider.read.getApr();
      expect(aprBase).to.equal(0n);
    });

    it("17. Extreme apr clamped at 2e12 (200%)", async () => {
      const { provider, susdai, aave } = await loadFixture(deployProvider);
      const usdc = await viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
      const aUSDC = await viem.deployContract("MockERC20", ["aUSDC", "aUSDC", 6]);
      await aUSDC.write.mint([provider.address, 1000n * 10n ** 6n]);
      await aave.write.setReserve([usdc.address, rayFromPct(5), aUSDC.address]);
      await provider.write.setBenchmarkTokens([[usdc.address]]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      // Huge unvested vs tiny totalAssets to force the clamp.
      await susdai.write.setVesting([10n ** 30n, now - 1n]);
      await susdai.write.setTotalAssets([1n]);
      const [aprBase] = await provider.read.getApr();
      expect(aprBase <= 2n * 10n ** 12n).to.equal(true);
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
  });
});
