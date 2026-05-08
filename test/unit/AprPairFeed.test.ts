import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AprPairFeed", () => {
  let feed: any;
  let provider: any;
  let mockPool: any;
  let mockVault: any;
  let aUsdc: any;
  let aUsdt: any;
  let admin: SignerWithAddress;
  let keeper: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const USDC = "0x0000000000000000000000000000000000000001";
  const USDT = "0x0000000000000000000000000000000000000002";
  const RATE_USDC_RAY = 30_000_000_000_000_000_000_000_000n;
  const RATE_USDT_RAY = 50_000_000_000_000_000_000_000_000n;
  const STALE_AFTER = 172_800; // 48h
  const PROVIDER_APR_TARGET = 40_000_000_000n; // (3% + 5%) / 2 = 4% (12dec)

  let KEEPER_ROLE: string;

  beforeEach(async () => {
    [admin, keeper, other] = await ethers.getSigners();

    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    await mockPool.setAToken(USDC, await aUsdc.getAddress());
    await mockPool.setAToken(USDT, await aUsdt.getAddress());
    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);
    await aUsdc.mint(admin.address, ethers.parseUnits("1000000", 18));
    await aUsdt.mint(admin.address, ethers.parseUnits("1000000", 18));

    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

    const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
    provider = await ProviderFactory.deploy(
      await mockPool.getAddress(),
      [USDC, USDT],
      await mockVault.getAddress(),
    );

    const FeedFactory = await ethers.getContractFactory("AprPairFeed");
    feed = await FeedFactory.deploy(
      admin.address,
      await provider.getAddress(),
      STALE_AFTER,
    );

    KEEPER_ROLE = await feed.KEEPER_ROLE();
    await feed.connect(admin).grantRole(KEEPER_ROLE, keeper.address);
  });

  describe("constructor", () => {
    it("should set roundStaleAfter", async () => {
      expect(await feed.s_roundStaleAfter()).to.equal(STALE_AFTER);
    });

    it("should set DECIMALS to 12", async () => {
      expect(await feed.DECIMALS()).to.equal(12);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  updateRoundData — PULL writes Aave benchmark to Senior aprTarget
  // ═══════════════════════════════════════════════════════════════════

  describe("updateRoundData (PULL)", () => {
    it("should write Aave benchmark to Senior aprTarget", async () => {
      await time.increase(10);
      await feed.connect(keeper).updateRoundData();

      const round = await feed.getRoundData(1);
      expect(round.aprTargetSenior).to.equal(PROVIDER_APR_TARGET);
      expect(round.aprBase).to.equal(0);
      expect(round.answeredInRound).to.equal(1);
    });

    it("should shift provider snapshots (mutate path)", async () => {
      const [prevBefore] = await provider.s_prevSnapshot();
      expect(prevBefore).to.equal(0);

      await time.increase(10);
      await feed.connect(keeper).updateRoundData();

      const [prevAfter] = await provider.s_prevSnapshot();
      expect(prevAfter).to.equal(E18);
    });

    it("should emit RoundUpdated with Senior target leg", async () => {
      await time.increase(10);
      const tx = await feed.connect(keeper).updateRoundData();
      const receipt = await tx.wait();
      const log = receipt.logs.find(
        (l: any) => l.fragment && l.fragment.name === "RoundUpdated",
      );
      expect(log).to.not.equal(undefined);
      expect(log.args.aprTargetSenior).to.equal(PROVIDER_APR_TARGET);
    });

    it("should update s_latestRound for fast path", async () => {
      await time.increase(10);
      await feed.connect(keeper).updateRoundData();

      const latest = await feed.s_latestRound();
      expect(latest.aprTargetSenior).to.equal(PROVIDER_APR_TARGET);
      expect(latest.answeredInRound).to.equal(1);
      expect(latest.updatedAt).to.be.gt(0);
    });

    it("should store non-zero aprBase after 2 rounds", async () => {
      await time.increase(86400);
      await feed.connect(keeper).updateRoundData();

      const dailyGrowth = (E18 * 15n) / (100n * 365n);
      await mockVault.setRate(E18 + dailyGrowth);

      await time.increase(86400);
      await feed.connect(keeper).updateRoundData();

      const round = await feed.getRoundData(2);
      expect(round.aprBase).to.be.gt(0);
    });

    it("should store multiple rounds sequentially", async () => {
      for (let i = 0; i < 5; i++) {
        await time.increase(3600);
        await feed.connect(keeper).updateRoundData();
      }
      expect(await feed.s_currentRoundId()).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  pushSeniorAprTarget — keeper push (Senior leg only)
  // ═══════════════════════════════════════════════════════════════════

  describe("pushSeniorAprTarget", () => {
    beforeEach(async () => {
      // Seed a baseline round so base can be carried forward
      await time.increase(10);
      await feed.connect(keeper).updateRoundData();
    });

    it("should override Senior leg, carrying base forward", async () => {
      await time.increase(60);
      const ts = (await time.latest()) + 1;
      const newSenior = 50_000_000_000n; // 5%

      await feed.connect(keeper).pushSeniorAprTarget(newSenior, ts);

      const round = await feed.getRoundData(2);
      expect(round.aprTargetSenior).to.equal(newSenior);
      expect(round.aprBase).to.equal(0);
    });

    it("should emit SeniorAprTargetPushed event", async () => {
      await time.increase(60);
      const ts = (await time.latest()) + 1;
      const newSenior = 70_000_000_000n;

      await expect(feed.connect(keeper).pushSeniorAprTarget(newSenior, ts))
        .to.emit(feed, "SeniorAprTargetPushed")
        .withArgs(2, newSenior, ts);
    });

    it("should revert without KEEPER_ROLE", async () => {
      const ts = (await time.latest()) + 1;
      await expect(
        feed.connect(other).pushSeniorAprTarget(50_000_000_000n, ts),
      ).to.be.reverted;
    });

    it("should revert on out-of-order timestamp", async () => {
      const latest = await feed.s_latestRound();
      await expect(
        feed.connect(keeper).pushSeniorAprTarget(50_000_000_000n, latest.updatedAt),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__OutOfOrderUpdate");
    });

    it("should revert on out-of-bounds value", async () => {
      await time.increase(60);
      const ts = (await time.latest()) + 1;
      const tooHigh = 3_000_000_000_000n; // 300%
      await expect(
        feed.connect(keeper).pushSeniorAprTarget(tooHigh, ts),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__InvalidApr");
    });

    it("should revert on stale timestamp", async () => {
      const stale = (await time.latest()) - STALE_AFTER - 100;
      await expect(
        feed.connect(keeper).pushSeniorAprTarget(50_000_000_000n, stale),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__StaleUpdate");
    });

    it("should revert on future-drift timestamp", async () => {
      const future = (await time.latest()) + 3600;
      await expect(
        feed.connect(keeper).pushSeniorAprTarget(50_000_000_000n, future),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__OutOfOrderUpdate");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  pushAprBase — keeper push for base APR alone
  // ═══════════════════════════════════════════════════════════════════

  describe("pushAprBase", () => {
    beforeEach(async () => {
      await time.increase(10);
      await feed.connect(keeper).updateRoundData();
    });

    it("should override only aprBase, carrying Senior target forward", async () => {
      await time.increase(60);
      const ts = (await time.latest()) + 1;
      const newBase = 80_000_000_000n; // 8%

      await feed.connect(keeper).pushAprBase(newBase, ts);

      const round = await feed.getRoundData(2);
      expect(round.aprTargetSenior).to.equal(PROVIDER_APR_TARGET);
      expect(round.aprBase).to.equal(newBase);
    });

    it("should emit AprBasePushed", async () => {
      await time.increase(60);
      const ts = (await time.latest()) + 1;
      const newBase = 80_000_000_000n;

      await expect(feed.connect(keeper).pushAprBase(newBase, ts))
        .to.emit(feed, "AprBasePushed")
        .withArgs(2, newBase, ts);
    });

    it("should revert without KEEPER_ROLE", async () => {
      const ts = (await time.latest()) + 1;
      await expect(feed.connect(other).pushAprBase(50_000_000_000n, ts)).to.be.reverted;
    });

    it("should revert on out-of-bounds value", async () => {
      await time.increase(60);
      const ts = (await time.latest()) + 1;
      const tooLow = -1_000_000_000_000n; // -100%
      await expect(
        feed.connect(keeper).pushAprBase(tooLow, ts),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__InvalidApr");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Carry-forward across mixed pushes
  // ═══════════════════════════════════════════════════════════════════

  describe("mixed push sequence", () => {
    it("should preserve cross-leg values across a Senior→Base sequence", async () => {
      await time.increase(10);
      await feed.connect(keeper).updateRoundData(); // round 1: Senior = 4%, base = 0

      await time.increase(60);
      let ts = (await time.latest()) + 1;
      await feed.connect(keeper).pushSeniorAprTarget(50_000_000_000n, ts); // round 2

      await time.increase(60);
      ts = (await time.latest()) + 1;
      await feed.connect(keeper).pushAprBase(70_000_000_000n, ts); // round 3

      const r3 = await feed.getRoundData(3);
      expect(r3.aprTargetSenior).to.equal(50_000_000_000n);
      expect(r3.aprBase).to.equal(70_000_000_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  latestRoundData — cache if fresh, provider view if stale
  // ═══════════════════════════════════════════════════════════════════

  describe("latestRoundData", () => {
    it("should return cached round if not stale", async () => {
      await time.increase(10);
      await feed.connect(keeper).updateRoundData();

      const round = await feed.latestRoundData();
      expect(round.aprTargetSenior).to.equal(PROVIDER_APR_TARGET);
      expect(round.answeredInRound).to.equal(1);
    });

    it("should fall back to getAprPairView if stale (no snapshot shift)", async () => {
      await time.increase(10);
      await feed.connect(keeper).updateRoundData();

      await time.increase(STALE_AFTER + 1);

      const [prevBefore] = await provider.s_prevSnapshot();
      const round = await feed.latestRoundData();

      expect(round.answeredInRound).to.equal(2);

      const [prevAfter] = await provider.s_prevSnapshot();
      expect(prevAfter).to.equal(prevBefore);
    });

    it("should fall back to provider view if cache empty", async () => {
      const round = await feed.latestRoundData();

      expect(round.aprTargetSenior).to.equal(PROVIDER_APR_TARGET);
      expect(round.answeredInRound).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Bounds validation
  // ═══════════════════════════════════════════════════════════════════

  describe("bounds validation", () => {
    it("should accept normal APR from provider", async () => {
      await time.increase(10);
      await expect(feed.connect(keeper).updateRoundData()).to.not.be.reverted;
    });

    it("should accept clamped extreme values from provider", async () => {
      await time.increase(86400);
      await feed.connect(keeper).updateRoundData();

      await mockVault.setRate(E18 * 100n);
      await time.increase(86400);
      await expect(feed.connect(keeper).updateRoundData()).to.not.be.reverted;

      const round = await feed.getRoundData(2);
      expect(round.aprBase).to.equal(2_000_000_000_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getRoundData — historical
  // ═══════════════════════════════════════════════════════════════════

  describe("getRoundData", () => {
    it("should return historical round by ID", async () => {
      for (let i = 0; i < 3; i++) {
        await time.increase(3600);
        await feed.connect(keeper).updateRoundData();
      }

      const r1 = await feed.getRoundData(1);
      const r3 = await feed.getRoundData(3);
      expect(r1.answeredInRound).to.equal(1);
      expect(r3.answeredInRound).to.equal(3);
    });

    it("should revert if round overwritten (>20 rounds)", async () => {
      for (let i = 0; i < 21; i++) {
        await time.increase(3600);
        await feed.connect(keeper).updateRoundData();
      }

      await expect(feed.getRoundData(1)).to.be.revertedWithCustomError(
        feed,
        "PrimeVaults__RoundNotAvailable",
      );
      await expect(feed.getRoundData(2)).to.not.be.reverted;
    });

    it("should revert for roundId beyond current or below oldest", async () => {
      await expect(feed.getRoundData(0)).to.be.revertedWithCustomError(
        feed,
        "PrimeVaults__RoundNotAvailable",
      );
      await expect(feed.getRoundData(999)).to.be.revertedWithCustomError(
        feed,
        "PrimeVaults__RoundNotAvailable",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setProvider — compat check via getAprPairView
  // ═══════════════════════════════════════════════════════════════════

  describe("setProvider", () => {
    it("should update provider via getAprPairView compat check (no side effect)", async () => {
      const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      const provider2 = await ProviderFactory.deploy(
        await mockPool.getAddress(),
        [USDC, USDT],
        await mockVault.getAddress(),
      );

      const [prevBefore] = await provider2.s_prevSnapshot();
      await feed.connect(admin).setProvider(await provider2.getAddress());
      const [prevAfter] = await provider2.s_prevSnapshot();

      expect(prevAfter).to.equal(prevBefore);
    });

    it("should emit ProviderSet event", async () => {
      const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      const provider2 = await ProviderFactory.deploy(
        await mockPool.getAddress(),
        [USDC, USDT],
        await mockVault.getAddress(),
      );
      await expect(feed.connect(admin).setProvider(await provider2.getAddress())).to.emit(
        feed,
        "ProviderSet",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setRoundStaleAfter
  // ═══════════════════════════════════════════════════════════════════

  describe("setRoundStaleAfter", () => {
    it("should update stale period", async () => {
      await feed.connect(admin).setRoundStaleAfter(3600);
      expect(await feed.s_roundStaleAfter()).to.equal(3600);
    });

    it("should emit StalePeriodSet event", async () => {
      await expect(feed.connect(admin).setRoundStaleAfter(3600))
        .to.emit(feed, "StalePeriodSet")
        .withArgs(3600);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control — KEEPER_ROLE
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert updateRoundData without KEEPER_ROLE", async () => {
      await expect(feed.connect(other).updateRoundData()).to.be.reverted;
    });

    it("should revert setProvider without DEFAULT_ADMIN_ROLE", async () => {
      await expect(feed.connect(other).setProvider(other.address)).to.be.reverted;
    });

    it("should revert setRoundStaleAfter without DEFAULT_ADMIN_ROLE", async () => {
      await expect(feed.connect(other).setRoundStaleAfter(3600)).to.be.reverted;
    });
  });
});
