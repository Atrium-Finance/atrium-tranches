import { parseUnits } from "viem";
import { getClients, viem } from "../helpers/viemClients.js";
import { deployUUPS, getAt } from "../helpers/deployments.js";
import { deployAcm } from "./deployAcm.js";

export async function accountingFixture() {
  const { owner, user, keeper, treasury, publicClient, rest } = await getClients();

  const acm = await deployAcm(owner.account.address);

  const mockCDO = await viem.deployContract("MockCDO");
  const mockFeed = await viem.deployContract("MockAprPairFeed");

  // Set a sensible default round so `_fetchAprs` doesn't blow up.
  await mockFeed.write.setLatestRound([0n, 0n, 1n, BigInt(Math.floor(Date.now() / 1000))]);

  const { address } = await deployUUPS("Accounting", "initialize", [
    mockCDO.address,
    mockFeed.address,
    owner.account.address,
    acm.address,
    parseUnits("0.04", 18),
    parseUnits("0.12", 18),
  ]);
  const accounting = await getAt<any>("Accounting", address);

  await mockCDO.write.setAccounting([accounting.address]);

  return {
    accounting,
    mockCDO,
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
