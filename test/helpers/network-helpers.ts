/**
 * Hardhat 3 facade — exposes the spec's expected `loadFixture` + `time`
 * API. Caches the connection so EDR snapshot/revert state is consistent
 * across calls.
 */
import { network } from "hardhat";

let cached: any;

async function conn() {
  if (cached) return cached;
  const n: any = network as any;
  cached = await (n.getOrCreate ? n.getOrCreate() : n.connect());
  return cached;
}

async function nh() {
  return (await conn()).networkHelpers;
}

export async function loadFixture<T>(fn: () => Promise<T>): Promise<T> {
  const helpers = await nh();
  return await helpers.loadFixture(fn);
}

export const time = {
  async latest(): Promise<number> {
    return await (await nh()).time.latest();
  },
  async increase(seconds: number | bigint): Promise<bigint | number> {
    return await (await nh()).time.increase(Number(seconds));
  },
  async setNextBlockTimestamp(ts: number | bigint): Promise<void> {
    await (await nh()).time.setNextBlockTimestamp(Number(ts));
  },
};

export async function impersonateAccount(addr: string): Promise<void> {
  await (await nh()).impersonateAccount(addr);
}

export async function setBalance(addr: string, balance: bigint): Promise<void> {
  await (await nh()).setBalance(addr, balance);
}
