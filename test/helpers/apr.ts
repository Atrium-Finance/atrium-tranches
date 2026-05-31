import { parseUnits } from "viem";

/**
 * APR encoding helpers.
 *
 * SD7x12 (feed wire format)     : int64, 12 decimals
 * UD60x18 (Accounting internal) : uint256, 18 decimals
 * RAY (Aave wire format)        : uint128, 27 decimals
 */

export function apr12FromPct(pct: number): bigint {
  // e.g. apr12FromPct(12) = 0.12 * 1e12 = 0.12e12
  return BigInt(Math.round(pct * 1e10));
}

export function apr18FromPct(pct: number): bigint {
  return parseUnits(pct.toString(), 16); // pct% in 1e18 precision
}

export function rayFromPct(pct: number): bigint {
  // e.g. rayFromPct(5) = 0.05 * 1e27
  return BigInt(Math.round(pct * 1e25));
}

/** apr18 -> apr12: divide by 1e6. */
export function apr18ToApr12(apr18: bigint): bigint {
  return apr18 / 10n ** 6n;
}

/** apr12 -> apr18: multiply by 1e6. */
export function apr12ToApr18(apr12: bigint): bigint {
  return apr12 * 10n ** 6n;
}
