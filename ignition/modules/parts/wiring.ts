const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Post-deploy wiring: grant the role matrix, wire the CDO to its
 * components, and enable the protocol.
 *
 * Role identifiers are read on-chain from the deployed CDO (it inherits
 * the `AccessControlled` constants) rather than hard-coded keccak hashes —
 * eliminates copy-paste hash errors. The deploying EOA already holds
 * `DEFAULT_ADMIN_ROLE` on the ACM (from `AccessControlManager.initialize`),
 * so it can grant every role.
 *
 * Ordering (enforced with `after`):
 *   roles → cdo.config → role-gated setters.
 */
export function deployWiring(
  m: any,
  ctx: {
    owner: any;
    keeper: any;
    treasury: any;
    acm: any;
    cdo: any;
    strategy: any;
    accounting: any;
    jr: any;
    mz: any;
    sr: any;
    sharesCooldown: any;
    provider: any;
    benchmarkTokens: any;
    cooldownJr: any;
    cooldownMz: any;
    cooldownSr: any;
    exitFeeJr: any;
    exitFeeMz: any;
    exitFeeSr: any;
  }
) {
  const { acm, cdo, strategy, accounting, jr, mz, sr } = ctx;

  // --- Role identifiers (read from the deployed CDO) ---
  const PAUSER_ROLE = m.staticCall(cdo, "PAUSER_ROLE", [], 0, { id: "role_pauser" });
  const RESERVE_MANAGER_ROLE = m.staticCall(cdo, "RESERVE_MANAGER_ROLE", [], 0, { id: "role_reserve" });
  const COOLDOWN_WORKER_ROLE = m.staticCall(cdo, "COOLDOWN_WORKER_ROLE", [], 0, { id: "role_cooldown" });
  const UPDATER_STRAT_CONFIG_ROLE = m.staticCall(cdo, "UPDATER_STRAT_CONFIG_ROLE", [], 0, { id: "role_strat" });
  const UPDATER_FEED_ROLE = m.staticCall(cdo, "UPDATER_FEED_ROLE", [], 0, { id: "role_feed" });

  // --- Role grants ---
  // owner: pause, reserve drain, and the strategy-config role so the
  //        deployer can run the role-gated wiring steps below.
  const grantPauser = m.call(acm, "grantRole", [PAUSER_ROLE, ctx.owner], { id: "grant_pauser_owner" });
  m.call(acm, "grantRole", [RESERVE_MANAGER_ROLE, ctx.owner], { id: "grant_reserve_owner" });
  const grantStratOwner = m.call(acm, "grantRole", [UPDATER_STRAT_CONFIG_ROLE, ctx.owner], {
    id: "grant_strat_owner",
  });

  // keeper: APR feed pushes + ongoing strategy sampling/benchmark updates.
  m.call(acm, "grantRole", [UPDATER_FEED_ROLE, ctx.keeper], { id: "grant_feed_keeper" });
  m.call(acm, "grantRole", [UPDATER_STRAT_CONFIG_ROLE, ctx.keeper], { id: "grant_strat_keeper" });

  // strategy: drives the ERC20Cooldown silo (transfer + disable toggle).
  const grantCooldownStrategy = m.call(acm, "grantRole", [COOLDOWN_WORKER_ROLE, strategy], {
    id: "grant_cooldown_strategy",
  });
  // cdo: drives the SharesCooldown silo (requestRedeem via cooldownShares).
  m.call(acm, "grantRole", [COOLDOWN_WORKER_ROLE, cdo], { id: "grant_cooldown_cdo" });

  // --- Wire CDO -> components (validates each back-reference). ---
  const config = m.call(cdo, "config", [jr, mz, sr, accounting, strategy], { id: "cdo_config" });

  // --- CDO owner-gated configuration (after config so storage is wired). ---
  m.call(cdo, "setSharesCooldown", [ctx.sharesCooldown], { id: "set_shares_cooldown", after: [config] });
  m.call(cdo, "setReserveTreasury", [ctx.treasury], { id: "set_treasury", after: [config] });
  m.call(cdo, "setExitFees", [ctx.exitFeeJr, ctx.exitFeeMz, ctx.exitFeeSr], {
    id: "set_exit_fees",
    after: [config],
  });

  // Enable deposits + withdrawals on all three tranches (PAUSER_ROLE).
  // `address(0)` fans out to all tranches. Default state is disabled.
  m.call(cdo, "setActionStates", [ZERO_ADDRESS, true, true], {
    id: "enable_actions",
    after: [config, grantPauser],
  });

  // Per-tranche Strategy cooldown durations (UPDATER_STRAT_CONFIG_ROLE).
  // All-zero keeps withdrawals instant for the skeleton/E2E; the team sets
  // real durations before public launch. This also toggles the silo's
  // disabled flag, which needs the strategy's COOLDOWN_WORKER_ROLE.
  m.call(strategy, "setCooldowns", [ctx.cooldownJr, ctx.cooldownMz, ctx.cooldownSr], {
    id: "set_cooldowns",
    after: [grantStratOwner, grantCooldownStrategy],
  });

  // Oracle benchmark basket (UPDATER_STRAT_CONFIG_ROLE). Validates each
  // token has a live Aave V3 reserve — requires fork/mainnet.
  m.call(ctx.provider, "setBenchmarkTokens", [ctx.benchmarkTokens], {
    id: "set_benchmark",
    after: [grantStratOwner],
  });
}
