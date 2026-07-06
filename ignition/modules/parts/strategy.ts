import { deployBehindProxy } from "./proxy.js";

/**
 * USDAStrategy — ctor `(sUSDai, erc20Cooldown)` (immutables), init
 * `(cdo, owner, acm)`. The CDO is passed at init (no `setCDO`), so the CDO
 * proxy must already exist. `initialize` also primes the standing
 * allowances (sUSDai→silo, USDai→sUSDai), so the silo must be deployed
 * first — enforced here by the `erc20Cooldown` future dependency.
 */
export function deployStrategy(
  m: any,
  ctx: { owner: any; acm: any; cdo: any; sUSDai: any; erc20Cooldown: any }
) {
  const strategy = deployBehindProxy(m, {
    name: "USDAStrategy",
    id: "Strategy",
    ctorArgs: [ctx.sUSDai, ctx.erc20Cooldown],
    initArgs: [ctx.cdo, ctx.owner, ctx.acm],
  });
  return { strategy };
}
