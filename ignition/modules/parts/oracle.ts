import { deployBehindProxy } from "./proxy.js";

/**
 * APR oracle stack:
 *  - AaveAprPairProvider: ctor `(sUSDai, aavePool)`, init `(owner, acm)`.
 *    `initialize` bootstraps a sample from `sUSDai.depositSharePrice()`,
 *    so this deploy makes a LIVE external call — it only works on a fork
 *    or real mainnet, not a bare local node.
 *  - AprPairFeed: init `(owner, acm, provider, roundStaleAfter, description)`.
 *
 * NOTE: the feed is deployed standalone and is NOT wired into Accounting.
 * `Accounting` still consumes the legacy `IAPRFeed` shape, which is
 * incompatible with `AprPairFeed`'s `IAprPairFeed` round struct — wiring it
 * would make every `updateAccounting()` revert/garble. The keeper can push
 * rounds here today; connecting it to Accounting awaits the planned
 * Accounting interface amendment.
 */
export function deployOracle(
  m: any,
  ctx: {
    owner: any;
    acm: any;
    sUSDai: any;
    aavePool: any;
    roundStaleAfter: any;
    feedDescription: any;
  }
) {
  const provider = deployBehindProxy(m, {
    name: "AaveAprPairProvider",
    id: "AprProvider",
    ctorArgs: [ctx.sUSDai, ctx.aavePool],
    initArgs: [ctx.owner, ctx.acm],
  });

  const feed = deployBehindProxy(m, {
    name: "AprPairFeed",
    id: "AprPairFeed",
    initArgs: [ctx.owner, ctx.acm, provider, ctx.roundStaleAfter, ctx.feedDescription],
  });

  return { provider, feed };
}
