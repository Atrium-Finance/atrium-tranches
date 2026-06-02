# Atrium Contracts — Audit Report

Snapshot date: 2026-06-02. Scope: every `.sol` under `contracts/`
excluding `contracts/mocks/`.

## Summary

Atrium is a 3-tranche CDO on top of USD.AI's sUSDai with a custom
Senior/Mezz/Junior waterfall, coverage-aware exits, and a pluggable
APR feed. The implementation is generally careful — `_disableInitializers()`
is pervasive, role gating is consistent, the cooldown silos use
defensible swap-pop / slot-cap patterns. The audit surfaced:

- **2 Critical** issues: deposits are never recorded on Accounting
  (deposit value gets reinterpreted as protocol yield); the wired
  `AprPairFeed` cannot be passed to `Accounting.setAprPairFeed` because
  the two interfaces (`IAPRFeed` and `IAprPairFeed`) have incompatible
  struct layouts.
- **1 High** issue: a reentrancy trap in `SharesCooldown.requestRedeem`
  if `cooldownSeconds == 0` is ever combined with a non-`ERC4626` mode.
- Several Medium / Low items: a raw `IERC20.transfer` in
  `SharesCooldown.cancel`, missing `_disableInitializers()` on
  `Tranche`, a `require` string revert in `AccessControlled` and
  `Tranche._deposit`, missing `__gap` on a handful of upgradeable
  concretes, plus dead errors / stale comments.

Build status after the comment-cleanup pass: `pnpm build` compiles
cleanly under solc `0.8.35` (only the pre-existing `at`-keyword
warnings on the cooldown interfaces remain).

---

## Part 1 — Upgradeability

Pattern shorthand:
- **UUPS** — UUPS proxy, contract owns `_authorizeUpgrade`.
- **Proxy-ready** — implementation contract for a generic proxy
  (initializer + `_disableInitializers()` in constructor), no
  in-contract upgrade hook.
- **Abstract base** — never deployed directly.

| Contract | Pattern | Initializer | __gap | Notes |
|---|---|---|---|---|
| `base/CDOComponent.sol` | Abstract base | none (`cdo` set by subclass) | `__gap[49]` (1 own slot) | clean |
| `core/Accounting.sol` | Proxy-ready | `initialize(cdo, aprPairFeed, owner, acm, aprTarget, aprBase)` | `__gap[33]` (17 own slots) | No UUPS hook — relies on the proxy framework. Constructor inherited from `AccessControlled` calls `_disableInitializers()`. |
| `core/PrimeCDO.sol` | Proxy-ready | `initialize(owner, acm)` | `__gap[42]` (13 own slots) | No UUPS hook. Storage tail documented in NatSpec. |
| `core/Strategy.sol` | Abstract base | none | none | One-line abstract; subclasses own storage. |
| `core/cooldown/CooldownBase.sol` | Abstract base | `initialize(owner, acm)` (virtual) | none | Subclasses own gap. |
| `core/cooldown/ERC20Cooldown.sol` | Proxy-ready | inherits `CooldownBase.initialize` | **missing** | Code-standards requires `__gap`; concrete leaf. |
| `core/cooldown/SharesCooldown.sol` | Proxy-ready | inherits `CooldownBase.initialize` | **missing** | Same as above. |
| `governance/AccessControlManager.sol` | UUPS | `initialize(admin)` | `__gap[50]` | `_authorizeUpgrade` gated by `DEFAULT_ADMIN_ROLE`. clean |
| `governance/AccessControlled.sol` | Abstract base | `AccessControlled_init(owner, acm)` (internal) | `__gap[48]` | Constructor calls `_disableInitializers()`. clean |
| `oracles/AprPairFeed.sol` | Proxy-ready | `initialize(owner, acm, provider, stale, desc)` | **missing** | Concrete leaf, no gap. |
| `strategies/usda/AaveAprPairProvider.sol` | Proxy-ready | `initialize(owner, acm)` | `__gap[47]` (3 own slots) | `_disableInitializers()` inherited from `AccessControlled`. clean |
| `strategies/usda/USDAStrategy.sol` | Proxy-ready | `initialize(cdo, owner, acm)` | `__gap[44]` (3 packed cooldowns) | constructor: `_disableInitializers()` via `AccessControlled`. clean |
| `vaults/Tranche.sol` | Proxy-ready | `initialize(asset, name, symbol, cdo)` | **missing** | **No constructor → no `_disableInitializers()` on the implementation.** Cosmetic on a logic contract, but standard hygiene violation. |

