import { encodeFunctionData } from "viem";
import { getClients, viem } from "../helpers/viemClients.js";
import { getAt } from "../helpers/deployments.js";

export async function trancheFixture() {
  const { owner, user, keeper, treasury, publicClient, rest } = await getClients();

  const asset = await viem.deployContract("MockERC20", ["USDai", "USDai", 18]);
  const mockCDO = await viem.deployContract("MockCDO");
  const mockStrategy = await viem.deployContract("MockStrategy");
  const mockAccounting = await viem.deployContract("MockAccounting");

  // Deploy the Tranche implementation directly and wrap in ERC1967Proxy.
  const impl = await viem.deployContract("Tranche");
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [asset.address, "Junior", "JR", mockCDO.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, initData]);
  const tranche = await getAt<any>("Tranche", proxy.address);

  await mockCDO.write.setAccounting([mockAccounting.address]);
  await mockCDO.write.setStrategy([mockStrategy.address]);
  await mockCDO.write.setVaults([tranche.address, tranche.address, tranche.address]);
  await mockStrategy.write.setSupportedTokens([[asset.address]]);

  return {
    tranche,
    asset,
    usdai: asset, // alias for callers that expect a USDai-style name
    mockCDO,
    mockStrategy,
    mockAccounting,
    owner,
    user,
    keeper,
    treasury,
    publicClient,
    rest,
  };
}
