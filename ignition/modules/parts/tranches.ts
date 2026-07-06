/**
 * The three tranche vaults (Junior / Mezzanine / Senior). All three share
 * a single Tranche implementation; each gets its own proxy initialised
 * with `(asset = USDai, name, symbol, cdo)`. The CDO is bound at init —
 * `config(...)` then validates the back-reference.
 *
 * Proxy addresses are recorded as `<Module>#JrProxy`/`MzProxy`/`SrProxy`.
 */
export function deployTranches(m: any, ctx: { usdai: any; cdo: any }) {
  const impl = m.contract("Tranche", [], { id: "TrancheImpl" });

  function one(name: string, symbol: string, id: string) {
    const init = m.encodeFunctionCall(
      impl,
      "initialize",
      [ctx.usdai, name, symbol, ctx.cdo],
      { id: `${id}Init` }
    );
    const proxy = m.contract("AtriumProxy", [impl, init], { id: `${id}Proxy` });
    return m.contractAt("Tranche", proxy, { id });
  }

  const jr = one("Atrium Junior", "atJR", "Jr");
  const mz = one("Atrium Mezzanine", "atMZ", "Mz");
  const sr = one("Atrium Senior", "atSR", "Sr");

  return { jr, mz, sr };
}
