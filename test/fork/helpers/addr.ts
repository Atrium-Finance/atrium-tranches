/**
 * Checksum-normalising accessor for `ARBITRUM_ADDRESSES`.
 *
 * viem rejects any mixed-case address whose casing doesn't match EIP-55
 * (`InvalidAddressError` from `assertRequest`). Address constants in
 * `addresses.ts` are hand-typed and may carry arbitrary case. This
 * helper passes every value through viem's `getAddress`, which
 * normalises to proper EIP-55 — so consumers never have to remember
 * to wrap call sites by hand.
 */
import { getAddress, type Address } from "viem";
import { ARBITRUM_ADDRESSES, type AddressKey } from "./addresses.js";

export function addr(key: AddressKey): Address {
  return getAddress(ARBITRUM_ADDRESSES[key]);
}
