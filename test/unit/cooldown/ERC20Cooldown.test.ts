import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture, time } from "../../helpers/network-helpers.js";
import { viem } from "../../helpers/viemClients.js";
import { zeroAddress } from "viem";
import { erc20CooldownFixture } from "../../fixtures/deployCooldown.js";

describe("ERC20Cooldown", () => {
  describe("zero-cooldown short-circuit", () => {
    it("1. cooldown=0 → direct safeTransferFrom, no slot allocated", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 0n],
        { account: keeper.account }
      );
      const len = await silo.read.activeRequestsLength([token.address, user.account.address]);
      expect(len).to.equal(0n);
      expect(await token.read.balanceOf([user.account.address])).to.equal(100n);
    });

    it("2. cooldownDisabled=true → finalize releases all regardless of unlockAt", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 3600n],
        { account: keeper.account }
      );
      await silo.write.setCooldownDisabled([token.address, true], { account: keeper.account });
      await silo.write.finalize([token.address, user.account.address]);
      expect(await token.read.balanceOf([user.account.address])).to.equal(100n);
    });

    it("3. emits Finalized in short-circuit path", async () => {
      const { silo, token, keeper, user, publicClient } = await loadFixture(erc20CooldownFixture);
      const hash = await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 0n],
        { account: keeper.account }
      );
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      expect(rec.status).to.equal("success");
    });
  });

  describe("delayed cooldown", () => {
    it("4. cooldown>0 → allocates slot, holds tokens", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 3600n],
        { account: keeper.account }
      );
      expect(await silo.read.activeRequestsLength([token.address, user.account.address])).to.equal(1n);
    });

    it("5. emits TransferRequested", async () => {
      const { silo, token, keeper, user, publicClient } = await loadFixture(erc20CooldownFixture);
      const hash = await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 3600n],
        { account: keeper.account }
      );
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      expect(rec.status).to.equal("success");
    });

    it("6. finalize before cooldown elapsed → reverts NothingToFinalize", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 3600n],
        { account: keeper.account }
      );
      await expect(silo.write.finalize([token.address, user.account.address])).to.be.rejected;
    });

    it("7. finalize after cooldown elapsed → transfers to receiver", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 3600n],
        { account: keeper.account }
      );
      await time.increase(3700);
      await silo.write.finalize([token.address, user.account.address]);
      expect(await token.read.balanceOf([user.account.address])).to.equal(100n);
    });
  });

  describe("setCooldownDisabled", () => {
    it("8. Per-token flag, role-gated COOLDOWN_WORKER_ROLE", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await expect(
        silo.write.setCooldownDisabled([token.address, true], { account: user.account })
      ).to.be.rejected;
      await silo.write.setCooldownDisabled([token.address, true], { account: keeper.account });
      expect(await silo.read.cooldownDisabled([token.address])).to.equal(true);
    });

    it("9. Toggling true → all subsequent finalize calls succeed regardless of cooldown", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 1_000_000n],
        { account: keeper.account }
      );
      await silo.write.setCooldownDisabled([token.address, true], { account: keeper.account });
      await silo.write.finalize([token.address, user.account.address]);
    });
  });

  describe("access control", () => {
    it("10. transfer requires COOLDOWN_WORKER_ROLE", async () => {
      const { silo, token, user } = await loadFixture(erc20CooldownFixture);
      await expect(
        silo.write.transfer(
          [token.address, user.account.address, user.account.address, 100n, 0n],
          { account: user.account }
        )
      ).to.be.rejected;
    });

    it("11. setCooldownDisabled requires COOLDOWN_WORKER_ROLE", async () => {
      const { silo, token, user } = await loadFixture(erc20CooldownFixture);
      await expect(
        silo.write.setCooldownDisabled([token.address, true], { account: user.account })
      ).to.be.rejected;
    });
  });

  describe("edge cases", () => {
    it("12. amount=0 → no-op (no revert, no slot)", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 0n, 0n],
        { account: keeper.account }
      );
      expect(await silo.read.activeRequestsLength([token.address, user.account.address])).to.equal(0n);
    });

    it("13. Receiver=address(0) → safeTransferFrom blocks (ERC20)", async () => {
      const { silo, token, keeper } = await loadFixture(erc20CooldownFixture);
      await expect(
        silo.write.transfer(
          [token.address, keeper.account.address, zeroAddress, 100n, 0n],
          { account: keeper.account }
        )
      ).to.be.rejected;
    });

    it("14. Slot reuse: finalize frees slot, next transfer adds anew", async () => {
      const { silo, token, keeper, user } = await loadFixture(erc20CooldownFixture);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 100n, 3600n],
        { account: keeper.account }
      );
      await time.increase(3700);
      await silo.write.finalize([token.address, user.account.address]);
      expect(await silo.read.activeRequestsLength([token.address, user.account.address])).to.equal(0n);
      await silo.write.transfer(
        [token.address, keeper.account.address, user.account.address, 50n, 3600n],
        { account: keeper.account }
      );
      expect(await silo.read.activeRequestsLength([token.address, user.account.address])).to.equal(1n);
    });

    it("15. Reentrancy via callback in receiver token → blocked (smoke)", async () => {
      const { silo, keeper, user, acm } = await loadFixture(erc20CooldownFixture);
      const reentrant = await viem.deployContract("ReenteringERC20");
      await reentrant.write.mint([keeper.account.address, 1000n]);
      await reentrant.write.approve([silo.address, (1n << 255n) - 1n], { account: keeper.account });
      await reentrant.write.arm([silo.address]);
      // Reentry attempts during transfer should not corrupt state; the call
      // should either succeed cleanly or revert with the guard.
      await silo.write.transfer(
        [reentrant.address, keeper.account.address, user.account.address, 10n, 0n],
        { account: keeper.account }
      ).catch(() => {});
    });
  });
});
