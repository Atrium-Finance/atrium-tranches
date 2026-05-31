import { encodeFunctionData } from "viem";
import { getClients, viem } from "../helpers/viemClients.js";
import { getAt } from "../helpers/deployments.js";
import { deployAcm } from "./deployAcm.js";

export async function erc20CooldownFixture() {
  const { owner, user, keeper, publicClient, rest } = await getClients();

  const acm = await deployAcm(owner.account.address);
  const token = await viem.deployContract("MockERC20", ["Tok", "TOK", 18]);

  const impl = await viem.deployContract("ERC20Cooldown");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const silo = await getAt<any>("ERC20Cooldown", proxy.address);

  // `keeper` is the protocol worker.
  const COOLDOWN_WORKER_ROLE = await silo.read.COOLDOWN_WORKER_ROLE();
  await acm.write.grantRole([COOLDOWN_WORKER_ROLE, keeper.account.address]);

  // Seed the worker with tokens + allowance so its transfer() pulls succeed.
  await token.write.mint([keeper.account.address, 10_000n * 10n ** 18n]);
  await token.write.approve(
    [silo.address, (1n << 255n) - 1n],
    { account: keeper.account }
  );

  return { silo, token, acm, owner, user, keeper, publicClient, rest };
}

export async function cooldownBaseFixture() {
  const { owner, publicClient, rest } = await getClients();

  const acm = await deployAcm(owner.account.address);
  const impl = await viem.deployContract("MockCooldown");
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
  const silo = await getAt<any>("MockCooldown", proxy.address);

  return { silo, acm, owner, publicClient, rest };
}
