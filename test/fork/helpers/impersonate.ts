/**
 * Impersonate a mainnet account and fund it with ETH for gas, then
 * return its address typed as a viem `account`-shape object for use
 * in `{ account: ... }` write-call options.
 */
import { parseEther, type Address } from "viem";
import { forkImpersonate, forkSetBalance, forkStopImpersonating } from "./forkClients.js";

const GAS_FUND_WEI = parseEther("10");

export interface ImpersonatedAccount {
  address: Address;
  // viem write-call `account` field accepts a string or an Account object.
  // Bare address strings cover impersonated callers on Hardhat 3 + EDR.
  account: Address;
}

export async function impersonate(address: Address): Promise<ImpersonatedAccount> {
  await forkImpersonate(address);
  await forkSetBalance(address, GAS_FUND_WEI);
  return { address, account: address };
}

export async function stopImpersonate(address: Address): Promise<void> {
  await forkStopImpersonating(address);
}
