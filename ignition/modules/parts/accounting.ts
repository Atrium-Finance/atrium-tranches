import { deployBehindProxy } from "./proxy.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Accounting — init
 * `(cdo, feed, owner, acm, aprTargetDefault, aprBaseDefault)`.
 *
 * The `feed` argument is deliberately `address(0)`: `Accounting` reads the
 * legacy `IAPRFeed` interface, which is NOT compatible with the deployed
 * `AprPairFeed` (`IAprPairFeed`). With a zero feed, `_fetchAprs()` no-ops
 * and Accounting compounds the Senior index off the seeded
 * `aprTargetDefault`/`aprBaseDefault` until the Accounting interface
 * amendment lands and a real feed can be wired via `setAprPairFeed(...)`.
 *
 * `aprTarget`/`aprBase` are `UD60x18` (1e18-scaled uint256), e.g.
 * `0.04e18` and `0.12e18`.
 */
export function deployAccounting(
  m: any,
  ctx: { owner: any; acm: any; cdo: any; aprTargetDefault: any; aprBaseDefault: any }
) {
  const accounting = deployBehindProxy(m, {
    name: "Accounting",
    id: "Accounting",
    initArgs: [ctx.cdo, ZERO_ADDRESS, ctx.owner, ctx.acm, ctx.aprTargetDefault, ctx.aprBaseDefault],
  });
  return { accounting };
}