### Upgradeability observations

- The protocol does NOT yet pick a proxy pattern (UUPS vs Transparent)
  for `PrimeCDO` / `Accounting` / `Strategy` / silos. Only
  `AccessControlManager` declares UUPS. The other contracts are
  deployable behind any proxy because they include `_disableInitializers()`
  in their constructor inheritance chain, but no upgrade pathway is
  wired in-contract — that's an explicit deploy-time decision.
- `__gap` is missing on the four concrete leaves (`ERC20Cooldown`,
  `SharesCooldown`, `AprPairFeed`, `Tranche`). Code-standards mandates
  it on upgradeable base contracts; the spec author omitted on leaves.
  Add `uint256[50] private __gap` before any future field addition.
- `Tranche` lacks its own `constructor() { _disableInitializers(); }`.
  Cosmetic on the logic contract, but a standard hygiene rule. Fix is
  one line.

---

## Part 2 — Findings

Severity convention:
- **Critical** — funds at risk, protocol-breaking, or invariant
  violation reachable in normal operation.
- **High** — DoS, latent reentrancy, or design hole that compromises
  the protocol once a precondition flips.
- **Medium** — incorrect behaviour under specific conditions, code-
  standards violations with security implications.
- **Low / Style** — cosmetic, dead code, stale comments, naming.

### Critical

#### C-1 — Deposits are never recorded on Accounting → captured by Reserve / Mz / Jr as yield

