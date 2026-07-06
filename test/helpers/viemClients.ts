/**
 * Hardhat 3 connection facade — exposes a `viem` helper that mirrors
 * the Hardhat 2 `hre.viem.*` API expected by the spec, plus
 * `getClients()` for the wallet/public client pack. Caches the
 * connection so all viem ops share a single EDR provider — required
 * for `loadFixture` snapshot/revert to be observable across calls.
 */
import { network } from "hardhat";

let cached: any;

async function conn() {
  if (cached) return cached;
  const n: any = network as any;
  cached = await (n.getOrCreate ? n.getOrCreate() : n.connect());
  return cached;
}

export const viem = {
  async deployContract(name: string, args: any[] = []) {
    const c = await conn();
    return await c.viem.deployContract(name, args);
  },
  async getContractAt(name: string, address: any) {
    const c = await conn();
    return await c.viem.getContractAt(name, address);
  },
  async getPublicClient() {
    const c = await conn();
    return await c.viem.getPublicClient();
  },
  async getWalletClients() {
    const c = await conn();
    return await c.viem.getWalletClients();
  },
};

export async function getClients() {
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [owner, user, keeper, treasury, ...rest] = wallets;
  return { publicClient, owner, user, keeper, treasury, rest };
}
