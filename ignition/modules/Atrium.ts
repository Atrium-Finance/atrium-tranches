import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

import { deployAcl } from "./parts/acl.js";
import { deployCdo } from "./parts/cdo.js";
import { deployCooldown } from "./parts/cooldown.js";
import { deployOracle } from "./parts/oracle.js";
import { deployStrategy } from "./parts/strategy.js";
import { deployAccounting } from "./parts/accounting.js";
import { deployTranches } from "./parts/tranches.js";
import { deployWiring } from "./parts/wiring.js";

/**
 * Top-level Atrium deployment.
 *
 * Single `buildModule` so all parameters live in ONE `Atrium` block of the
 * parameter file (no per-submodule duplication of `owner`/addresses) and
 * all `deployed_addresses.json` keys share the `Atrium#` prefix. The stack
 * is factored into per-concern functions under `./parts`.
 *
 * Deploy order is dictated by the codebase, NOT the skeleton spec:
 *   ACL → CDO → Cooldown → Oracle → Strategy → Accounting → Tranches → wiring.
 * The CDO is deployed BEFORE its components because they bind the CDO at
 * `initialize(...)` (no `setCDO`) and `config(...)` checks the back-reference.
 */
export default buildModule("Atrium", (m) => {
  // --- Parameters (filled from ignition/parameters/mainnet.json) ---
  const owner = m.getParameter("owner");
  const keeper = m.getParameter("keeper");
  const treasury = m.getParameter("treasury");

  const sUSDai = m.getParameter("sUSDai");
  const usdai = m.getParameter("USDai");
  const aavePool = m.getParameter("aavePool");
  const benchmarkTokens = m.getParameter("benchmarkTokens");

  const roundStaleAfter = m.getParameter("roundStaleAfter", 86_400);
  const feedDescription = m.getParameter("feedDescription", "Atrium sUSDai APR Feed");
  const aprTargetDefault = m.getParameter("aprTargetDefault");
  const aprBaseDefault = m.getParameter("aprBaseDefault");

  const cooldownJr = m.getParameter("cooldownJr", 0);
  const cooldownMz = m.getParameter("cooldownMz", 0);
  const cooldownSr = m.getParameter("cooldownSr", 0);

  const exitFeeJr = m.getParameter("exitFeeJr", 0);
  const exitFeeMz = m.getParameter("exitFeeMz", 0);
  const exitFeeSr = m.getParameter("exitFeeSr", 0);

  // --- Deploy (CDO before components — see module note) ---
  const { acm } = deployAcl(m, { owner });
  const { cdo } = deployCdo(m, { owner, acm });
  const { erc20Cooldown, sharesCooldown } = deployCooldown(m, { owner, acm });
  const { provider, feed } = deployOracle(m, {
    owner,
    acm,
    sUSDai,
    aavePool,
    roundStaleAfter,
    feedDescription,
  });
  const { strategy } = deployStrategy(m, { owner, acm, cdo, sUSDai, erc20Cooldown });
  const { accounting } = deployAccounting(m, { owner, acm, cdo, aprTargetDefault, aprBaseDefault });
  const { jr, mz, sr } = deployTranches(m, { usdai, cdo });

  // --- Roles + wiring ---
  deployWiring(m, {
    owner,
    keeper,
    treasury,
    acm,
    cdo,
    strategy,
    accounting,
    jr,
    mz,
    sr,
    sharesCooldown,
    provider,
    benchmarkTokens,
    cooldownJr,
    cooldownMz,
    cooldownSr,
    exitFeeJr,
    exitFeeMz,
    exitFeeSr,
  });

  return {
    acm,
    cdo,
    accounting,
    strategy,
    erc20Cooldown,
    sharesCooldown,
    provider,
    feed,
    jr,
    mz,
    sr,
  };
});