**File:** [`contracts/core/PrimeCDO.sol:170-189`](contracts/core/PrimeCDO.sol#L170-L189)

The deposit flow is `Tranche.deposit → cdo.updateAccounting() → super.deposit → cdo.deposit(token, amount, baseAssets) → _strategy.deposit(...)`. The withdraw symmetry exists — `withdraw(...)` calls `_recordWithdraw(kind, baseAssets) → _accounting.updateBalanceFlow(0, jrOut, ...)` at [`PrimeCDO.sol:362-367`](contracts/core/PrimeCDO.sol#L362-L367) — but **deposit has no `_recordDeposit` mirror.** Accounting's `nav` is never updated for the inbound flow.

Consequence: on the very next `updateAccounting` (the next deposit / withdraw / preview-triggering action), `accounting.nav` is still the pre-deposit value while `_strategy.totalAssets()` now includes the new deposit. The positive delta is processed by `calculateNAVSplit`'s yield path:

- With **fresh state** (all tranche NAVs zero) the bootstrap branch routes the ENTIRE delta to Reserve — the depositor's shares are worth zero immediately after they deposit.
- With **existing state**, `reserveBps × delta` goes to Reserve, Senior gets target gain capped by the index ratchet, the remainder splits to Jr/Mz weighted by α. The depositor's tranche gets only a fraction of their deposit value back through the NAV update.

This is a direct funds-loss bug. It also breaks invariant #5 from `project-overview.md` ("Sum of `Y_sr + Y_mz + Y_jr + reserve_gain` equals `netGain` … no value created or destroyed").

**Fix:** add `_recordDeposit` mirror after `_strategy.deposit(...)` in `PrimeCDO.deposit`:

```solidity
function _recordDeposit(TrancheKind kind, uint256 baseAssets) internal {
    uint256 jrIn = kind == TrancheKind.JUNIOR ? baseAssets : 0;
    uint256 mzIn = kind == TrancheKind.MEZZANINE ? baseAssets : 0;
    uint256 srIn = kind == TrancheKind.SENIOR ? baseAssets : 0;
    _accounting.updateBalanceFlow(jrIn, 0, mzIn, 0, srIn, 0);
}
```

#### C-2 — `Accounting` consumes `IAPRFeed` but `AprPairFeed` implements `IAprPairFeed` — wire-format mismatch silently corrupts APRs

**Files:**
- [`contracts/core/Accounting.sol:454`](contracts/core/Accounting.sol#L454) (`aprPairFeed.latestRoundData()`)
- [`contracts/interfaces/IAPRFeed.sol`](contracts/interfaces/IAPRFeed.sol) (old struct shape consumed by Accounting)
- [`contracts/interfaces/oracles/IAprPairFeed.sol`](contracts/interfaces/oracles/IAprPairFeed.sol) (new struct shape returned by `AprPairFeed`)

`Accounting.aprPairFeed` is typed `IAPRFeed` whose `Round` is `{uint80 roundId, int64 aprTarget, int64 aprBase, uint256 updatedAt}`. The only concrete `AprPairFeed` implements `IAprPairFeed` whose `TRound` is `{int64 aprBase, int64 aprTarget, uint64 updatedAt, uint64 answeredInRound}`. The two struct ABIs encode to 4 × 32-byte words but the field positions misalign:

- `Accounting` reads `round.aprBase` from word index 2, which decodes to `AprPairFeed.updatedAt` — a unix timestamp ≈ 1.7e9 → clamped by `_normalizeAprFromFeed` to `APR_FEED_BOUNDARY_MAX = 2e12` → Senior pricing is structurally locked at 200% APR every cycle.
- `setAprPairFeed`'s `decimals() == 12` check passes (it returns a single `uint8`) so the wiring runtime-validates and silently writes the broken feed pointer.

Effect: **any deployment that wires `AprPairFeed` into `Accounting` produces incorrect Senior pricing.** Documented as "Next Up" in `progress-tracker.md`; until landed, the production wire-up is unsafe.

**Fix:** amend `Accounting` to consume `IAprPairFeed` (matching field count + order) — switch the import, retype the `aprPairFeed` storage variable, update `_fetchAprs` to read the new struct shape, and delete `IAPRFeed.sol`.

---

### High

#### H-1 — `SharesCooldown.requestRedeem` re-enters `Tranche.redeem → cdo.withdraw` when `cooldownSeconds == 0`

**File:** [`contracts/core/cooldown/SharesCooldown.sol:52-57`](contracts/core/cooldown/SharesCooldown.sol#L52-L57)

The SharesLock branch of `Tranche._withdraw` calls `cdo.cooldownShares(...)` (which carries `nonReentrant` on `PrimeCDO`), which forwards to `silo.requestRedeem(...)`. Inside `requestRedeem`, `cooldownSeconds == 0` triggers `vault.redeem(token, shares, to, address(this))` → re-enters `Tranche.redeem` → `cdo.calculateExitMode(this, silo) = (ERC4626, 0, 0)` (because owner is the silo) → `cdo.withdraw(...)` — which reverts because the outer `nonReentrant` lock from `cdo.cooldownShares` is still set.

Dead code today: `PrimeCDO.calculateExitMode` only returns `SharesLock` when `exit.sharesLock > 0`, so the SharesLock branch only fires with non-zero cooldown. **But** any external `COOLDOWN_WORKER_ROLE` grantee (test fixture, future strategy, alternative CDO) that calls `requestRedeem` with `cooldownSeconds == 0` and `fee > 0` hits the trap and DOSes the redemption — `fee > 0` first calls `_accrueFee` which calls `vault.burnSharesAsFee` (not nested under the CDO lock), and then the zero-cooldown immediate-redeem path re-enters and reverts.

**Fix options:**
- Drop the `cooldownSeconds == 0` branch in `requestRedeem` (require a positive cooldown).
- Drop the outer `nonReentrant` on `cdo.cooldownShares` (silo is trusted, but this widens the attack surface).
- Refactor the immediate-redeem to transfer shares to the recipient and emit `Finalized` without going back through the CDO.

---

### Medium

#### M-1 — `SharesCooldown.cancel` uses raw `IERC20.transfer` instead of `SafeERC20.safeTransfer`

**File:** [`contracts/core/cooldown/SharesCooldown.sol:174`](contracts/core/cooldown/SharesCooldown.sol#L174)

`IERC20(address(vault)).transfer(user, req.shares)` violates the project's "Use `SafeERC20` for ALL ERC20 transfers" rule in `context/code-standards.md`. The vault is an OZ ERC20 today so failure always reverts — but the rule exists precisely to avoid surface drift. Fix: `using SafeERC20 for IERC20;` + `IERC20(address(vault)).safeTransfer(user, req.shares);`.

#### M-2 — `Tranche` implementation contract has no `_disableInitializers()`

**File:** [`contracts/vaults/Tranche.sol:22`](contracts/vaults/Tranche.sol#L22)

Every other upgradeable contract inherits `_disableInitializers()` via `AccessControlled`'s constructor. `Tranche` inherits only `CDOComponent` + `ERC4626Upgradeable` and declares no constructor of its own. The implementation contract is therefore initialisable by anyone with arbitrary `(asset, name, symbol, cdo)` arguments. Cosmetic on a logic contract but standard hygiene.

**Fix:**

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}
```

#### M-3 — `Tranche._deposit` uses `require(..., "PrimeVaultExceededMaxWithdraw")` string revert

**File:** [`contracts/vaults/Tranche.sol:195`](contracts/vaults/Tranche.sol#L195)

Violates the project's "no string reverts — use custom errors" rule. Add `error PrimeVaultExceededMaxWithdraw(uint256 available, uint256 required);` on `ITranche` and replace the `require`.

#### M-4 — `AccessControlled.onlyTwoStepConfigManager` uses `require(..., "ConfigManagerOnly")` string revert

**File:** [`contracts/governance/AccessControlled.sol:46`](contracts/governance/AccessControlled.sol#L46)

Same code-standards violation. Convert to `error ConfigManagerOnly(address caller);`. Note: the `twoStepConfigManager` field is currently unused by any Atrium function — consider removing the field + modifier entirely.

#### M-5 — `PrimeCDO.reduceReserve` relies on sUSDai's rounding direction, which is implementation-defined under ERC-7540

**File:** [`contracts/core/PrimeCDO.sol:310-326`](contracts/core/PrimeCDO.sol#L310-L326)

`_strategy.convertToAssets(token, amount, Math.Rounding.Floor)` is documented as "Floor favours protocol", but per the ERC-7540 alignment, `USDAStrategy.convertToAssets` ignores the rounding argument and delegates to `sUSDai.convertToAssets(amount)` — whose rounding is implementation-defined. If sUSDai rounds Ceil, the reserve bucket can be over-debited. Verify USD.AI's published rounding direction; if not Floor, tighten with a min() guard or document the divergence.

#### M-6 — `AaveAprPairProvider._computeAprBase` reads APR over arbitrary keeper-controlled windows

**File:** [`contracts/strategies/usda/AaveAprPairProvider.sol:185-208`](contracts/strategies/usda/AaveAprPairProvider.sol#L185-L208)

With no minimum `dt`, a keeper calling `sampleRate()` immediately followed by `getApr()` annualises a tiny price wiggle into ±200% APR, which propagates to Senior pricing via the PULL fallback. Suggest enforcing a minimum window (e.g., return 0 when `dt < 1 hour`) instead of relying on keeper convention.

#### M-7 — `ERC20Cooldown.setCooldownDisabled` emits no event

**File:** [`contracts/core/cooldown/ERC20Cooldown.sol:108-114`](contracts/core/cooldown/ERC20Cooldown.sol#L108-L114)

The emergency-exit toggle changes user-observable behaviour but is not indexable. Add `event CooldownDisabledChanged(IERC20 indexed token, bool disabled);` to `IERC20Cooldown`.

---

### Low / Style

- **L-1 — Dead error.** [`PrimeCDO.sol:80`](contracts/core/PrimeCDO.sol#L80) declares `error WithdrawalCapReached(address tranche);` with no caller. Remove or wire a per-tranche cap.
- **L-2 — Dead error.** [`ISharesCooldown.sol:67`](contracts/interfaces/cooldown/ISharesCooldown.sol#L67) declares `error MaxRedemptionLimitReached();` with no caller.
- **L-3 — Unintuitive setter.** [`PrimeCDO.setSharesCooldown`](contracts/core/PrimeCDO.sol#L341-L347) rejects re-setting to the current value; the first call with `address(0)` (storage default) reverts. Flag in deploy script.
- **L-4 — Shadowing.** [`PrimeCDO.maxWithdraw(address tranche, address owner)`](contracts/core/PrimeCDO.sol#L297) shadows `Ownable.owner()`. Rename to `owner_`.
- **L-5 — Unused role / field.** [`AccessControlled`](contracts/governance/AccessControlled.sol) carries `PROPOSER_CONFIG_ROLE`, `UPDATER_CDO_APR_ROLE`, and `twoStepConfigManager`, none of which any Atrium function consumes. Inherited verbatim from Strata.
- **L-6 — Linear-compound index.** `Accounting._calculateTargetIndex` uses `(1 + apr × dt / YEAR)` — fine for sub-day cadence, lags continuous compound on long quiescent windows. Documented Open Question.
- **L-7 — Bootstrap fragility.** [`AaveAprPairProvider.initialize`](contracts/strategies/usda/AaveAprPairProvider.sol#L75-L86) reads `sUSDai.depositSharePrice()` at proxy init. If the live sUSDai contract reverts (e.g., the `DisabledImplementation()` seen in fork tests), the entire deploy reverts. Guarded only against `price == 0`, not against a hard revert.
- **L-8 — Implicit role-admin assumption.** `AccessControlManager.grantCall` / `revokeCall` rely on OZ's implicit `getRoleAdmin()` returning `DEFAULT_ADMIN_ROLE` for never-registered roles. A future reassignment of role-admin would shift gate semantics silently.
- **L-9 — Stale comment.** [`base/CDOComponent.sol`](contracts/base/CDOComponent.sol) had a NatSpec line on `onlyCDO` claiming "ensure cooldownDuration is zero" (copy/paste leftover). Fixed during this cleanup pass.
- **L-10 — Stale comment.** `AprPairFeed.sol` header previously said "Reports only `aprBase` — `aprTarget` is Accounting policy". After the 2026-05-30 amendment the feed reports both. Fixed during this cleanup pass.
- **L-11 — `vaultEarlyExitFeePerDay` naming.** The field is encoded per-day but consumed as `feePerDay × daysLeft` (total fee) inside `_accrueFee`. Name conflates encoding with usage.
- **L-12 — `int64` cast in revert payload.** [`AaveAprPairProvider:159`](contracts/strategies/usda/AaveAprPairProvider.sol#L159) casts `int64(int256(aprAvg))` inside `InvalidAprAvg(...)` — sign-extends garbage when `aprAvg` is large. Payload value can be wrong (though the revert still fires correctly).
- **L-13 — `at` parameter naming.** Used throughout the cooldown surfaces; will be promoted to a Solidity keyword in a future release. Rename to `evalAt` or `atTime`. Already-emitted warnings.

---

### Notes / Open questions

- The `Tranche._withdraw` SharesLock branch emits no `OnExit` event — only the silo's `RequestedCooldown`. Indexers must handle this asymmetry.
- `Tranche.previewDeposit` / `previewMint` are NOT overridden — OZ defaults read `totalAssets()` (which forwards to CDO, fine) and `totalSupply()`. No fee discounting on the deposit side; consistent with there being no entry fee.
- `Strategy.sol` is a one-line abstract: `abstract contract Strategy is AccessControlled, CDOComponent, IStrategy {}`. All work is in `USDAStrategy`. Fine.
- `IsUSDai`'s `getUnvestedAmount()` / `lastDistributionTimestamp()` declared in the progress tracker are not in the current `IsUSDai.sol`. `AaveAprPairProvider._computeAprBase` no longer consumes vesting (only `depositSharePrice`), so the rename doesn't affect production.

---

## Part 3 — Comment cleanup status

Applied the cleanup pass per the user's brief: keep `@notice` /
`@param` / `@return` for doc generation, drop multi-paragraph
`@dev` rationale, and put formulas above math functions. Density
score = pre-cleanup; column shows the result after the pass.

| Contract | Pre-cleanup density | Post-cleanup state |
|---|---|---|
| `core/Accounting.sol` | 5 | Section separators removed; formulas retained above `_applyWaterfall`, `_applyWaterfallNoSr`, `_splitResidual`, `_calculateTargetIndex`, `_calculateRiskPremiumInner`, `_updateAprSrt`, `calculateNAVSplit`. D6/D8/D9/D11/D12 references kept as shorthand for protocol decisions. |
| `core/PrimeCDO.sol` | 4 | Storage-layout NatSpec block kept (essential); per-getter `@notice` lines trimmed; formulas added to `_coverage`, `_maxSrDeposit`, `_maxWithdraw`, `_projectedCoverageAfter*`. |
| `strategies/usda/AaveAprPairProvider.sol` | 5 | `_computeAprBase`'s 25-line block reduced to formula + signedness rationale + clamping note. Other helpers carry only the formula. |
| `vaults/Tranche.sol` | 4 | Multi-paragraph `@dev` on `_withdraw` reduced to mode-branch summary. Fee-preview formulas kept above `previewRedeem` / `previewWithdraw`. Two `@inheritdoc IPrimeVault` references replaced with `@notice` (solc 0.8.35 rejects `@inheritdoc` on a transitively-inherited interface). |
| `core/cooldown/SharesCooldown.sol` | 3 | Section separators removed; `_accrueFee` and `_isCooldownActive` keep the formula / sentinel rationale. |
| `core/cooldown/ERC20Cooldown.sol` | 3 | Section separators removed; minimal trim. |
| `oracles/AprPairFeed.sol` | 3 | Section separators removed; the future-dated-round guard kept (essential WHY). Header stale comment fixed (now reports both `aprBase` and `aprTarget`). |
| `strategies/usda/USDAStrategy.sol` | 4 | Per-section separator removed; the ERC-7540 ignored-rounding caveat kept on `convertToAssets` / `convertToTokens`. |
| `governance/AccessControlManager.sol` | 3 | OZ-substitution NOTE removed. Role-encoding formula kept above `_roleFor`. |
| `governance/AccessControlled.sol` | 3 | Strata header trimmed; ReentrancyGuard substitution explained inline above the init step. |
| `core/Strategy.sol` | 5 | Reduced from 17-line file-level NatSpec to a 5-line description. |
| `base/CDOComponent.sol` | 2 | Stale `onlyCDO` NatSpec removed (was a wrong copy/paste). |
| `core/cooldown/CooldownBase.sol` | 2 | Already clean. Slot-cap constants carry inline `@dev`. |
| `interfaces/**` (12 files) | 3 | All file-level + struct-level `@dev` walls trimmed; per-method `@notice` kept; structs carry one-line summaries; verbose `@param` lists removed where param names are self-explanatory. |

### Specific stale / wrong comments fixed in this pass

- `base/CDOComponent.sol:20` — old `/// @notice ensure cooldownDuration is zero` (wrong — modifier asserts `msg.sender == cdo`) removed.
- `oracles/AprPairFeed.sol:11-12` — old `@dev` claiming "Reports only `aprBase`" replaced with current (post-2026-05-30) behaviour where both legs are reported.
- `vaults/Tranche.sol:204, 245` — two `@inheritdoc IPrimeVault` references replaced with `@notice` (solc 0.8.35 doesn't walk transitive interfaces).

### Spec author intent left in place

- `progress-tracker.md` is intentionally NOT trimmed — it's the
  protocol's running ledger and has its own audience.
- Long NatSpec on external integration surfaces (`IAavePool`, `IsUSDai`)
  is justified — integrators are the consumers.
- D6 / D8 / D9 / D11 / D12 references in `Accounting.sol` are kept as
  shorthand pointers to the protocol decisions documented in the spec
  files; they're cheap, searchable, and carry real WHY.

---

## Recommended next steps

1. **Land C-1 (deposit accounting fix).** Single-function change in
   `PrimeCDO.deposit`; mirror `_recordWithdraw`. Add an integration
   test that asserts `accounting.totalAssetsT0()` for the depositing
   tranche increases by exactly `baseAssets` post-deposit.
2. **Land C-2 (APR feed interface migration).** Switch `Accounting`
   to consume `IAprPairFeed`; delete `IAPRFeed.sol`. Already on the
   tracker's Next Up list.
3. **Land H-1 (silo zero-cooldown reentrancy).** Pick one of the
   three fixes; the simplest is to require `cooldownSeconds > 0`
   on the silo path.
4. **Sweep M-1 through M-4** (code-standards violations: `SafeERC20`,
   `_disableInitializers()`, string reverts × 2).
5. **Add `__gap[50]`** to the four concrete leaves that lack one
   before adding any future field.
