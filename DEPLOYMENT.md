# Atrium Deployment (Arbitrum One)

Hardhat **Ignition** deployment skeleton for the full Atrium stack. This
document is the source of truth for _how this repo actually deploys_ —
several assumptions in the original spec do not hold here and were adapted
(see [Deviations](#deviations-from-the-spec-skeleton)).

## What gets deployed

One Ignition module — [`ignition/modules/Atrium.ts`](ignition/modules/Atrium.ts)
— deploys 11 proxied contracts and wires them:

| Contract                    | Proxy key                    | Init args                                                |
| --------------------------- | ---------------------------- | -------------------------------------------------------- |
| AccessControlManager (UUPS) | `Atrium#AcmProxy`            | `(owner)`                                                |
| PrimeCDO                    | `Atrium#CdoProxy`            | `(owner, acm)`                                           |
| ERC20Cooldown               | `Atrium#Erc20CooldownProxy`  | `(owner, acm)`                                           |
| SharesCooldown              | `Atrium#SharesCooldownProxy` | `(owner, acm)`                                           |
| AaveAprPairProvider         | `Atrium#AprProviderProxy`    | ctor `(sUSDai, aavePool)`, init `(owner, acm)`           |
| AprPairFeed                 | `Atrium#AprPairFeedProxy`    | `(owner, acm, provider, roundStaleAfter, desc)`          |
| USDAStrategy                | `Atrium#StrategyProxy`       | ctor `(sUSDai, erc20Cooldown)`, init `(cdo, owner, acm)` |
| Accounting                  | `Atrium#AccountingProxy`     | `(cdo, address(0), owner, acm, aprTarget, aprBase)`      |
| Tranche ×3 (Jr/Mz/Sr)       | `Atrium#{Jr,Mz,Sr}Proxy`     | `(USDai, name, symbol, cdo)`                             |

The module is factored into per-concern files under
[`ignition/modules/parts/`](ignition/modules/parts/) (acl, cdo, cooldown,
oracle, strategy, accounting, tranches, wiring) sharing one
`deployBehindProxy` helper.

### Deploy order (dictated by the contracts, not the spec)

```
ACL → CDO → Cooldown → Oracle → Strategy → Accounting → Tranches → wiring
```

The **CDO is deployed before its components**: components bind the CDO at
`initialize(...)` (there is no `setCDO`), and `PrimeCDO.config(...)` reverts
unless each component already back-references the CDO
(`ICDOComponent.getCDOAddress() == cdo`).

### Wiring step (`parts/wiring.ts`)

1. Read role ids on-chain from the deployed CDO (`staticCall`).
2. Grant roles: `PAUSER_ROLE`, `RESERVE_MANAGER_ROLE`,
   `UPDATER_STRAT_CONFIG_ROLE` → owner; `UPDATER_FEED_ROLE`,
   `UPDATER_STRAT_CONFIG_ROLE` → keeper; `COOLDOWN_WORKER_ROLE` → strategy
   (ERC20 silo) and → cdo (Shares silo).
3. `cdo.config(jr, mz, sr, accounting, strategy)`.
4. `cdo.setSharesCooldown`, `setReserveTreasury`, `setExitFees`.
5. `cdo.setActionStates(0, true, true)` — enable deposits/withdrawals
   (default is disabled).
6. `strategy.setCooldowns(jr, mz, sr)` — `0/0/0` keeps withdrawals instant.
7. `provider.setBenchmarkTokens(...)` — validates live Aave reserves.

## Workflow

```bash
# 1. Env
cp .env.example .env
# Set DEPLOYER_PRIVATE_KEY, ARBITRUM_RPC_URL, ETHERSCAN_API_KEY

# 2. Parameters — edit ignition/parameters/mainnet.json:
#    owner = deployer EOA, keeper = keeper EOA, treasury = treasury.
#    (Optional) verify role hashes:  pnpm compute:roles

# 3. (Recommended) dry-run on a local fork
ATRIUM_NETWORK=forkArbitrum   # for E2E later
FORK_BLOCK_NUMBER=latest pnpm hardhat ignition deploy ignition/modules/Atrium.ts \
  --network forkArbitrum \
  --parameters ignition/parameters/mainnet.json \
  --deployment-id fork-dryrun
# (owner/keeper/treasury must equal the fork deployer 0xf39F…2266 for the
#  onlyOwner/onlyRole wiring calls to pass on the fork.)

# 4. Deploy to mainnet
pnpm deploy:mainnet

# 5. Verify on Arbiscan (Etherscan V2 key)
pnpm verify:mainnet

# 6. E2E (deployer needs USDai)
pnpm e2e:deposit
pnpm e2e:withdraw

# 7. (Team) transfer ownership EOA → multisig after audit
```

## Deviations from the spec skeleton

The spec assumed Hardhat 2 + `setCDO` setters + an all-UUPS stack. Reality:

1. **Hardhat 3.** Config is merged (not overwritten) — the fork/EDR
   networks, `chainDescriptors`, and `viaIR` are preserved. Ignition and
   verify are already registered by `hardhat-toolbox-viem`, so they are
   _not_ added to `plugins` (only installed). The E2E scripts use the HH3
   `network.connect()` model, not `hre.viem.*`.
2. **Build profiles.** `hardhat ignition deploy` uses the **`production`**
   profile. The `solidity` config now declares `default` _and_ `production`
   with `viaIR` — without it the production build hits "Stack too deep".
3. **No `setCDO`.** The CDO is deployed first and passed into each
   component's `initialize`. There is no placeholder/`PostWiring.setCDO`
   step.
4. **Only ACM is UUPS-upgradeable.** Every contract sits behind an
   `AtriumProxy` (ERC-1967) for one-shot init + storage isolation, but only
   `AccessControlManager` has a `_authorizeUpgrade` hook. The rest are
   **immutable** until UUPS is added (the project's upgradeability decision
   is still open). Plan upgrades accordingly.
5. **Accounting feed = `address(0)`.** `Accounting` reads the legacy
   `IAPRFeed` shape, which is incompatible with the deployed `AprPairFeed`
   (`IAprPairFeed`). Wiring the real feed would make every
   `updateAccounting()` revert/garble, so the feed is deployed standalone
   and Accounting runs in push-mode off the seeded `aprTarget`/`aprBase`.
   **Connecting the feed awaits the planned Accounting interface
   amendment** (tracked in `progress-tracker.md`, flagged in `AUDIT.md`).
6. **E2E withdraw uses the 4-arg `redeem(sUSDai, …)`.** The Strategy only
   releases sUSDai; the standard 3-arg `redeem` routes a USDai withdrawal
   and reverts.
7. **Roles read on-chain.** The wiring reads role ids via `staticCall`
   instead of pasted keccak hashes. `compute-role-hashes.ts` is kept as a
   convenience for manual/multisig grants.

## Gotchas

- **Resume:** Ignition state lives in `ignition/deployments/<id>/`. A failed
  run resumes from the last successful step — do **not** delete it.
  (`ignition/deployments` is gitignored in this repo.)
- **Oracle needs live state:** `AaveAprPairProvider` init reads
  `sUSDai.depositSharePrice()` and `setBenchmarkTokens` reads Aave — a bare
  (non-fork) local node will revert at these steps.
- **Wiring runs as the deployer:** `config`/`setActionStates`/`setCooldowns`
  etc. are `onlyOwner`/`onlyRole`, so `owner` in the parameters file must
  equal the deploying account.
- **sUSDai is ERC-7540:** real sUSDai may gate deposits/redeems at some
  blocks; E2E success depends on USD.AI accepting the action at the chosen
  block.

## Post-deploy checklist

- [ ] 11 contracts deployed; addresses recorded in
      `ignition/deployments/chain-42161/deployed_addresses.json`
- [ ] `pnpm verify:mainnet` succeeds; all contracts "Verified" on Arbiscan
- [ ] `strategy.cdo()` / `accounting.cdo()` / `jr.cdo()` == CDO proxy
- [ ] Roles granted (see wiring step)
- [ ] `pnpm e2e:deposit` + `pnpm e2e:withdraw` pass
- [ ] On-chain params match `mainnet.json`

## Team TODO (left as skeleton)

- `scripts/transfer-ownership.ts` — EOA → multisig (after audit)
- Timelock integration
- Remaining E2E scripts (yield cycle, reserve drain, emergency pause)
- Per-tranche `SharesCooldown` bounds + real Strategy cooldown durations
- Wire `AprPairFeed → Accounting` once the Accounting interface amendment lands
- Keeper bot (`sampleRate` + `updateRoundData`) and monitoring
