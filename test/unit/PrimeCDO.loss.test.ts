import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const JUNIOR = 1;

describe("PrimeCDO — Loss Coverage & Shortfall", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let mockUSDai: any;

  let owner: SignerWithAddress;
  let seniorVault: SignerWithAddress;
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
    [owner, seniorVault, juniorVault, other] = await ethers.getSigners();

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
      ethers.ZeroAddress, // aprFeed
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
      ethers.ZeroAddress, owner.address,
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Manual shortfall pause via guardian (auto-trigger removed by design)
  // ═══════════════════════════════════════════════════════════════════

  describe("manual shortfall pause (guardian)", () => {
    beforeEach(async () => {
      await cdo.connect(owner).setGuardian(owner.address);
    });

    it("should pause when guardian calls triggerShortfallPause", async () => {
      await cdo.connect(owner).triggerShortfallPause();
      expect(await cdo.s_shortfallPaused()).to.be.true;
    });

    it("should block all deposits when paused", async () => {
      await cdo.connect(owner).triggerShortfallPause();
      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should allow deposits again after owner unpauses", async () => {
      await cdo.connect(owner).triggerShortfallPause();
      await cdo.connect(owner).unpauseShortfall();
      expect(await cdo.s_shortfallPaused()).to.be.false;
    });
  });
});
