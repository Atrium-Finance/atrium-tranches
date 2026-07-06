import { deployBehindProxy } from "./proxy.js";

/**
 * AccessControlManager — the protocol's role registry. UUPS-upgradeable;
 * the deploying EOA receives `DEFAULT_ADMIN_ROLE` via `initialize(admin)`
 * and grants every other role in the wiring step.
 */
export function deployAcl(m: any, ctx: { owner: any }) {
  const acm = deployBehindProxy(m, {
    name: "AccessControlManager",
    id: "Acm",
    initArgs: [ctx.owner],
  });
  return { acm };
}
