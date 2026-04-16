import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("PrimeCDO — Loss Coverage & Shortfall", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let mockUSDai: any;

  let owner: SignerWithAddress;
  let seniorVault: SignerWithAddress;
  let mezzVault: SignerWithAddress;
  let juniorVault: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  async function seedTVL(tranche: number, amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await accounting.connect(cdoSigner).recordDeposit(tranche, amount);
    await mockUSDai.mint(await strategy.getAddress(), amount);
  }

  beforeEach(async () => {
    [owner, seniorVault, mezzVault, juniorVault, other] = await ethers.getSigners();

    // --- Tokens ---
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");

    // --- Accounting ---
    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // --- Predict CDO address: Strategy(+0), CDO(+1) ---
    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("MockStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockUSDai.getAddress());

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
      ethers.ZeroAddress, owner.address,
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(MEZZ, mezzVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Shortfall auto-pause at 90% Junior price
  // ═══════════════════════════════════════════════════════════════════

  describe("shortfall auto-pause", () => {
    let mockJrVault: any;

    async function drainStrategy(amount: bigint) {
      const stratAddr = await strategy.getAddress();
      await ethers.provider.send("hardhat_setBalance", [stratAddr, "0x56BC75E2D63100000"]);
      const stratSigner = await ethers.getImpersonatedSigner(stratAddr);
      await mockUSDai.connect(stratSigner).transfer(owner.address, amount);
    }

    beforeEach(async () => {
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(other.address, 10_000n * E18);
    });

    it("should auto-pause when Junior exchange rate drops below 90%", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n); // 0.9e18

      // Simulate 20% loss: Jr TVL drops from 10K to 8K AND reduce strategy assets
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      // Also remove USDai from strategy so updateTVL sees the loss
      const stratAddr = await strategy.getAddress();
      await ethers.provider.send("hardhat_setBalance", [stratAddr, "0x56BC75E2D63100000"]);
      const stratSigner = await ethers.getImpersonatedSigner(stratAddr);
      await mockUSDai.connect(stratSigner).transfer(owner.address, 2_000n * E18);

      await seedTVL(SENIOR, 1_000n * E18);
      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}

      expect(await cdo.s_shortfallPaused()).to.be.true;
    });

    it("should emit ShortfallPauseTriggered event", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      await drainStrategy(2_000n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);

      // The deposit triggers _checkJuniorShortfall internally
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.emit(cdo, "ShortfallPauseTriggered");
    });

    it("should NOT pause when loss is < 10% (price stays above 0.9)", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      // 5% loss: 10K → 9.5K, price = 0.95 > 0.9
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 500n * E18);
      await drainStrategy(500n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}

      expect(await cdo.s_shortfallPaused()).to.be.false;
    });

    it("should block all deposits when shortfall paused", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      // Trigger pause
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      await drainStrategy(2_000n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      // Now all deposits should revert
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should allow deposits again after owner unpauses", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      await drainStrategy(2_000n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      await cdo.connect(owner).unpauseShortfall();
      await cdo.connect(owner).setJuniorShortfallPausePrice(0); // disable threshold

      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.not.be.reverted;
    });
  });
});
