import { deployUUPS, getAt } from "../helpers/deployments.js";
import type { Address } from "viem";

export async function deployAcm(adminAddress: Address) {
  const { address } = await deployUUPS(
    "AccessControlManager",
    "initialize",
    [adminAddress]
  );
  const acm = await getAt<any>("AccessControlManager", address);
  return acm;
}
