import { deployBehindProxy } from "./proxy.js";

/**
 * PrimeCDO — the orchestrator. Deployed BEFORE its components because
 * `config(...)` requires each component to already back-reference this
 * CDO (`ICDOComponent.getCDOAddress() == cdo`), and components take the
 * CDO address at `initialize(...)` time (there is no `setCDO`).
 */
export function deployCdo(m: any, ctx: { owner: any; acm: any }) {
  const cdo = deployBehindProxy(m, {
    name: "PrimeCDO",
    id: "Cdo",
    initArgs: [ctx.owner, ctx.acm],
  });
  return { cdo };
}
