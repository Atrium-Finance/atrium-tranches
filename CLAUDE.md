# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context (auto-loaded — read before implementing or architectural decisions)

`AGENTS.md` is the tool-agnostic source of truth and is pulled in below so it auto-loads every session.

@AGENTS.md

@context/project-overview.md
@context/architecture-context.md
@context/code-standards.md
@context/ai-workflow-rules.md
@context/progress-tracker.md

**Update `context/progress-tracker.md` after each meaningful implementation change.** It is the running
log of what every spec landed, the open questions, and the known runtime gaps — keep it accurate. If a
change alters architecture, scope, or standards, update the relevant context file before continuing.

## Commands

Package manager is **pnpm**. Toolchain is **Hardhat 3 + viem** (not Foundry, despite what some context
docs describe — those describe the intended/reference stack; the actual stack is Hardhat).

```bash
pnpm build                 # hardhat compile (solc 0.8.35, viaIR, optimizer runs=200)
pnpm test                  # all hardhat tests
pnpm test:unit             # test/unit/**          (mocks only, fast)
pnpm test:integration      # test/integration/**   (full deployed stack via fixtures)
pnpm test:all              # unit + integration (the default loop; fork tests excluded)
pnpm test:fork             # test/fork/**  — needs FORK_TESTS=true + ARBITRUM_RPC_URL, else self-skips
pnpm test:fork:check       # pre-flight: verify configured Arbitrum addresses have code
pnpm test:coverage         # coverage report
pnpm test:gas              # gas stats
pnpm clean                 # hardhat clean

# Run a single test file:
pnpm exec hardhat test test/unit/core/Accounting.test.ts
# Filter by test name (node:test runner):
pnpm exec hardhat test test/unit/core/Accounting.test.ts --test-name-pattern "srtTargetIndex"

# Deployment (Hardhat Ignition) — see DEPLOYMENT.md
pnpm compute:roles         # print role hashes
pnpm deploy:visualize      # render the Ignition graph
pnpm deploy:mainnet        # deploy ignition/modules/Atrium.ts to Arbitrum One
pnpm verify:mainnet
pnpm e2e:deposit / e2e:withdraw   # live-network E2E scripts (need a funded DEPLOYER_PRIVATE_KEY)
```

There is **no lint script**. "Lint" means keeping `pnpm build` warning-clean and following `.prettierrc`
(Solidity: 4-space tabs, 120 print width). Tests run on the `node:test` runner through a custom viem facade
in `test/helpers/` (`viemClients.ts`, `network-helpers.ts`, `chai-setup.ts`); fixtures live in
`test/fixtures/` (`deployAtrium.ts` is the full-stack fixture; `deploy*Only.ts` are scoped).

## Architecture (big picture)

Atrium is a three-tranche CDO over a single yield strategy. Capital splits into **Senior / Mezzanine /
Junior** ERC-4626 vaults that share one underlying strategy; yield flows Senior-first, losses flow
Junior-first (the waterfall). The full math model is in `context/project-overview.md`.

**Contract topology** (`contracts/`):

- `vaults/Tranche.sol` — the three ERC-4626 meta-vaults (one deployment each for Jr/Mz/Sr). Accepts the
  base asset (USDai) plus strategy-supported alternatives. Overrides all ERC-4626 withdraw entrypoints;
  every state-changing entry calls `cdo.updateAccounting()` first, then routes through `PrimeCDO`.
- `core/PrimeCDO.sol` — the orchestrator and single entry point; holds no user funds. Routes deposits to
  Strategy, routes withdrawals through coverage-aware exit modes (ERC4626 / SharesLock / Fee), enforces the
  `MIN_COVERAGE = 1.05e18` gate and per-tranche pause flags, forwards all accounting to `Accounting`.
- `core/Accounting.sol` — pure calculation, holds no funds. `calculateNAVSplit(...)` is the heart: yield
  split (Case 1/2) and loss waterfall (Jr→Mz→Sr, Reserve excluded). Tracks Senior's compounding target
  index, reads APRs from a feed (PUSH/PULL). Most math-dense file in the repo ("Track B").
