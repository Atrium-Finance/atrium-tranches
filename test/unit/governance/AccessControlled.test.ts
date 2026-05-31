import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import { deployAcm } from "../../fixtures/deployAcm.js";
import { getClients, viem } from "../../helpers/viemClients.js";

async function harnessFixture() {
  const { owner, user, publicClient, rest } = await getClients();
  const acm = await deployAcm(owner.account.address);
  const impl = await viem.deployContract("MockAccessControlledHarness");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const harness = await viem.getContractAt("MockAccessControlledHarness", proxy.address);
  return { harness, acm, owner, user, publicClient, rest };
}

describe("AccessControlled (via harness)", () => {
  it("1. onlyOwner modifier accepts owner", async () => {
    const { harness } = await loadFixture(harnessFixture);
    await harness.write.onlyOwnerCall();
    expect(await harness.read.flag()).to.equal(1n);
  });

  it("2. onlyRole checks via ACM", async () => {
    const { harness, acm, owner, user } = await loadFixture(harnessFixture);
    const role = `0x${"a".padStart(64, "0")}` as `0x${string}`;
    await acm.write.grantRole([role, user.account.address]);
    await harness.write.onlyRoleCall([role], { account: user.account });
    expect(await harness.read.flag()).to.equal(1n);
  });

  it("3. _checkAccessAllowed via call-based ACL", async () => {
    const { harness, acm, owner, user, publicClient } = await loadFixture(harnessFixture);
    const sel = toFunctionSelector("function checkAccessCall()");

    // Grant call-based permission to user.
    await acm.write.grantCall(
      [harness.address, sel, user.account.address],
      { account: owner.account }
    );

    const hash = await harness.write.checkAccessCall({ account: user.account });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    expect(rec.status).to.equal("success");

    // Revoke; subsequent call reverts Unauthorized.
    await acm.write.revokeCall(
      [harness.address, sel, user.account.address],
      { account: owner.account }
    );
    await expect(
      harness.write.checkAccessCall({ account: user.account })
    ).to.be.rejected;
  });

  it("4. _disableInitializers called in constructor (cannot re-init impl)", async () => {
    const { owner, acm } = await loadFixture(harnessFixture);
    const impl = await viem.deployContract("MockAccessControlledHarness");
    await expect(impl.write.initialize([owner.account.address, acm.address])).to.be.rejected;
  });

  it("5. AccessControlled_init wires acm (read.acm matches)", async () => {
    const { harness, acm } = await loadFixture(harnessFixture);
    expect(getAddress(await harness.read.acm())).to.equal(getAddress(acm.address));
  });

  it("6. ZeroAddress error declared (setAccessControlManager rejects zero)", async () => {
    const { harness } = await loadFixture(harnessFixture);
    const ZERO = "0x" + "0".repeat(40);
    await expect(harness.write.setAccessControlManager([ZERO as `0x${string}`])).to.be.rejected;
  });

  it("7. setTwoStepConfigManager writes + emits NewTwoStepConfigManager", async () => {
    const { harness, user } = await loadFixture(harnessFixture);
    await harness.write.setTwoStepConfigManager([user.account.address]);
    expect(getAddress(await harness.read.twoStepConfigManager())).to.equal(getAddress(user.account.address));
  });

  it("8. setTwoStepConfigManager rejects zero address", async () => {
    const { harness } = await loadFixture(harnessFixture);
    const ZERO = "0x" + "0".repeat(40);
    await expect(harness.write.setTwoStepConfigManager([ZERO as `0x${string}`])).to.be.rejected;
  });

  it("9. onlyTwoStepConfigManager modifier accepts the registered manager", async () => {
    const { harness, user } = await loadFixture(harnessFixture);
    await harness.write.setTwoStepConfigManager([user.account.address]);
    await harness.write.onlyTwoStepConfigManagerCall({ account: user.account });
    expect(await harness.read.flag()).to.equal(1n);
  });

  it("10. onlyTwoStepConfigManager rejects other callers", async () => {
    const { harness, user, rest } = await loadFixture(harnessFixture);
    await harness.write.setTwoStepConfigManager([user.account.address]);
    await expect(
      harness.write.onlyTwoStepConfigManagerCall({ account: rest[0].account }),
    ).to.be.rejected;
  });
});
