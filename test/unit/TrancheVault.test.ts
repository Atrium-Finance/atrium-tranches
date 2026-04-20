import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("TrancheVault — ERC-4626", () => {
  let seniorVault: any;
  let mezzVault: any;
  let juniorVault: any;
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let redemptionPolicy: any;
  let erc20Cooldown: any;
  let sharesCooldown: any;
  let mockUSDai: any;
  let mockSUSDai: any;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const DAY = 86400;

  async function seedTVL(tranche: number, amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await accounting.connect(cdoSigner).recordDeposit(tranche, amount);
    await mockUSDai.mint(await strategy.getAddress(), amount);
  }

  beforeEach(async () => {
    [owner, alice, bob, other] = await ethers.getSigners();

    // --- Tokens ---
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const SUSDaiFactory = await ethers.getContractFactory("MockSUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), 105n * 10n ** 16n); // 1.05 rate

    // --- Accounting ---
    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // --- Cooldown handlers ---
    const EC20Factory = await ethers.getContractFactory("ERC20Cooldown");
    erc20Cooldown = await EC20Factory.deploy(owner.address);
    const SCFactory = await ethers.getContractFactory("SharesCooldown");
    sharesCooldown = await SCFactory.deploy(owner.address);

    // --- RedemptionPolicy ---
    const RPFactory = await ethers.getContractFactory("RedemptionPolicy");
    redemptionPolicy = await RPFactory.deploy(owner.address, await accounting.getAddress());

    // --- Predict addresses: Strategy(+0), CDO(+1) ---
    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("MockStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockUSDai.getAddress());

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      ethers.ZeroAddress, // aprFeed
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), await mockSUSDai.getAddress(), owner.address,
    );

    // --- Deploy 3 TrancheVaults ---
    const VaultFactory = await ethers.getContractFactory("TrancheVault");
    seniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), SENIOR, await mockUSDai.getAddress(),
      "PrimeVaults Senior", "pvSENIOR",
    );
    mezzVault = await VaultFactory.deploy(
      await cdo.getAddress(), MEZZ, await mockUSDai.getAddress(),
      "PrimeVaults Mezzanine", "pvMEZZ",
    );
    juniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), JUNIOR, await mockUSDai.getAddress(),
      "PrimeVaults Junior", "pvJUNIOR",
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, await seniorVault.getAddress());
    await cdo.connect(owner).registerTranche(MEZZ, await mezzVault.getAddress());
    await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);

    // --- Authorize CDO in cooldown contracts ---
    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    // --- Fund users ---
    await mockUSDai.mint(alice.address, 1_000_000n * E18);
    await mockUSDai.mint(bob.address, 1_000_000n * E18);

    // --- Approvals ---
    await mockUSDai.connect(alice).approve(await seniorVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(alice).approve(await mezzVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(alice).approve(await juniorVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(bob).approve(await seniorVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(bob).approve(await mezzVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(bob).approve(await juniorVault.getAddress(), ethers.MaxUint256);

    // --- Configure strategy to track sUSDai in totalAssets ---
    await strategy.setOutputToken(await mockSUSDai.getAddress());

    // --- Fund users with sUSDai ---
    await mockUSDai.mint(alice.address, 200_000n * E18);
    await mockUSDai.connect(alice).approve(await mockSUSDai.getAddress(), ethers.MaxUint256);
    await mockSUSDai.connect(alice).deposit(100_000n * E18, alice.address);

    // --- sUSDai approvals ---
    const sUSDaiAddr = await mockSUSDai.getAddress();
    await (mockSUSDai as any).connect(alice).approve(await seniorVault.getAddress(), ethers.MaxUint256);
    await (mockSUSDai as any).connect(alice).approve(await mezzVault.getAddress(), ethers.MaxUint256);
    await (mockSUSDai as any).connect(alice).approve(await juniorVault.getAddress(), ethers.MaxUint256);

    // --- Seed Junior TVL so Sr/Mz coverage gate passes ---
    await seedTVL(JUNIOR, 500_000n * E18);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  totalAssets — reads from Accounting
  // ═══════════════════════════════════════════════════════════════════

  describe("totalAssets", () => {
    it("should return 0 when no shares exist (totalSupply == 0)", async () => {
      // TVL seeded but no shares minted → totalAssets guards against dust inflation
      expect(await seniorVault.totalAssets()).to.equal(0n);
    });

    it("should read Senior TVL from Accounting after deposit", async () => {
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      expect(await seniorVault.totalAssets()).to.equal(10_000n * E18);
      // Seed extra TVL (yield) → totalAssets increases
      await seedTVL(SENIOR, 1_000n * E18);
      expect(await seniorVault.totalAssets()).to.equal(11_000n * E18);
    });

    it("should read Mezzanine TVL from Accounting after deposit", async () => {
      await mezzVault.connect(alice).deposit(5_000n * E18, alice.address);
      expect(await mezzVault.totalAssets()).to.equal(5_000n * E18);
    });

    it("should read Junior TVL from Accounting after deposit", async () => {
      // Junior has 500K seeded but no shares → totalAssets returns 0
      expect(await juniorVault.totalAssets()).to.equal(0n);
      // Deposit to create shares
      await juniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      expect(await juniorVault.totalAssets()).to.equal(510_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  deposit → mint correct shares (share price invariant)
  // ═══════════════════════════════════════════════════════════════════

  describe("deposit — Senior/Mezz", () => {
    it("should mint 1:1 shares on first deposit", async () => {
      const amount = 10_000n * E18;
      const shares = await seniorVault.connect(alice).deposit.staticCall(amount, alice.address);
      // First deposit: totalSupply=0, totalAssets=0 → shares ≈ assets (1:1)
      expect(shares).to.equal(amount);
    });

    it("should mint shares and increase totalAssets", async () => {
      const amount = 10_000n * E18;
      await seniorVault.connect(alice).deposit(amount, alice.address);

      expect(await seniorVault.balanceOf(alice.address)).to.equal(amount);
      expect(await seniorVault.totalAssets()).to.equal(amount);
      expect(await accounting.s_seniorTVL()).to.equal(amount);
    });

    it("should preserve share price on second deposit", async () => {
      // Alice deposits first
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      const priceBefore = (await seniorVault.totalAssets() * E18) / await seniorVault.totalSupply();

      // Bob deposits second
      await seniorVault.connect(bob).deposit(5_000n * E18, bob.address);
      const priceAfter = (await seniorVault.totalAssets() * E18) / await seniorVault.totalSupply();

      expect(priceAfter).to.equal(priceBefore);
    });

    it("should work for Mezzanine vault", async () => {
      await mezzVault.connect(alice).deposit(5_000n * E18, alice.address);
      expect(await mezzVault.balanceOf(alice.address)).to.equal(5_000n * E18);
      expect(await mezzVault.totalAssets()).to.equal(5_000n * E18);
    });

    it("should emit Deposit event", async () => {
      await expect(
        seniorVault.connect(alice).deposit(1_000n * E18, alice.address),
      ).to.emit(seniorVault, "Deposit");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  deposit — Junior uses deposit() (same as Sr/Mz)
  // ═══════════════════════════════════════════════════════════════════

  describe("deposit — Junior", () => {
    it("should accept deposit on Junior vault", async () => {
      const amount = 10_000n * E18;
      await juniorVault.connect(alice).deposit(amount, alice.address);

      const shares = await juniorVault.balanceOf(alice.address);
      expect(shares).to.be.gt(0n);
    });

    it("should mint on Junior vault", async () => {
      const shares = 10_000n * E18;
      await juniorVault.connect(alice).mint(shares, alice.address);

      expect(await juniorVault.balanceOf(alice.address)).to.equal(shares);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  requestWithdraw — routes through CDO
  // ═══════════════════════════════════════════════════════════════════

  describe("requestWithdraw", () => {
    beforeEach(async () => {
      // Alice deposits 10K into Senior
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
    });

    it("should burn shares and return instant result", async () => {
      const sharesBefore = await seniorVault.balanceOf(alice.address);
      const sharesToRedeem = 2_000n * E18;

      await seniorVault.connect(alice).requestWithdraw(
        sharesToRedeem, alice.address,
      );

      const sharesAfter = await seniorVault.balanceOf(alice.address);
      expect(sharesBefore - sharesAfter).to.equal(sharesToRedeem);
    });

    it("should emit WithdrawRequested event", async () => {
      await expect(
        seniorVault.connect(alice).requestWithdraw(
          1_000n * E18, alice.address,
        ),
      ).to.emit(seniorVault, "WithdrawRequested");
    });

    it("should revert with zero shares", async () => {
      await expect(
        seniorVault.connect(alice).requestWithdraw(0, alice.address),
      ).to.be.revertedWithCustomError(seniorVault, "PrimeVaults__ZeroShares");
    });

    it("should revert if caller has insufficient shares", async () => {
      await expect(
        seniorVault.connect(bob).requestWithdraw(
          1_000n * E18, bob.address,
        ),
      ).to.be.reverted; // ERC20 insufficient balance
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Standard withdraw/redeem disabled
  // ═══════════════════════════════════════════════════════════════════

  describe("withdraw/redeem disabled", () => {
    it("should revert standard withdraw", async () => {
      await expect(
        seniorVault.connect(alice).withdraw(100n * E18, alice.address, alice.address),
      ).to.be.revertedWithCustomError(seniorVault, "PrimeVaults__UseRequestWithdraw");
    });

    it("should revert standard redeem", async () => {
      await expect(
        seniorVault.connect(alice).redeem(100n * E18, alice.address, alice.address),
      ).to.be.revertedWithCustomError(seniorVault, "PrimeVaults__UseRequestWithdraw");
    });

    it("should return 0 for maxWithdraw", async () => {
      expect(await seniorVault.maxWithdraw(alice.address)).to.equal(0);
    });

    it("should return 0 for maxRedeem", async () => {
      expect(await seniorVault.maxRedeem(alice.address)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Share price increases after yield accrual
  // ═══════════════════════════════════════════════════════════════════

  describe("share price after yield", () => {
    it("should increase share price when Accounting TVL increases (yield accrual)", async () => {
      // Alice deposits 10K Senior
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);

      const priceBefore = await seniorVault.convertToAssets(E18); // price of 1 share

      // Simulate yield: increase Senior TVL by 1K (10% gain)
      await seedTVL(SENIOR, 1_000n * E18);

      const priceAfter = await seniorVault.convertToAssets(E18);

      // Share price should have increased
      expect(priceAfter).to.be.gt(priceBefore);
      // ~10% gain: 11K / 10K shares = 1.1 per share
      expect(priceAfter).to.be.gte(E18 + E18 / 10n - E18 / 1000n); // ≥ ~1.099
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Withdraw → share price stable for remaining holders
  // ═══════════════════════════════════════════════════════════════════

  describe("share price stability after withdrawal", () => {
    it("should maintain share price for remaining holders after withdrawal", async () => {
      // Alice and Bob each deposit 10K
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      await seniorVault.connect(bob).deposit(10_000n * E18, bob.address);

      const priceBefore = await seniorVault.convertToAssets(E18);

      // Alice withdraws 5K worth of shares
      await seniorVault.connect(alice).requestWithdraw(
        5_000n * E18, alice.address,
      );

      const priceAfter = await seniorVault.convertToAssets(E18);

      // Share price should remain the same (within 1 wei rounding)
      expect(priceAfter).to.be.gte(priceBefore - 1n);
      expect(priceAfter).to.be.lte(priceBefore + 1n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claimWithdraw — pass-through to CDO
  // ═══════════════════════════════════════════════════════════════════

  describe("claimWithdraw", () => {
    it("should pass through to CDO claimWithdraw", async () => {
      // Pass invalid handler address — CDO checks it matches i_erc20Cooldown and reverts
      await expect(
        seniorVault.connect(alice).claimWithdraw(1, other.address),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__Unauthorized");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ERC-4626 view compliance
  // ═══════════════════════════════════════════════════════════════════

  describe("ERC-4626 view functions", () => {
    it("should return correct asset address", async () => {
      expect(await seniorVault.asset()).to.equal(await mockUSDai.getAddress());
    });

    it("should return correct name and symbol", async () => {
      expect(await seniorVault.name()).to.equal("PrimeVaults Senior");
      expect(await seniorVault.symbol()).to.equal("pvSENIOR");
      expect(await juniorVault.name()).to.equal("PrimeVaults Junior");
      expect(await juniorVault.symbol()).to.equal("pvJUNIOR");
    });

    it("should compute convertToShares correctly", async () => {
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      // 1:1 rate, 10K assets for 10K shares → 1000 assets = 1000 shares
      const shares = await seniorVault.convertToShares(1_000n * E18);
      expect(shares).to.equal(1_000n * E18);
    });

    it("should compute convertToAssets correctly", async () => {
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      const assets = await seniorVault.convertToAssets(1_000n * E18);
      expect(assets).to.equal(1_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  depositOutputToken — sUSDai deposit
  // ═══════════════════════════════════════════════════════════════════

  describe("depositOutputToken — sUSDai", () => {
    it("should mint shares based on base-equivalent value", async () => {
      const sUSDaiAmount = 10_000n * E18;
      // rate = 1.05, so 10_000 sUSDai = 10_500 USDai base-equivalent
      const expectedBaseAmount = sUSDaiAmount * 105n / 100n;

      await seniorVault.connect(alice).depositOutputToken(sUSDaiAmount, alice.address);

      // First deposit → shares = base-equivalent (1:1)
      const shares = await seniorVault.balanceOf(alice.address);
      expect(shares).to.equal(expectedBaseAmount);
      expect(await seniorVault.totalAssets()).to.equal(expectedBaseAmount);
    });

    it("should preserve share price when mixing base and output token deposits", async () => {
      // Alice deposits USDai first
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);
      const priceBefore = (await seniorVault.totalAssets() * E18) / await seniorVault.totalSupply();

      // Alice deposits sUSDai second
      await seniorVault.connect(alice).depositOutputToken(1_000n * E18, alice.address);
      const priceAfter = (await seniorVault.totalAssets() * E18) / await seniorVault.totalSupply();

      expect(priceAfter).to.equal(priceBefore);
    });

    it("should match previewDepositOutputToken", async () => {
      const sUSDaiAmount = 5_000n * E18;
      const previewShares = await seniorVault.previewDepositOutputToken(sUSDaiAmount);
      await seniorVault.connect(alice).depositOutputToken(sUSDaiAmount, alice.address);
      expect(await seniorVault.balanceOf(alice.address)).to.equal(previewShares);
    });

    it("should revert with zero amount", async () => {
      await expect(
        seniorVault.connect(alice).depositOutputToken(0, alice.address),
      ).to.be.revertedWithCustomError(seniorVault, "PrimeVaults__ZeroShares");
    });

    it("should emit Deposit event with base-equivalent amount", async () => {
      await expect(
        seniorVault.connect(alice).depositOutputToken(1_000n * E18, alice.address),
      ).to.emit(seniorVault, "Deposit");
    });

    it("should work for Junior vault", async () => {
      const sUSDaiAmount = 5_000n * E18;
      const expectedBaseAmount = sUSDaiAmount * 105n / 100n;
      await juniorVault.connect(alice).depositOutputToken(sUSDaiAmount, alice.address);
      expect(await juniorVault.balanceOf(alice.address)).to.be.gt(0n);
    });
  });
});
