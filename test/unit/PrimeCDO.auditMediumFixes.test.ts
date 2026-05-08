// Regression tests for audit findings M#1 (claim-side), M#2, M#3.
// Each test demonstrates the bug pattern is now blocked by the fix.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const JUNIOR = 1;

const E18 = 10n ** 18n;

describe("PrimeCDO — Audit medium fixes (M#1, M#2, M#3)", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let redemptionPolicy: any;
  let erc20Cooldown: any;
  let sharesCooldown: any;
  let mockUSDai: any;
  let mockSUSDai: any;
  let seniorVault: any;
  let juniorVault: any;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let attacker: SignerWithAddress;
  let beneficiary: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, attacker, beneficiary] = await ethers.getSigners();

    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18);
    await mockUSDai.mint(await mockSUSDai.getAddress(), 10_000_000n * E18);

    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    const EC20Factory = await ethers.getContractFactory("ERC20Cooldown");
    erc20Cooldown = await EC20Factory.deploy(owner.address);
    const SCFactory = await ethers.getContractFactory("SharesCooldown");
    sharesCooldown = await SCFactory.deploy(owner.address);

    const RPFactory = await ethers.getContractFactory("RedemptionPolicy");
    redemptionPolicy = await RPFactory.deploy(owner.address, await accounting.getAddress());

    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 1 });

    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockSUSDai.getAddress(), owner.address);

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      ethers.ZeroAddress,
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), await mockSUSDai.getAddress(), owner.address,
    );

    const VaultFactory = await ethers.getContractFactory("TrancheVault");
    seniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), SENIOR, await mockUSDai.getAddress(),
      "PrimeVaults Senior", "pvSENIOR",
    );
    juniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), JUNIOR, await mockUSDai.getAddress(),
      "PrimeVaults Junior", "pvJUNIOR",
    );

    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, await seniorVault.getAddress());
    await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);

    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    await mockUSDai.mint(alice.address, 1_000_000n * E18);
    await mockUSDai.connect(alice).approve(await seniorVault.getAddress(), ethers.MaxUint256);
    await mockUSDai.connect(alice).approve(await juniorVault.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  M#3 — registerTranche cleanup
  // ═══════════════════════════════════════════════════════════════════

  describe("M#3 — registerTranche clears stale s_vaultToTranche on rotation", () => {
    it("should delete reverse mapping for old vault when rotating to new vault", async () => {
      const oldJuniorVault = await juniorVault.getAddress();

      // Pre: oldJunior maps to JUNIOR
      expect(await cdo.s_vaultToTranche(oldJuniorVault)).to.equal(JUNIOR);

      // Deploy new Junior vault
      const VaultFactory = await ethers.getContractFactory("TrancheVault");
      const newJuniorVault = await VaultFactory.deploy(
        await cdo.getAddress(), JUNIOR, await mockUSDai.getAddress(),
        "PrimeVaults Junior v2", "pvJUNIOR2",
      );

      // Rotate
      await cdo.connect(owner).registerTranche(JUNIOR, await newJuniorVault.getAddress());

      // Post: oldJunior reverse mapping cleared (default 0 = SENIOR — but we just check it's not pointing JUNIOR anymore)
      // We can't distinguish SENIOR from "unset" via the mapping alone, but the round-trip check
      // (M#2) catches it: s_tranches[SENIOR] == seniorVault, not oldJunior.
      // Direct check: forward mapping is the new vault.
      expect(await cdo.s_tranches(JUNIOR)).to.equal(await newJuniorVault.getAddress());
      expect(await cdo.s_vaultToTranche(await newJuniorVault.getAddress())).to.equal(JUNIOR);

      // Critical: oldJunior reverse mapping is now SENIOR (default 0) — but round-trip check will catch any abuse.
      const oldRev = await cdo.s_vaultToTranche(oldJuniorVault);
      expect(oldRev).to.equal(SENIOR); // default 0, since deleted
      // … but s_tranches[SENIOR] != oldJuniorVault, so claimSharesWithdraw on oldVault will revert (M#2 round-trip)
      expect(await cdo.s_tranches(SENIOR)).to.not.equal(oldJuniorVault);
    });

    it("should be safe to register the same vault twice (no-op for the reverse mapping)", async () => {
      const v = await juniorVault.getAddress();
      await cdo.connect(owner).registerTranche(JUNIOR, v); // re-register same
      expect(await cdo.s_vaultToTranche(v)).to.equal(JUNIOR);
      expect(await cdo.s_tranches(JUNIOR)).to.equal(v);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  M#2 — round-trip vault check in claimSharesWithdraw
  // ═══════════════════════════════════════════════════════════════════

  describe("M#2 — claimSharesWithdraw round-trip check", () => {
    it("should revert claimSharesWithdraw if req.token doesn't round-trip to its tranche", async () => {
      // Deploy a fake "vault" — any contract is fine; we just need an address that isn't a registered tranche.
      const FakeVaultFactory = await ethers.getContractFactory("MockBaseAsset");
      const fakeVault = await FakeVaultFactory.deploy("FAKE", "FAKE");

      // Authorize a non-CDO account in SharesCooldown to simulate the "shared cooldown" precondition.
      await sharesCooldown.connect(owner).setAuthorized(attacker.address, true);

      // Mint fake tokens to attacker so SharesCooldown.request can pull them.
      await fakeVault.mint(attacker.address, 1_000_000n * E18);
      await fakeVault.connect(attacker).approve(await sharesCooldown.getAddress(), ethers.MaxUint256);

      // Attacker creates SHARES_LOCK request with arbitrary token.
      const tx = await sharesCooldown.connect(attacker).request(
        attacker.address,
        await fakeVault.getAddress(),
        1_000_000n * E18,
        0, // no cooldown for test
      );
      const receipt = await tx.wait();
      const ev = sharesCooldown.interface.parseLog(
        receipt.logs.find((l: any) =>
          l.topics[0] === sharesCooldown.interface.getEvent("CooldownRequested").topicHash,
        ),
      )!;
      const requestId = ev.args.requestId;

      // Attempt to drain SENIOR via claimSharesWithdraw with the fake vault.
      await expect(
        cdo.claimSharesWithdraw(requestId)
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__InvalidTrancheVault")
        .withArgs(await fakeVault.getAddress());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  M#1 claim-side — snapshot cap on rate-pump
  // ═══════════════════════════════════════════════════════════════════

  describe("M#1 claim-side — claim baseAmount capped at snapshot × growth factor", () => {
    it("should cap claim at snapshot × (1 + maxClaimGrowthBps/10000) when sUSDai rate is pumped before claim", async () => {
      // Setup: Sr=8000, Jr=2000 → cs = 1.25 → SHARES_LOCK
      await juniorVault.connect(alice).deposit(2_000n * E18, alice.address);
      await seniorVault.connect(alice).deposit(8_000n * E18, alice.address);

      // Alice requests SHARES_LOCK withdraw of all Junior shares.
      // Snapshot baseline = netAmount = 2000 - 1% fee = 1980 (SHARES_LOCK fee = 100 bps).
      const tx1 = await juniorVault.connect(alice).requestWithdraw(2_000n * E18, beneficiary.address);
      const r1 = await tx1.wait();
      const reqEvent = sharesCooldown.interface.parseLog(
        r1.logs.find((l: any) => l.topics[0] === sharesCooldown.interface.getEvent("CooldownRequested").topicHash)!,
      )!;
      const requestId = reqEvent.args.requestId;

      // Verify snapshot stored = netAmount = 1980 USDai
      const expectedSnapshot = 2_000n * E18 - (2_000n * E18 * 100n) / 10_000n;
      expect(await cdo.s_sharesLockBaseSnapshot(requestId)).to.equal(expectedSnapshot);

      // Fast-forward past Junior SHARES_LOCK cooldown (7 days default)
      await time.increase(8 * 86_400);

      // Attacker pumps sUSDai rate massively (50x). strategy.totalAssets() inflates → next _updateAccounting
      // would credit massive gain to Junior → without M#1 fix, claim drains inflated TVL.
      await mockSUSDai.setRate(50n * E18);

      // Claim — should be capped at snapshot × (1 + 5000/10000) = snapshot × 1.5
      const beneficiaryBalBefore = await mockSUSDai.balanceOf(beneficiary.address);
      await cdo.claimSharesWithdraw(requestId);
      const beneficiaryBalAfter = await mockSUSDai.balanceOf(beneficiary.address);
      const sUSDaiReceived = beneficiaryBalAfter - beneficiaryBalBefore;

      // Cap = snapshot × 1.5 = 1980 × 1.5 = 2970 USDai (in base value).
      // Strategy returns sUSDai — at rate 50, 2970 USDai = 2970/50 = 59.4 sUSDai shares.
      const cappedBaseAmount = (expectedSnapshot * 15_000n) / 10_000n; // snapshot × 1.5
      const expectedSUSDai = (cappedBaseAmount * E18) / (50n * E18); // assets ÷ rate

      // Allow tiny rounding tolerance (<1 wei)
      expect(sUSDaiReceived).to.be.closeTo(expectedSUSDai, 10n);

      // Snapshot is consumed
      expect(await cdo.s_sharesLockBaseSnapshot(requestId)).to.equal(0);
    });

    it("should leave claim untouched when growth stays within cap (organic yield)", async () => {
      // Same setup, but only modest rate growth (10%).
      await juniorVault.connect(alice).deposit(2_000n * E18, alice.address);
      await seniorVault.connect(alice).deposit(8_000n * E18, alice.address);

      const tx1 = await juniorVault.connect(alice).requestWithdraw(2_000n * E18, beneficiary.address);
      const r1 = await tx1.wait();
      const reqEvent = sharesCooldown.interface.parseLog(
        r1.logs.find((l: any) => l.topics[0] === sharesCooldown.interface.getEvent("CooldownRequested").topicHash)!,
      )!;
      const requestId = reqEvent.args.requestId;
      const snapshot = await cdo.s_sharesLockBaseSnapshot(requestId);

      // Fast-forward past cooldown
      await time.increase(8 * 86_400);

      // 10% rate increase — within 50% growth cap → no clamp.
      await mockSUSDai.setRate((110n * E18) / 100n);

      // Should claim full computed amount (no cap triggered)
      const balBefore = await mockSUSDai.balanceOf(beneficiary.address);
      await cdo.claimSharesWithdraw(requestId);
      const balAfter = await mockSUSDai.balanceOf(beneficiary.address);
      const sUSDaiReceived = balAfter - balBefore;

      // Compute expected baseAmount post-update without cap.
      // Rate change 1.0 → 1.1 → strategy.totalAssets() = 11000 → gain 1000.
      // After 5% reserve cut: netGain = 950, all to Junior (aprFeed=0, Senior APY=0).
      // Junior TVL post-fee at request-time: started 2000, fee deducted 20 → 1980.
      // Wait, recordFee was called at request, so Junior TVL at request end = 1980.
      // Plus _updateAccounting at request (no rate change yet) → no gain.
      // After SHARES_LOCK request: Junior TVL = 1980, totalSupply = 2000 (still escrowed).
      // After rate pump: claim _updateAccounting reads totalAssets = 11000 (10000 sUSDai held by strategy × 1.1).
      // prevTracked = 1980 + 8000 + 20 (reserve) = 10000. gain = 1000. After 5% cut: 950 to Junior → 2930.
      // baseAmount = sharesReturned × baseTVL / totalSupply = 2000 × 2930 / 2000 = 2930.
      // Cap = 1980 × 1.5 = 2970. baseAmount 2930 < 2970 → no clamp.
      // Strategy converts 2930 USDai at rate 1.1 → 2930/1.1 sUSDai shares = 2663.63...
      const expectedNoClamp = 2_930n * E18;
      const expectedSUSDai = (expectedNoClamp * E18) / ((110n * E18) / 100n);
      expect(sUSDaiReceived).to.be.closeTo(expectedSUSDai, 1_000_000_000_000n); // wider tolerance for compounding rounding
      expect(sUSDaiReceived).to.be.gt(0n);
    });

    it("should allow admin to update s_maxClaimGrowthBps within bounds", async () => {
      await cdo.connect(owner).setMaxClaimGrowthBps(10_000); // 100%
      expect(await cdo.s_maxClaimGrowthBps()).to.equal(10_000);
    });

    it("should revert setMaxClaimGrowthBps above MAX_CLAIM_GROWTH_BPS_LIMIT", async () => {
      await expect(
        cdo.connect(owner).setMaxClaimGrowthBps(20_001)
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__GrowthCapTooHigh");
    });
  });
});