- `core/Strategy.sol` (abstract) + `strategies/usda/USDAStrategy.sol` — manages all staked assets, reports
  one `totalAssets()`. The concrete strategy stakes USDai into **sUSDai**, an **ERC-7540 async vault**
  (see gotcha below).
- `core/cooldown/` — withdrawal silos: `SharesCooldown` (share-lock path) and `ERC20Cooldown` (token
  cooldown path), both on `CooldownBase`. Coverage-aware exit ranges, fees, lockups.
- `oracles/AprPairFeed.sol` (+ `strategies/usda/AaveAprPairProvider.sol`) — Chainlink-style APR oracle
  feeding `aprBase`/`aprTarget` into Accounting, with an on-chain provider fallback.
- `governance/AccessControlManager.sol` (UUPS) + `governance/AccessControlled.sol` (base) — external role
  registry. Both role-based (`onlyRole`) and call-based (`isAllowedToCall`) ACL live here; consumers
  delegate every privileged check to the ACM. Role constants are declared in `AccessControlled.sol`.
- `base/CDOComponent.sol` — every component (Accounting, Strategy, …) holds a back-reference to its CDO;
  `PrimeCDO.config(...)` validates it (`getCDOAddress() == address(this)`) at wire time.

**Wiring/deploy order** (dictated by the contracts, not just the script): deploy ACM proxy → deploy
`PrimeCDO`/`Accounting`/`Strategy`/cooldowns/`Tranche`×3 proxies (each `*_init(owner, acm)`) → `config(...)`
the CDO components → set silos/treasury/exit-fees/pause flags → grant the ACM role matrix → hand off
`DEFAULT_ADMIN_ROLE` to a multisig. Full table in `DEPLOYMENT.md`; per-concern modules in
`ignition/modules/parts/`.

## Project-specific conventions and gotchas

- **Upgradeable, no constructors.** Use `initialize()` + `__Contract_init()`. Storage layout is
  append-only; reserve `__gap`. No `PrimeCDO`/`Accounting` proxy is live yet, so layout-breaking changes
  are currently acceptable — but they reset the upgrade baseline, so record them in the tracker.
- **OZ 5.6.1 has no `ReentrancyGuardUpgradeable`** (and no `__UUPSUpgradeable_init`). Use the
  non-upgradeable `ReentrancyGuard` from `@openzeppelin/contracts/utils/` — proxy-safe via ERC-7201
  namespaced storage, no init call needed. This substitution recurs across many specs.
- **Custom errors only** — never `require("string")` / `revert("string")`. Errors local to a contract are
  declared at its top.
- **NatSpec must be multi-line `/** ... */`.** solc 0.8.35 rejects single-line `/** @inheritdoc X */`
  (it captures the trailing space into the contract name). Expand every `@inheritdoc` to a block.
- **`viaIR` is mandatory.** `PrimeCDO.withdraw` and `Accounting.calculateNAVSplit` overflow the stack
  without it; both build profiles set it.
- **sUSDai is ERC-7540 async** — its ERC-4626 preview methods revert by design. Read share value via
  `convertToAssets`/`convertToShares`. The `rounding` arg on `USDAStrategy.convertToAssets/convertToTokens`
  is accepted for ABI compatibility but **ignored** (7540 exposes no rounding control). The
  `Tranche`-internal `previewRedeem/previewWithdraw` overrides are unrelated — they operate at Atrium-share
  level and are fine.
- **Fork tests target Arbitrum One** and self-skip unless `FORK_TESTS=true`, `ARBITRUM_RPC_URL` is set, and
  the addresses in `test/fork/helpers/addresses.ts` are real. `hardhat.config.ts` pins Arbitrum to the
  Shanghai hardfork for historical reads and Cancun for new txs (Arbitrum headers lack blob-gas fields).
  Use the `addr(key)` accessor for all fork addresses — viem strict-checks checksums.
- **Spec-driven workflow.** Specs live in `context/features-specs/`; implement against them rather than
  inventing behavior. When a spec deviates from reality (e.g. the OZ substitution above), implement the
  working version and record the deviation in `context/progress-tracker.md`.
