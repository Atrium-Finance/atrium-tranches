import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture, time } from "../../helpers/network-helpers.js";
import { encodeFunctionData, getAddress } from "viem";
import { deployAcm } from "../../fixtures/deployAcm.js";
import { getClients, viem } from "../../helpers/viemClients.js";

async function feedFixture() {
  const { owner, user, keeper, publicClient, rest } = await getClients();
  const acm = await deployAcm(owner.account.address);

  const provider = await viem.deployContract("MockSharesAprProvider");
  await provider.write.setApr([10n * 10n ** 9n, 5n * 10n ** 9n, BigInt(Math.floor(Date.now() / 1000))]);

  const impl = await viem.deployContract("AprPairFeed");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address, provider.address, 3600n, "USDA APR"],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const feed = await viem.getContractAt("AprPairFeed", proxy.address);

  const role = await feed.read.UPDATER_FEED_ROLE();
  await acm.write.grantRole([role, owner.account.address]);
  await acm.write.grantRole([role, keeper.account.address]);

  return { feed, provider, acm, owner, user, keeper, publicClient, rest };
}

describe("AprPairFeed", () => {
  describe("PUSH path", () => {
    it("1. updateRoundData(...) stores round + emits AnswerUpdated", async () => {
      const { feed, publicClient } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(t));
      const hash = await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      expect(rec.status).to.equal("success");
    });

    it("2. Reverts on stale timestamp", async () => {
      const { feed } = await loadFixture(feedFixture);
      await time.increase(7200);
      // First push to bump latestRound (and ensure subsequent stale checks fire).
      const now = BigInt(await time.latest());
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, now + 10n]);
      // Now push with old timestamp.
      await expect(
        feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, 1n])
      ).to.be.rejected;
    });

    it("3. Reverts on future timestamp beyond MAX_FUTURE_DRIFT", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 1000n;
      await expect(
        feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t])
      ).to.be.rejected;
    });

    it("4. Reverts on out-of-order timestamp", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      await expect(
        feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t])
      ).to.be.rejected;
    });

    it("5. Reverts on APR outside [-50%, +200%]", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await expect(
        feed.write.updateRoundData([3n * 10n ** 12n, 0n, t])
      ).to.be.rejected;
    });

    it("6. Sets sourcePref = Feed after PUSH", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      expect(await feed.read.sourcePref()).to.equal(0); // Feed = 0
    });
  });

  describe("PULL path", () => {
    it("7. updateRoundData() reads provider.getApr(), stores round", async () => {
      const { feed, provider } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 100n;
      await provider.write.setApr([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData();
    });

    it("8. Sets sourcePref = Strategy after PULL", async () => {
      const { feed, provider } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 100n;
      await provider.write.setApr([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData();
      expect(await feed.read.sourcePref()).to.equal(1); // Strategy = 1
    });
  });

  describe("latestRoundData — fresh PUSH", () => {
    it("9. Returns stored round when dt < roundStaleAfter", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      const round = await feed.read.latestRoundData();
      expect(round.aprBase).to.equal(10n * 10n ** 10n);
    });

    it("10. Future-dated round returned without underflow", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 30n;
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      const round = await feed.read.latestRoundData();
      expect(round.updatedAt).to.equal(t);
    });
  });

  describe("latestRoundData — stale fallback to PULL", () => {
    it("11. PUSH stale → falls back to provider.getApr()", async () => {
      const { feed, provider } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      await time.increase(7200); // > roundStaleAfter
      await provider.write.setApr([11n * 10n ** 10n, 6n * 10n ** 10n, BigInt(await time.latest())]);
      const round = await feed.read.latestRoundData();
      expect(round.aprBase).to.equal(11n * 10n ** 10n);
    });

    it("12. PUSH never pushed (updatedAt=0) → falls back to PULL", async () => {
      const { feed, provider } = await loadFixture(feedFixture);
      await provider.write.setApr([7n * 10n ** 10n, 4n * 10n ** 10n, BigInt(await time.latest())]);
      const round = await feed.read.latestRoundData();
      expect(round.aprBase).to.equal(7n * 10n ** 10n);
    });

    it("13. Provider returns 0 base → ok, returned as-is", async () => {
      const { feed, provider } = await loadFixture(feedFixture);
      await provider.write.setApr([0n, 0n, BigInt(await time.latest())]);
      const round = await feed.read.latestRoundData();
      expect(round.aprBase).to.equal(0n);
    });
  });

  describe("Ring buffer", () => {
    it("14. Stores rounds, wraps after rolling", async () => {
      const { feed } = await loadFixture(feedFixture);
      for (let i = 0; i < 5; i++) {
        const t = BigInt(await time.latest()) + BigInt(i * 10 + 10);
        await time.setNextBlockTimestamp(Number(t));
        await feed.write.updateRoundData([(10n + BigInt(i)) * 10n ** 10n, 5n * 10n ** 10n, t]);
      }
      expect(await feed.read.latestRoundId()).to.equal(5n);
    });

    it("15. getRoundData by id returns correct round", async () => {
      const { feed } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(t));
      await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      const r = await feed.read.getRoundData([1n]);
      expect(r.aprBase).to.equal(10n * 10n ** 10n);
    });

    it("16. getRoundData on overwritten id → reverts OldRound", async () => {
      const { feed } = await loadFixture(feedFixture);
      // Write 21 rounds — ring of 20.
      for (let i = 0; i < 21; i++) {
        const t = BigInt(await time.latest()) + BigInt(i * 2 + 1);
        await time.setNextBlockTimestamp(Number(t));
        await feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t]);
      }
      await expect(feed.read.getRoundData([1n])).to.be.rejected;
    });

    it("17. getRoundData on never-written id → reverts NoDataPresent", async () => {
      const { feed } = await loadFixture(feedFixture);
      await expect(feed.read.getRoundData([19n])).to.be.rejected;
    });
  });

  describe("admin", () => {
    it("18. setProvider validates new provider's getApr returns valid APRs", async () => {
      const { feed, provider } = await loadFixture(feedFixture);
      await feed.write.setProvider([provider.address]);
    });

    it("19. setRoundStaleAfter owner-only", async () => {
      const { feed, user } = await loadFixture(feedFixture);
      await expect(
        feed.write.setRoundStaleAfter([100n], { account: user.account })
      ).to.be.rejected;
      await feed.write.setRoundStaleAfter([100n]);
      expect(await feed.read.roundStaleAfter()).to.equal(100n);
    });

    it("20. Role gating UPDATER_FEED_ROLE on updateRoundData", async () => {
      const { feed, user } = await loadFixture(feedFixture);
      const t = BigInt(await time.latest()) + 10n;
      await expect(
        feed.write.updateRoundData([10n * 10n ** 10n, 5n * 10n ** 10n, t], { account: user.account })
      ).to.be.rejected;
    });
  });
});
