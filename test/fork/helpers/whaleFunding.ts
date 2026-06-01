/**
 * Whale-funding helpers — impersonate a mainnet holder and route real
 * ERC20 balances to test accounts.
 */
import type { Address } from "viem";
import { impersonate } from "./impersonate.js";

/**
 * Transfer `amount` of `token` from `whale` to `recipient`. Token must
 * be a viem contract instance with `balanceOf` and `transfer`. Whale
 * must hold enough at the pinned block — fork tests fail loudly when
 * balances move.
 */
export async function fundFromWhale(whale: Address, recipient: Address, token: any, amount: bigint): Promise<void> {
  const whaleBalance = (await token.read.balanceOf([whale])) as bigint;
  if (whaleBalance < amount) {
    let symbol = "<unknown>";
    try {
      symbol = (await token.read.symbol()) as string;
    } catch {
      // some tokens (rare) don't expose `symbol()` — fall through
    }
    throw new Error(`Whale ${whale} has insufficient ${symbol}: ${whaleBalance} < ${amount}`);
  }

  const whaleAccount = await impersonate(whale);
  await token.write.transfer([recipient, amount], {
    account: whaleAccount.account,
  });
}

/**
 * Verify a whale still holds expected token at current fork state.
 * Pre-test setup uses this to catch stale whales before the suite
 * burns time on cascading failures.
 */
export async function assertWhaleBalance(whale: Address, token: any, minBalance: bigint): Promise<void> {
  const balance = (await token.read.balanceOf([whale])) as bigint;
  if (balance < minBalance) {
    throw new Error(
      `Whale ${whale} balance ${balance} below min ${minBalance}. ` +
        `Pinned block may need refresh or whale moved funds.`,
    );
  }
}
