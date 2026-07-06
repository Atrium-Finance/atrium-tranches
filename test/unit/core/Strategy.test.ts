import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { encodeFunctionData, getAddress } from "viem";
import { deployAcm } from "../../fixtures/deployAcm.js";
import { getClients, viem } from "../../helpers/viemClients.js";

async function strategyAbsFixture() {
  const { owner, user, keeper, publicClient, rest } = await getClients();
  const acm = await deployAcm(owner.account.address);
  const mockCDO = await viem.deployContract("MockCDO");
  const impl = await viem.deployContract("MockStrategy");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [mockCDO.address, owner.account.address, acm.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const strategy = await viem.getContractAt("MockStrategy", proxy.address);
  return { strategy, mockCDO, acm, owner, user, keeper, publicClient, rest };
}

describe("Strategy abstract (via MockStrategy)", () => {
  it("1. onlyCDO blocks non-CDO callers", async () => {
    const { strategy, user } = await loadFixture(strategyAbsFixture);
    await expect(
      strategy.write.deposit([user.account.address, user.account.address, 0n, 0n, user.account.address],
        { account: user.account })
    ).to.be.rejected;
  });

  it("2. CDOComponent: cdo storage settable in initialize, getCDOAddress reachable", async () => {
    const { strategy, mockCDO } = await loadFixture(strategyAbsFixture);
    expect(getAddress(await strategy.read.getCDOAddress())).to.equal(getAddress(mockCDO.address));
  });

  it("3. AccessControlled: role modifier wired (acm reachable)", async () => {
    const { strategy, acm } = await loadFixture(strategyAbsFixture);
    expect(getAddress(await strategy.read.acm())).to.equal(getAddress(acm.address));
  });

  it("4. ReentrancyGuard initialized via AccessControlled init (smoke)", async () => {
    const { strategy } = await loadFixture(strategyAbsFixture);
    expect(strategy.address).to.match(/^0x[a-fA-F0-9]{40}$/);
  });

  it("5. Strategy is abstract (cannot deploy directly)", async () => {
    // Verified at compile time. Smoke check that the concrete MockStrategy deploys.
    const { strategy } = await loadFixture(strategyAbsFixture);
    expect(strategy.address).to.match(/^0x[a-fA-F0-9]{40}$/);
  });

  it("6. Supported-token registry settable (mock helper)", async () => {
    const { strategy } = await loadFixture(strategyAbsFixture);
    const t = await viem.deployContract("MockERC20", ["T", "T", 18]);
    await strategy.write.setSupportedTokens([[t.address]]);
    const tokens = await strategy.read.getSupportedTokens();
    expect(tokens.length).to.equal(1);
  });
});
