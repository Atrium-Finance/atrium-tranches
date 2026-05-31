import { parseUnits, encodeFunctionData } from "viem";
import { getClients, viem } from "../helpers/viemClients.js";
import { getAt } from "../helpers/deployments.js";
import { deployAcm } from "./deployAcm.js";

/**
 * Full-stack deploy. Mocks USD.AI and Aave; everything else is real.
 */
export async function atriumFixture() {
  const { owner, user, keeper, treasury, publicClient, rest } = await getClients();

  const acm = await deployAcm(owner.account.address);

  // External mocks
  const usdai = await viem.deployContract("MockERC20", ["USDai", "USDai", 18]);
  const susdai = await viem.deployContract("MockSUSDai", [usdai.address]);

  // ERC20Cooldown silo
  const cdImpl = await viem.deployContract("ERC20Cooldown");
  const cdInit = encodeFunctionData({
    abi: cdImpl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const cdProxy = await viem.deployContract("ProjectERC1967Proxy", [cdImpl.address, cdInit]);
  const erc20Cooldown = await getAt<any>("ERC20Cooldown", cdProxy.address);

  // PrimeCDO
  const cdoImpl = await viem.deployContract("PrimeCDO");
  const cdoInit = encodeFunctionData({
    abi: cdoImpl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const cdoProxy = await viem.deployContract("ProjectERC1967Proxy", [cdoImpl.address, cdoInit]);
  const cdo = await getAt<any>("PrimeCDO", cdoProxy.address);

  // Strategy
  const stImpl = await viem.deployContract("USDAStrategy", [susdai.address, erc20Cooldown.address]);
  const stInit = encodeFunctionData({
    abi: stImpl.abi,
    functionName: "initialize",
    args: [cdo.address, owner.account.address, acm.address],
  });
  const stProxy = await viem.deployContract("ProjectERC1967Proxy", [stImpl.address, stInit]);
  const strategy = await getAt<any>("USDAStrategy", stProxy.address);

  // Accounting (uses real PrimeCDO)
  const mockFeed = await viem.deployContract("MockAprPairFeed");
  await mockFeed.write.setLatestRound([0n, 0n, 1n, BigInt(Math.floor(Date.now() / 1000))]);
  const acImpl = await viem.deployContract("Accounting");
  const acInit = encodeFunctionData({
    abi: acImpl.abi,
    functionName: "initialize",
    args: [
      cdo.address,
      mockFeed.address,
      owner.account.address,
      acm.address,
      parseUnits("0.04", 18),
      parseUnits("0.12", 18),
    ],
  });
  const acProxy = await viem.deployContract("ProjectERC1967Proxy", [acImpl.address, acInit]);
  const accounting = await getAt<any>("Accounting", acProxy.address);

  // Tranches
  async function deployTranche(name: string, symbol: string) {
    const impl = await viem.deployContract("Tranche");
    const init = encodeFunctionData({
      abi: impl.abi,
      functionName: "initialize",
      args: [usdai.address, name, symbol, cdo.address],
    });
    const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
    return await getAt<any>("Tranche", proxy.address);
  }
  const jr = await deployTranche("Junior", "JR");
  const mz = await deployTranche("Mezzanine", "MZ");
  const sr = await deployTranche("Senior", "SR");

  // Wire CDO -> components.
  await cdo.write.config([jr.address, mz.address, sr.address, accounting.address, strategy.address]);

  // Roles.
  const PAUSER_ROLE = await cdo.read.PAUSER_ROLE();
  const RESERVE_MANAGER_ROLE = await cdo.read.RESERVE_MANAGER_ROLE();
  const COOLDOWN_WORKER_ROLE = await cdo.read.COOLDOWN_WORKER_ROLE();
  const UPDATER_STRAT_CONFIG_ROLE = await cdo.read.UPDATER_STRAT_CONFIG_ROLE();

  await acm.write.grantRole([PAUSER_ROLE, owner.account.address]);
  await acm.write.grantRole([RESERVE_MANAGER_ROLE, owner.account.address]);
  await acm.write.grantRole([COOLDOWN_WORKER_ROLE, strategy.address]);
  await acm.write.grantRole([UPDATER_STRAT_CONFIG_ROLE, owner.account.address]);

  return {
    cdo,
    accounting,
    strategy,
    erc20Cooldown,
    jr,
    mz,
    sr,
    usdai,
    susdai,
    mockFeed,
    acm,
    owner,
    user,
    keeper,
    treasury,
    publicClient,
    rest,
  };
}
