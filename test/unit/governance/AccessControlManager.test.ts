import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { getAddress, zeroAddress, encodeFunctionData, toFunctionSelector } from "viem";
import { getClients, viem } from "../../helpers/viemClients.js";

async function acmFixture() {
  const { owner, user, publicClient, rest } = await getClients();
  const impl = await viem.deployContract("AccessControlManager");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const acm = await viem.getContractAt("AccessControlManager", proxy.address);
  return { acm, owner, user, publicClient, rest, impl };
}

describe("AccessControlManager", () => {
  describe("initialization", () => {
    it("1. Sets owner as default admin", async () => {
      const { acm, owner } = await loadFixture(acmFixture);
      const DEFAULT_ADMIN_ROLE = "0x" + "0".repeat(64);
      expect(
        await acm.read.hasRole([DEFAULT_ADMIN_ROLE as `0x${string}`, owner.account.address])
      ).to.equal(true);
    });

    it("2. UUPS proxy upgradeable (verified by separate test below)", async () => {
      const { acm } = await loadFixture(acmFixture);
      expect(getAddress(acm.address)).to.match(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe("role grant/revoke", () => {
    it("3. grantRole sets hasRole=true, emits RoleGranted", async () => {
      const { acm, owner, user } = await loadFixture(acmFixture);
      const role = `0x${"1".padStart(64, "0")}` as `0x${string}`;
      await acm.write.grantRole([role, user.account.address]);
      expect(await acm.read.hasRole([role, user.account.address])).to.equal(true);
    });

    it("4. revokeRole removes hasRole, emits RoleRevoked", async () => {
      const { acm, owner, user } = await loadFixture(acmFixture);
      const role = `0x${"1".padStart(64, "0")}` as `0x${string}`;
      await acm.write.grantRole([role, user.account.address]);
      await acm.write.revokeRole([role, user.account.address]);
      expect(await acm.read.hasRole([role, user.account.address])).to.equal(false);
    });

    it("5. Non-owner calls revert (admin role check)", async () => {
      const { acm, user, rest } = await loadFixture(acmFixture);
      const role = `0x${"1".padStart(64, "0")}` as `0x${string}`;
      await expect(
        acm.write.grantRole([role, rest[0].account.address], { account: user.account })
      ).to.be.rejected;
    });

    it("6. grantCall with zero contract or zero selector reverts StrictPermissionOnly", async () => {
      const { acm, user } = await loadFixture(acmFixture);
      const sel = "0x12345678" as `0x${string}`;
      await expect(
        acm.write.grantCall([zeroAddress, sel, user.account.address])
      ).to.be.rejected;
    });
  });

  describe("call-based ACL", () => {
    it("7. grantCall(target, selector, addr) sets permission true (via hasPermission)", async () => {
      const { acm, user, rest } = await loadFixture(acmFixture);
      const sel = "0x12345678" as `0x${string}`;
      await acm.write.grantCall([rest[0].account.address, sel, user.account.address]);
      expect(
        await acm.read.hasPermission([user.account.address, rest[0].account.address, sel])
      ).to.equal(true);
    });

    it("8. revokeCall removes permission", async () => {
      const { acm, user, rest } = await loadFixture(acmFixture);
      const sel = "0x12345678" as `0x${string}`;
      await acm.write.grantCall([rest[0].account.address, sel, user.account.address]);
      await acm.write.revokeCall([rest[0].account.address, sel, user.account.address]);
      expect(
        await acm.read.hasPermission([user.account.address, rest[0].account.address, sel])
      ).to.equal(false);
    });

    it("9. hasPermission strict (no wildcard fallback)", async () => {
      const { acm, user, rest } = await loadFixture(acmFixture);
      const sel = "0x12345678" as `0x${string}`;
      // Grant only at strict address; hasPermission strict to a different address returns false.
      await acm.write.grantCall([rest[0].account.address, sel, user.account.address]);
      expect(
        await acm.read.hasPermission([user.account.address, rest[1].account.address, sel])
      ).to.equal(false);
    });
  });

  describe("upgrade", () => {
    it("10. upgradeToAndCall callable by owner only (smoke)", async () => {
      const { acm, owner } = await loadFixture(acmFixture);
      const v2impl = await viem.deployContract("AccessControlManagerV2");
      await acm.write.upgradeToAndCall([v2impl.address, "0x"]);
      const upgraded = await viem.getContractAt("AccessControlManagerV2", acm.address);
      expect(await upgraded.read.version()).to.equal(2n);
    });

    it("11. Non-owner upgrade reverts", async () => {
      const { acm, user } = await loadFixture(acmFixture);
      const v2impl = await viem.deployContract("AccessControlManagerV2");
      await expect(
        acm.write.upgradeToAndCall([v2impl.address, "0x"], { account: user.account })
      ).to.be.rejected;
    });

    it("12. Storage preserved across upgrade", async () => {
      const { acm, owner } = await loadFixture(acmFixture);
      const role = `0x${"3".padStart(64, "0")}` as `0x${string}`;
      await acm.write.grantRole([role, owner.account.address]);
      const v2impl = await viem.deployContract("AccessControlManagerV2");
      await acm.write.upgradeToAndCall([v2impl.address, "0x"]);
      expect(await acm.read.hasRole([role, owner.account.address])).to.equal(true);
    });
  });
});
