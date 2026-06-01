/**
 * Arbitrum mainnet addresses for Atrium fork tests. Run
 * `pnpm test:fork:check` to verify contracts and whales remain valid
 * before each major test run.
 */

const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const ARBITRUM_ADDRESSES = {
  // ---- USD.AI (Atrium underlying) ----
  USDai: "0x0a1a1a107E45b7ceD86833863f482BC5f4ed82EF" as const,
  sUSDai: "0x5f02c1bec4ad5de9b7abf999c1f0854d4836a049" as const,

  // ---- Aave V3 Arbitrum (READ-ONLY for benchmark APR) ----
  aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const,

  // ---- Aave benchmark reserves (READ-ONLY) ----
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const,
  USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as const,

  // ---- Aave aTokens (READ-ONLY for getReserveData responses) ----
  aUSDC: "0x724dc807b04555b71ed48a6896b6F41593b8C637" as const,
  aUSDT: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620" as const,

  // ---- Whales (fund test users via impersonation) ----
  whaleUSDai: "0xE158d53614c6D0Ba4ad85E3965B872a08570c3e8" as const,
  whaleSUSDai: "0x87384eb93e1096210c58049706a9e2bBF8355055" as const,
} as const;

export type AddressKey = keyof typeof ARBITRUM_ADDRESSES;

/**
 * Check if all required addresses are configured. Tests that depend on
 * unconfigured addresses should skip with informative message.
 */
export function isConfigured(...keys: AddressKey[]): boolean {
  // Widen to string before comparing — the `as const` narrows each
  // value to its literal type, which makes the direct `!== ZERO` look
  // structurally unsatisfiable once every address is filled in. The
  // runtime check is still meaningful (someone could revert one back
  // to the placeholder).
  return keys.every((k) => (ARBITRUM_ADDRESSES[k] as string) !== ZERO);
}
