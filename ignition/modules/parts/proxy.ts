/**
 * Shared "deploy implementation, then atomically initialise behind an
 * ERC-1967 proxy" helper for every Atrium component.
 *
 * The implementation's `initialize(...)` is ABI-encoded and passed as the
 * proxy constructor `data`, so the proxy is deployed AND initialised in a
 * single transaction — no front-running window on the initializer.
 *
 * Returns the `contractAt` future typed as the component, whose address is
 * the proxy address. The proxy deployment is recorded in
 * `deployed_addresses.json` under `<Module>#<id>Proxy`.
 */
export interface DeployBehindProxyOptions {
  /** Contract (implementation) name, must match an artifact. */
  name: string;
  /** Stable id prefix; produces `<id>Impl`, `<id>Init`, `<id>Proxy`, `<id>`. */
  id: string;
  /** Implementation constructor args (immutables). Default: none. */
  ctorArgs?: any[];
  /** Initializer args, in declared order. */
  initArgs: any[];
  /** Initializer function name. Default: `initialize`. */
  initFn?: string;
}

export function deployBehindProxy(m: any, opts: DeployBehindProxyOptions) {
  const { name, id, ctorArgs = [], initArgs, initFn = "initialize" } = opts;

  const impl = m.contract(name, ctorArgs, { id: `${id}Impl` });
  const initData = m.encodeFunctionCall(impl, initFn, initArgs, { id: `${id}Init` });
  const proxy = m.contract("AtriumProxy", [impl, initData], { id: `${id}Proxy` });

  return m.contractAt(name, proxy, { id });
}
