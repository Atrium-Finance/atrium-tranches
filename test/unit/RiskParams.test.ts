import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RiskParams", () => {
  let riskParams: any;
  let owner: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("RiskParams");
    riskParams = await Factory.deploy(owner.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Defaults
  // ═══════════════════════════════════════════════════════════════════

  describe("defaults", () => {
    it("should set correct senior premium defaults", async () => {
      const [x, y, k] = await riskParams.s_seniorPremium();
      expect(x).to.equal(BigInt("100000000000000000")); // 0.10e18
      expect(y).to.equal(BigInt("125000000000000000")); // 0.125e18
      expect(k).to.equal(BigInt("300000000000000000")); // 0.3e18
    });

    it("should set correct reserveBps default", async () => {
      expect(await riskParams.s_reserveBps()).to.equal(500);
    });

    it("should set correct owner", async () => {
      expect(await riskParams.owner()).to.equal(owner.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setSeniorPremium
  // ═══════════════════════════════════════════════════════════════════

  describe("setSeniorPremium", () => {
    it("should update senior premium with valid params", async () => {
      const curve = {
        x: (15n * E18) / 100n,
        y: (20n * E18) / 100n,
        k: (25n * E18) / 100n,
      };
      await expect(riskParams.setSeniorPremium(curve))
        .to.emit(riskParams, "SeniorPremiumUpdated")
        .withArgs(curve.x, curve.y, curve.k);

      const [x, y, k] = await riskParams.s_seniorPremium();
      expect(x).to.equal(curve.x);
      expect(y).to.equal(curve.y);
      expect(k).to.equal(curve.k);
    });

    it("should accept x at max boundary (0.30e18)", async () => {
      const curve = {
        x: (30n * E18) / 100n,
        y: (50n * E18) / 100n,
        k: (3n * E18) / 10n,
      };
      await expect(riskParams.setSeniorPremium(curve)).to.not.be.reverted;
    });

    it("should accept x+y at max boundary (0.80e18)", async () => {
      const curve = {
        x: (30n * E18) / 100n,
        y: (50n * E18) / 100n,
        k: (3n * E18) / 10n,
      };
      await expect(riskParams.setSeniorPremium(curve)).to.not.be.reverted;
    });

    it("should revert when x > 0.30e18", async () => {
      const curve = {
        x: (31n * E18) / 100n,
        y: (10n * E18) / 100n,
        k: (3n * E18) / 10n,
      };
      await expect(
        riskParams.setSeniorPremium(curve),
      ).to.be.revertedWithCustomError(
        riskParams,
        "PrimeVaults__SeniorXTooHigh",
      );
    });

    it("should revert when x+y > 0.80e18", async () => {
      const curve = {
        x: (30n * E18) / 100n,
        y: (51n * E18) / 100n,
        k: (3n * E18) / 10n,
      };
      await expect(
        riskParams.setSeniorPremium(curve),
      ).to.be.revertedWithCustomError(
        riskParams,
        "PrimeVaults__SeniorXYTooHigh",
      );
    });

    it("should revert when called by non-owner", async () => {
      const curve = {
        x: (10n * E18) / 100n,
        y: (12n * E18) / 100n,
        k: (3n * E18) / 10n,
      };
      await expect(
        riskParams.connect(other).setSeniorPremium(curve),
      ).to.be.revertedWithCustomError(riskParams, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setReserveBps
  // ═══════════════════════════════════════════════════════════════════

  describe("setReserveBps", () => {
    it("should update reserveBps with valid value", async () => {
      await expect(riskParams.setReserveBps(1000))
        .to.emit(riskParams, "ReserveBpsUpdated")
        .withArgs(1000);
      expect(await riskParams.s_reserveBps()).to.equal(1000);
    });

    it("should accept reserveBps at max boundary (2000)", async () => {
      await expect(riskParams.setReserveBps(2000)).to.not.be.reverted;
    });

    it("should accept reserveBps at zero", async () => {
      await expect(riskParams.setReserveBps(0)).to.not.be.reverted;
      expect(await riskParams.s_reserveBps()).to.equal(0);
    });

    it("should revert when reserveBps > 2000", async () => {
      await expect(
        riskParams.setReserveBps(2001),
      ).to.be.revertedWithCustomError(
        riskParams,
        "PrimeVaults__ReserveBpsTooHigh",
      );
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        riskParams.connect(other).setReserveBps(500),
      ).to.be.revertedWithCustomError(riskParams, "OwnableUnauthorizedAccount");
    });
  });
});
