import { encodeFunctionData } from "viem";
import { getClients, viem } from "../helpers/viemClients.js";
import { getAt } from "../helpers/deployments.js";
import { deployAcm } from "./deployAcm.js";

export async function strategyFixture() {
  const { owner, user, keeper, treasury, publicClient, rest } = await getClients();

  const acm = await deployAcm(owner.account.address);
  const usdai = await viem.deployContract("MockERC20", ["USDai", "USDai", 18]);
  const susdai = await viem.deployContract("MockSUSDai", [usdai.address]);
  const mockCDO = await viem.deployContract("MockCDO");

  // Deploy ERC20Cooldown silo behind a proxy.
  const cdImpl = await viem.deployContract("ERC20Cooldown");
  const cdInit = encodeFunctionData({
    abi: cdImpl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const cdProxy = await viem.deployContract("ProjectERC1967Proxy", [cdImpl.address, cdInit]);
  const silo = await getAt<any>("ERC20Cooldown", cdProxy.address);

  // Deploy USDAStrategy behind a proxy. Note: constructor immutables.
  const stImpl = await viem.deployContract("USDAStrategy", [susdai.address, silo.address]);
  const stInit = encodeFunctionData({
    abi: stImpl.abi,
    functionName: "initialize",
    args: [mockCDO.address, owner.account.address, acm.address],
  });
  const stProxy = await viem.deployContract("ProjectERC1967Proxy", [stImpl.address, stInit]);
  const strategy = await getAt<any>("USDAStrategy", stProxy.address);

  // Wire CDO so kindOf works for setCooldowns path.
  await mockCDO.write.setStrategy([strategy.address]);

  // Grant the role the strategy needs to drive the silo.
  const COOLDOWN_WORKER_ROLE = await silo.read.COOLDOWN_WORKER_ROLE();
  await acm.write.grantRole([COOLDOWN_WORKER_ROLE, strategy.address]);

  // Grant strategy admin the strat-config role so setCooldowns works.
  const UPDATER_STRAT_CONFIG_ROLE = await strategy.read.UPDATER_STRAT_CONFIG_ROLE();
  await acm.write.grantRole([UPDATER_STRAT_CONFIG_ROLE, owner.account.address]);

  return {
    strategy,
    silo,
    usdai,
    susdai,
    mockCDO,
    acm,
    owner,
    user,
    keeper,
    treasury,
    publicClient,
    rest,
  };
}
