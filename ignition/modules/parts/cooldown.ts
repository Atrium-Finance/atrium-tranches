import { deployBehindProxy } from "./proxy.js";

/**
 * The two cooldown silos.
 *  - ERC20Cooldown: Strategy-side sUSDai withdrawal lock (worker = Strategy).
 *  - SharesCooldown: CDO-side share lock (worker = PrimeCDO).
 * Both take `initialize(owner, acm)`.
 */
export function deployCooldown(m: any, ctx: { owner: any; acm: any }) {
  const erc20Cooldown = deployBehindProxy(m, {
    name: "ERC20Cooldown",
    id: "Erc20Cooldown",
    initArgs: [ctx.owner, ctx.acm],
  });
  const sharesCooldown = deployBehindProxy(m, {
    name: "SharesCooldown",
    id: "SharesCooldown",
    initArgs: [ctx.owner, ctx.acm],
  });
  return { erc20Cooldown, sharesCooldown };
}
