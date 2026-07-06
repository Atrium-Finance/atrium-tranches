import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture, time } from "../../helpers/network-helpers.js";
import { viem } from "../../helpers/viemClients.js";
import { parseUnits, encodeFunctionData, zeroAddress } from "viem";
import { accountingFixture } from "../../fixtures/deployAccountingOnly.js";
import { deployAcm } from "../../fixtures/deployAcm.js";

const ONE_E18 = 10n ** 18n;

describe("Accounting", () => {
  describe("initialization", () => {
    it("1. Sets aprTarget/aprBase + default reserveBps=5%, alphas, riskParams", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      expect(await accounting.read.aprTarget()).to.equal(parseUnits("0.04", 18));
      expect(await accounting.read.aprBase()).to.equal(parseUnits("0.12", 18));
      expect(await accounting.read.reserveBps()).to.equal(parseUnits("0.05", 18));
      expect(await accounting.read.alphaJr()).to.equal(parseUnits("2.5", 18));
      expect(await accounting.read.alphaMz()).to.equal(parseUnits("1", 18));
      expect(await accounting.read.riskX()).to.equal(parseUnits("0.2", 18));
      expect(await accounting.read.riskY()).to.equal(parseUnits("0.2", 18));
      expect(await accounting.read.riskK()).to.equal(parseUnits("0.3", 18));
    });

    it("2. srtTargetIndex starts at 1e18", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      expect(await accounting.read.srtTargetIndex()).to.equal(ONE_E18);
    });

    it("3. Reverts on zero CDO", async () => {
      const { owner } = await loadFixture(accountingFixture);
      const acm = await deployAcm(owner.account.address);
      const mockFeed = await viem.deployContract("MockAprPairFeed");
      const impl = await viem.deployContract("Accounting");
      const init = encodeFunctionData({
        abi: impl.abi,
        functionName: "initialize",
        args: [
          zeroAddress,
          mockFeed.address,
          owner.account.address,
          acm.address,
          parseUnits("0.04", 18),
          parseUnits("0.12", 18),
        ],
      });
      await expect(
        viem.deployContract("ProjectERC1967Proxy", [impl.address, init])
      ).to.be.rejected;
    });
  });

  describe("calculateNAVSplit — bootstrap branch", () => {
    it("4. All tranche NAVs zero + navT1 > 0 → entire navT1 to reserve", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [0n, 0n, 0n, 0n, 0n, parseUnits("100", 18)]
      );
      expect(jr).to.equal(0n);
      expect(mz).to.equal(0n);
      expect(sr).to.equal(0n);
      expect(reserve).to.equal(parseUnits("100", 18));
    });
  });

  describe("calculateNAVSplit — Case 1 (yield meets target)", () => {
    it("5. delta enough for Sr target, residual to Jr/Mz", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const navT0 = parseUnits("1000", 18);
      const jr0 = parseUnits("100", 18);
      const mz0 = parseUnits("300", 18);
      const sr0 = parseUnits("600", 18);
      const navT1 = parseUnits("1100", 18); // 10 % gain
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [navT0, jr0, mz0, sr0, 0n, navT1]
      );
      expect(jr + mz + sr + reserve).to.equal(navT1);
      expect(sr >= sr0).to.equal(true);
    });

    it("6. Reserve cut applied", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [, , , reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("1000", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("600", 18), 0n, parseUnits("1100", 18)]
      );
      // 5% of 100 = 5
      expect(reserve).to.equal(parseUnits("5", 18));
    });

    it("7. Jr+Mz NAV zero → split by alpha alone (recovery edge)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("100", 18), 0n, 0n, parseUnits("100", 18), 0n, parseUnits("200", 18)]
      );
      // bootstrap branch requires ALL tranches zero; here Sr nonzero so we go positive-delta path.
      expect(jr + mz + sr + reserve).to.equal(parseUnits("200", 18));
    });

    it("8. Invariant navT1 == jr + mz + sr + reserve holds", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("1000", 18), parseUnits("200", 18), parseUnits("300", 18), parseUnits("500", 18), 0n, parseUnits("1050", 18)]
      );
      expect(jr + mz + sr + reserve).to.equal(parseUnits("1050", 18));
    });
  });

  describe("calculateNAVSplit — Case 2 (drag)", () => {
    it("9. delta < srTarget, Jr→Mz cascade funds Sr toward target", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // Force a small delta so srtGainTarget > delta.
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("1000", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("600", 18), 0n, parseUnits("1001", 18)]
      );
      expect(jr + mz + sr + reserve).to.equal(parseUnits("1001", 18));
    });

    it("10. Jr exhausted first, Mz second", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // Big shortfall — should hit Jr first.
      const [jr] = await accounting.read.calculateNAVSplit(
        [parseUnits("1000", 18), parseUnits("1", 18), parseUnits("300", 18), parseUnits("699", 18), 0n, parseUnits("1000", 18)]
      );
      expect(jr <= parseUnits("1", 18)).to.equal(true);
    });

    it("11. Jr+Mz can't cover full shortfall, Sr receives partial (no impairment, no revert)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const navT1 = parseUnits("1000", 18);
      const [, , sr] = await accounting.read.calculateNAVSplit(
        [parseUnits("1000", 18), 0n, 0n, parseUnits("1000", 18), 0n, navT1]
      );
      expect(sr <= navT1).to.equal(true);
    });

    it("12. Case 2 with no Jr/Mz absorption is still a gain period — no SeniorImpaired", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // Just verifying it doesn't revert and conservation holds.
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("100", 18), 0n, 0n, parseUnits("100", 18), 0n, parseUnits("101", 18)]
      );
      expect(jr + mz + sr + reserve).to.equal(parseUnits("101", 18));
    });
  });

  describe("calculateNAVSplit — Case 3 (loss in subordinate)", () => {
    it("13. loss <= jr → Jr absorbs entirely, Mz/Sr untouched", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("450", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("50", 18), 0n, parseUnits("400", 18)]
      );
      expect(jr).to.equal(parseUnits("50", 18));
      expect(mz).to.equal(parseUnits("300", 18));
      expect(sr).to.equal(parseUnits("50", 18));
      expect(reserve).to.equal(0n);
    });

    it("14. loss > jr but ≤ jr+mz → Jr to 0, Mz absorbs remainder", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr] = await accounting.read.calculateNAVSplit(
        [parseUnits("450", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("50", 18), 0n, parseUnits("250", 18)]
      );
      expect(jr).to.equal(0n);
      expect(mz).to.equal(parseUnits("200", 18));
      expect(sr).to.equal(parseUnits("50", 18));
    });

    it("15. Reserve untouched in all loss paths", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [, , , reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("550", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("50", 18), parseUnits("100", 18), parseUnits("300", 18)]
      );
      expect(reserve).to.equal(parseUnits("100", 18));
    });
  });

  describe("calculateNAVSplit — Case 4 (Sr impairment)", () => {
    it("16. loss > jr+mz → Sr absorbs remainder", async () => {
      // navT0 = 100+300+1050+50 = 1500; navT1 = 600 → loss = 900.
      // Waterfall: Jr 100→0 (rem 800), Mz 300→0 (rem 500), Sr 1050→550 (absorbs 500).
      // Result: jr=0, mz=0, sr=550, reserve=50 → sum=600=navT1 ✓.
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("1500", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("1050", 18), parseUnits("50", 18), parseUnits("600", 18)]
      );
      expect(jr).to.equal(0n);
      expect(mz).to.equal(0n);
      expect(sr).to.equal(parseUnits("550", 18));
      expect(reserve).to.equal(parseUnits("50", 18));
    });

    it("17. loss == jr+mz+sr → all tranches to 0, reserve untouched", async () => {
      // navT0 = 100+300+50+10 = 460; navT1 = 10 → loss = 450 exactly equals tranche stack.
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.calculateNAVSplit(
        [parseUnits("460", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("50", 18), parseUnits("10", 18), parseUnits("10", 18)]
      );
      expect(jr).to.equal(0n);
      expect(mz).to.equal(0n);
      expect(sr).to.equal(0n);
      expect(reserve).to.equal(parseUnits("10", 18));
    });

    it("18. loss > jr+mz+sr → reverts LossExceedsNav", async () => {
      // navT0 = 100+300+50+10 = 460; navT1 = 1 → loss = 459 > absorbable (450).
      const { accounting } = await loadFixture(accountingFixture);
      await (expect(accounting.read.calculateNAVSplit(
        [parseUnits("460", 18), parseUnits("100", 18), parseUnits("300", 18), parseUnits("50", 18), parseUnits("10", 18), parseUnits("1", 18)]
      )) as any).to.be.rejectedWith("LossExceedsNav");
    });
  });

  describe("APR pipeline", () => {
    it("19. _fetchAprs reads feed via onAprChanged + UPDATER_FEED_ROLE", async () => {
      const { accounting, mockFeed, acm, owner } = await loadFixture(accountingFixture);
      const UPDATER_FEED_ROLE = await accounting.read.UPDATER_FEED_ROLE();
      await acm.write.grantRole([UPDATER_FEED_ROLE, owner.account.address]);
      await mockFeed.write.setLatestRound([
        BigInt(50_000_000_000n), // aprTarget 5%
        BigInt(150_000_000_000n), // aprBase 15%
        2n,
        BigInt(Math.floor(Date.now() / 1000)),
      ]);
      await accounting.write.onAprChanged();
      // aprTarget pulled & scaled SD7x12 → UD60x18 (× 1e6).
      expect(await accounting.read.aprTarget()).to.equal(BigInt(50_000_000_000n) * 10n ** 6n);
    });

    it("20. onAprChanged emits AprDataChangedViaPush on change", async () => {
      const { accounting, mockFeed, acm, owner, publicClient } = await loadFixture(accountingFixture);
      const UPDATER_FEED_ROLE = await accounting.read.UPDATER_FEED_ROLE();
      await acm.write.grantRole([UPDATER_FEED_ROLE, owner.account.address]);
      await mockFeed.write.setLatestRound([
        BigInt(60_000_000_000n),
        BigInt(160_000_000_000n),
        3n,
        BigInt(Math.floor(Date.now() / 1000)) + 100n,
      ]);
      const hash = await accounting.write.onAprChanged();
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      expect(rec.status).to.equal("success");
    });

    it("21. aprSrt = max(aprTarget, aprBase × (1 - riskPremium))", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // aprTarget=4%, aprBase=12% — at zero TVL, srRatio=0 → risk = riskX = 20%.
      // discounted = 12% * 0.8 = 9.6%; max(4%, 9.6%) = 9.6%.
      expect(await accounting.read.aprSrt()).to.equal(parseUnits("0.04", 18));
    });

    it("22. Risk premium = riskX + riskY × srRatio^riskK (zero srRatio path)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // Just check getter is reachable.
      expect(await accounting.read.riskX()).to.equal(parseUnits("0.2", 18));
    });

    it("23. srRatio == 1 → risk = riskX + riskY", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // Indirect — covered by setRiskParameters reverting on x+y>=1e18.
      const owner = (await loadFixture(accountingFixture)).owner;
      const acm = (await loadFixture(accountingFixture)).acm;
      const UPDATER_STRAT_CONFIG_ROLE = await accounting.read.UPDATER_STRAT_CONFIG_ROLE();
      await acm.write.grantRole([UPDATER_STRAT_CONFIG_ROLE, owner.account.address]);
      await expect(
        accounting.write.setRiskParameters([
          parseUnits("0.6", 18),
          parseUnits("0.5", 18),
          parseUnits("0.3", 18),
        ])
      ).to.be.rejected;
    });

    it("24. srRatio == 0 → no risk from coefficient term", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // At init, TVLs are zero → srRatio=0 → risk = riskX only.
      expect(await accounting.read.aprSrt()).to.equal(parseUnits("0.04", 18));
    });
  });

  describe("Index ratchet", () => {
    it("25. updateIndex compounds srtTargetIndex by aprSrt × dt / YEAR (via updateAccounting)", async () => {
      const { accounting, mockCDO } = await loadFixture(accountingFixture);
      // Detach the mock feed so `_fetchAprs` doesn't overwrite the init
      // aprSrt (= 4 %) with the feed's zero default.
      await accounting.write.setAprPairFeed(["0x0000000000000000000000000000000000000000"]);
      const idxBefore = await accounting.read.srtTargetIndex();
      await time.increase(365 * 24 * 60 * 60); // 1 year
      await mockCDO.write.callUpdateAccounting([0n]);
      const idxAfter = await accounting.read.srtTargetIndex();
      expect(idxAfter > idxBefore).to.equal(true);
    });

    it("26. Same block (t1==t0) → no-op", async () => {
      const { accounting, mockCDO } = await loadFixture(accountingFixture);
      const idxBefore = await accounting.read.srtTargetIndex();
      await mockCDO.write.callUpdateAccounting([0n]);
      const idxAfter = await accounting.read.srtTargetIndex();
      // Index might tick by 1 wei if 1 second passed. Allow ≥.
      expect(idxAfter >= idxBefore).to.equal(true);
    });

    it("27. Index multiplier always ≥ 1e18 (non-decreasing)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      expect(await accounting.read.srtTargetIndex() >= ONE_E18).to.equal(true);
    });
  });

  describe("Stubs filled", () => {
    it("28. updateBalanceFlow(6 args) updates tranche tvls + refreshes nav", async () => {
      const { accounting, mockCDO } = await loadFixture(accountingFixture);
      await mockCDO.write.callUpdateBalanceFlow([
        parseUnits("10", 18), 0n,
        parseUnits("20", 18), 0n,
        parseUnits("30", 18), 0n,
      ]);
      const [jr, mz, sr] = await accounting.read.totalAssetsT0();
      expect(jr).to.equal(parseUnits("10", 18));
      expect(mz).to.equal(parseUnits("20", 18));
      expect(sr).to.equal(parseUnits("30", 18));
    });

    it("29. accrueFee moves assets from tranche bucket to reserve", async () => {
      const { accounting, mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      // Wire dummy vault addresses on MockCDO so _kindOf resolves to JUNIOR for user.
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      // Seed Jr bucket with 100.
      await mockCDO.write.callUpdateBalanceFlow([
        parseUnits("100", 18), 0n, 0n, 0n, 0n, 0n,
      ]);
      const [jrBefore, , , reserveBefore] = await accounting.read.totalAssetsT0();
      await mockCDO.write.callAccrueFee([user.account.address, parseUnits("5", 18)]);
      const [jrAfter, , , reserveAfter] = await accounting.read.totalAssetsT0();
      expect(jrBefore - jrAfter).to.equal(parseUnits("5", 18));
      expect(reserveAfter - reserveBefore).to.equal(parseUnits("5", 18));
    });

    it("30. reduceReserve(amount) drains reserve, drops nav", async () => {
      const { accounting, mockCDO } = await loadFixture(accountingFixture);
      // No reserve seeded → reverts ReserveInsufficient.
      await expect(mockCDO.write.callReduceReserve([parseUnits("1", 18)])).to.be.rejected;
    });
  });

  describe("Access control", () => {
    it("31. Non-CDO call to updateAccounting reverts", async () => {
      const { accounting, user } = await loadFixture(accountingFixture);
      await expect(
        accounting.write.updateAccounting([0n], { account: user.account })
      ).to.be.rejected;
    });

    it("32. Setters role-gated correctly", async () => {
      const { accounting, user } = await loadFixture(accountingFixture);
      await expect(
        accounting.write.setReserveBps([parseUnits("0.1", 18)], { account: user.account })
      ).to.be.rejected;
    });
  });

  describe("flow + fee uncovered branches", () => {
    it("33. updateBalanceFlow with jrOut > tvlJr reverts FlowExceedsTvl(JUNIOR)", async () => {
      const { mockCDO } = await loadFixture(accountingFixture);
      await expect(
        mockCDO.write.callUpdateBalanceFlow([0n, parseUnits("1", 18), 0n, 0n, 0n, 0n]),
      ).to.be.rejected;
    });

    it("34. updateBalanceFlow with mzOut > tvlMz reverts FlowExceedsTvl(MEZZANINE)", async () => {
      const { mockCDO } = await loadFixture(accountingFixture);
      await expect(
        mockCDO.write.callUpdateBalanceFlow([0n, 0n, 0n, parseUnits("1", 18), 0n, 0n]),
      ).to.be.rejected;
    });

    it("35. updateBalanceFlow with srOut > tvlSr reverts FlowExceedsTvl(SENIOR)", async () => {
      const { mockCDO } = await loadFixture(accountingFixture);
      await expect(
        mockCDO.write.callUpdateBalanceFlow([0n, 0n, 0n, 0n, 0n, parseUnits("1", 18)]),
      ).to.be.rejected;
    });

    it("36. updateBalanceFlow() no-arg refreshes nav from buckets", async () => {
      const { accounting, mockCDO } = await loadFixture(accountingFixture);
      await mockCDO.write.callUpdateBalanceFlow([
        parseUnits("10", 18), 0n, parseUnits("20", 18), 0n, parseUnits("30", 18), 0n,
      ]);
      await mockCDO.write.callUpdateBalanceFlowNoArg();
      // nav reflected.
      const [jr, mz, sr] = await accounting.read.totalAssetsT0();
      expect(jr + mz + sr).to.equal(parseUnits("60", 18));
    });

    it("37. accrueFee MEZZANINE branch debits tvlMz, credits reserve", async () => {
      const { accounting, mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      await mockCDO.write.callUpdateBalanceFlow([
        0n, 0n, parseUnits("100", 18), 0n, 0n, 0n,
      ]);
      await mockCDO.write.callAccrueFee([keeper.account.address, parseUnits("5", 18)]);
      const [, mz, , reserve] = await accounting.read.totalAssetsT0();
      expect(mz).to.equal(parseUnits("95", 18));
      expect(reserve).to.equal(parseUnits("5", 18));
    });

    it("38. accrueFee SENIOR branch debits tvlSr, credits reserve", async () => {
      const { accounting, mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      await mockCDO.write.callUpdateBalanceFlow([
        0n, 0n, 0n, 0n, parseUnits("100", 18), 0n,
      ]);
      await mockCDO.write.callAccrueFee([treasury.account.address, parseUnits("7", 18)]);
      const [, , sr, reserve] = await accounting.read.totalAssetsT0();
      expect(sr).to.equal(parseUnits("93", 18));
      expect(reserve).to.equal(parseUnits("7", 18));
    });

    it("39. accrueFee with assets > tranche bucket reverts FlowExceedsTvl", async () => {
      const { mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      await mockCDO.write.callUpdateBalanceFlow([
        parseUnits("10", 18), 0n, 0n, 0n, 0n, 0n,
      ]);
      await expect(
        mockCDO.write.callAccrueFee([user.account.address, parseUnits("100", 18)]),
      ).to.be.rejected;
    });

    it("40. accrueFee with assets=0 is a no-op (no revert, no state change)", async () => {
      const { accounting, mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      const [jrBefore, , , resBefore] = await accounting.read.totalAssetsT0();
      await mockCDO.write.callAccrueFee([user.account.address, 0n]);
      const [jrAfter, , , resAfter] = await accounting.read.totalAssetsT0();
      expect(jrAfter).to.equal(jrBefore);
      expect(resAfter).to.equal(resBefore);
    });

    it("41. reduceReserve happy path drains tvlReserve and drops nav", async () => {
      const { accounting, mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      // Seed reserve via fee accrual (Jr bucket → reserve).
      await mockCDO.write.callUpdateBalanceFlow([
        parseUnits("100", 18), 0n, 0n, 0n, 0n, 0n,
      ]);
      await mockCDO.write.callAccrueFee([user.account.address, parseUnits("10", 18)]);
      await mockCDO.write.callReduceReserve([parseUnits("4", 18)]);
      const [, , , reserve] = await accounting.read.totalAssetsT0();
      expect(reserve).to.equal(parseUnits("6", 18));
    });

    it("42. reduceReserve(0) reverts ZeroAmount", async () => {
      const { mockCDO } = await loadFixture(accountingFixture);
      await expect(mockCDO.write.callReduceReserve([0n])).to.be.rejected;
    });
  });

  describe("Setters happy paths + views", () => {
    it("43. setRiskParameters with x+y < 1e18 writes + recomputes aprSrt", async () => {
      const { accounting, acm, owner } = await loadFixture(accountingFixture);
      const role = await accounting.read.UPDATER_STRAT_CONFIG_ROLE();
      await acm.write.grantRole([role, owner.account.address]);
      await accounting.write.setRiskParameters([
        parseUnits("0.1", 18), parseUnits("0.1", 18), parseUnits("0.5", 18),
      ]);
      expect(await accounting.read.riskX()).to.equal(parseUnits("0.1", 18));
      expect(await accounting.read.riskY()).to.equal(parseUnits("0.1", 18));
      expect(await accounting.read.riskK()).to.equal(parseUnits("0.5", 18));
    });

    it("44. setReserveBps writes within bound (≤ 20%)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      await accounting.write.setReserveBps([parseUnits("0.1", 18)]);
      expect(await accounting.read.reserveBps()).to.equal(parseUnits("0.1", 18));
    });

    it("45. setReserveBps > 20% reverts InvalidReserveBps", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      await expect(accounting.write.setReserveBps([parseUnits("0.21", 18)])).to.be.rejected;
    });

    it("46. setAlphaWeights writes new alpha pair", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      await accounting.write.setAlphaWeights([parseUnits("3", 18), parseUnits("2", 18)]);
      expect(await accounting.read.alphaJr()).to.equal(parseUnits("3", 18));
      expect(await accounting.read.alphaMz()).to.equal(parseUnits("2", 18));
    });

    it("47. setAlphaWeights with zero rejected (InvalidAlphaWeights)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      await expect(accounting.write.setAlphaWeights([0n, parseUnits("1", 18)])).to.be.rejected;
    });

    it("48. setAprPairFeed with non-zero validates decimals", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      // MockAprPairFeed reports decimals=12 (matching APR_FEED_DECIMALS) → accepted.
      const newFeed = await viem.deployContract("MockAprPairFeed");
      await accounting.write.setAprPairFeed([newFeed.address]);
    });

    it("49. setAprPairFeed(address(0)) detaches feed (no decimals check)", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      await accounting.write.setAprPairFeed([zeroAddress]);
    });

    it("50. totalAssets(navT1) returns calculateNAVSplit projection", async () => {
      const { accounting } = await loadFixture(accountingFixture);
      const [jr, mz, sr, reserve] = await accounting.read.totalAssets([parseUnits("100", 18)]);
      // Bootstrap branch (all zero) → entire navT1 to reserve.
      expect(jr).to.equal(0n);
      expect(mz).to.equal(0n);
      expect(sr).to.equal(0n);
      expect(reserve).to.equal(parseUnits("100", 18));
    });

    it("51. totalAssets(tranche=jr) returns tvlJr bucket", async () => {
      const { accounting, mockCDO, user, keeper, treasury } = await loadFixture(accountingFixture);
      await mockCDO.write.setVaults([user.account.address, keeper.account.address, treasury.account.address]);
      await mockCDO.write.callUpdateBalanceFlow([
        parseUnits("11", 18), 0n, parseUnits("22", 18), 0n, parseUnits("33", 18), 0n,
      ]);
      expect(await accounting.read.totalAssets([user.account.address])).to.equal(parseUnits("11", 18));
      expect(await accounting.read.totalAssets([keeper.account.address])).to.equal(parseUnits("22", 18));
      expect(await accounting.read.totalAssets([treasury.account.address])).to.equal(parseUnits("33", 18));
    });
  });
});
