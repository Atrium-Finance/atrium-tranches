/**
 * Hardhat 3 fork connection facade — mirrors `test/helpers/viemClients.ts`
 * but connects to the `forkArbitrum` network entry (which carries the
 * Alchemy forking config) instead of the default in-memory EDR.
 *
 * Connection is cached so viem deploy/read/write calls share a single
 * EDR provider — required for `loadFixture` snapshot/revert to be
 * observable across calls.
 */
import { network } from "hardhat";

const FORK_NETWORK = "forkArbitrum";

let cached: any;

async function conn() {
  if (cached) return cached;
  const n: any = network as any;
  cached = await (n.getOrCreate ? n.getOrCreate(FORK_NETWORK) : n.connect(FORK_NETWORK));
  return cached;
}

export const forkViem = {
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

export async function getForkClients() {
  const publicClient = await forkViem.getPublicClient();
  const wallets = await forkViem.getWalletClients();
  const [owner, user, keeper, treasury, ...rest] = wallets;
  return { publicClient, owner, user, keeper, treasury, rest };
}

async function nh() {
  return (await conn()).networkHelpers;
}

export async function forkLoadFixture<T>(fn: () => Promise<T>): Promise<T> {
  const helpers = await nh();
  return await helpers.loadFixture(fn);
}

export const forkTime = {
  async latest(): Promise<number> {
    return await (await nh()).time.latest();
  },
  async increase(seconds: number | bigint): Promise<bigint | number> {
    return await (await nh()).time.increase(Number(seconds));
  },
};

export async function forkImpersonate(addr: string): Promise<void> {
  await (await nh()).impersonateAccount(addr);
}

export async function forkSetBalance(addr: string, balance: bigint): Promise<void> {
  await (await nh()).setBalance(addr, balance);
}

export async function forkStopImpersonating(addr: string): Promise<void> {
  await (await nh()).stopImpersonatingAccount(addr);
}
