/**
 * Fork configuration — pinned block strategy for reproducibility.
 *
 * Update BLOCK_NUMBER quarterly or when:
 *   - Aave changes its Pool interface (rare)
 *   - USD.AI changes sUSDai vault contract
 *   - Benchmark reserves restructure on Aave
 *
 * Choose blocks where:
 *   - USDC + USDT supply APR is sane (3-10%)
 *   - sUSDai has active vesting (recent distribution within 8h)
 *   - No active migrations or governance proposals affecting reserves
 */
export const FORK_CONFIG = {
  chainId: 42161, // Arbitrum One
  // TODO: pin to a production-relevant block once scenarios validated
  blockNumber: 250_000_000,
};

export function getForkBlockNumber(): number | "latest" {
  const env = process.env.FORK_BLOCK_NUMBER;
  if (env === "latest") return "latest";
  if (env) return parseInt(env);
  return FORK_CONFIG.blockNumber;
}

export function isForkEnabled(): boolean {
  return process.env.FORK_TESTS === "true";
}

export function getRpcUrl(): string | undefined {
  return process.env.ARBITRUM_RPC_URL;
}

/**
 * Suite-level skip predicate. True when fork tests are disabled or
 * the Arbitrum RPC URL is missing.
 */
export function shouldSkipFork(): boolean {
  return !isForkEnabled() || !getRpcUrl();
}
