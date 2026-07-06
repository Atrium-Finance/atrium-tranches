# 16a - Tranche Withdraw + Max/Preview Overrides

## Overview

Land the withdraw side of `Tranche.sol`. Current state ships deposit

- mint paths (multi-token included) but stubs withdraw/redeem with
  `NotImplemented()`. This spec replaces the stubs with the real
  mode-routing flow and adds the `max*` / `preview*` overrides that
  forward to the CDO so gates show up correctly in ERC4626 surface.

Ships:

- `withdraw(token, amount, receiver, owner)` and
  `redeem(token, shares, receiver, owner)` token-routed entry points.
- Override of `withdraw(assets, receiver, owner)` and
  `redeem(shares, receiver, owner)` standard ERC4626 entries to
  delegate to the token-routed variants with `token = asset()`.
- Internal `_withdraw(...)` that branches on `TExitMode`:
  - `ERC4626` — burn shares, forward to CDO with zero fee.
  - `SharesLock` — transfer shares to `SharesCooldown`, forward to
    `cdo.cooldownShares(...)`.
  - `Fee` — burn shares net + fee shares, call `cdo.accrueFee(...)`
    then forward to CDO.
- `burnSharesAsFee(shares, owner)` real body.
- `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem` overrides
  forwarding to CDO gates.
- `totalAssets()` override returning `cdo.totalAssets(this)`.
- Meta-token `maxWithdraw(token, owner)` view (mirrors existing
  `maxDeposit(token, owner)` from deposit spec).
- Allowance handling: when caller ≠ owner, the caller's allowance
  is spent for the shares being burned (and reused on the silo path
  too — the cooldown silo finalises against the owner, so the
  upfront allowance spend stays correct).

Out of scope (deferred to spec 16b):

- `TRedemptionParams` guard struct and `validateRedemptionParams`.
- `quoteWithdraw` / `quoteRedeem` views.
- `OnExit` event with full mode metadata.
- `MIN_SHARES` donation-attack guard.
- `_onAfterWithdrawalChecks`.
- Meta-token `previewWithdraw(token, ...)` / `previewRedeem(token, ...)`
  with fee. The standard fee-aware `previewRedeem(shares)` /
  `previewWithdraw(assets)` does live here.

---

## Architecture Decisions Recap

| #   | Decision                                | Value                                                                                             |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Scope                                   | Tier 1 + Tier 2 (mode routing + ERC4626 surface). Tier 3-5 → 16b                                  |
| 2   | `trancheKind`                           | Deferred. CDO uses `_kindOf(address)` storage lookup                                              |
| 3   | ERC20Permit                             | Y — already inherited by Tranche; no additional work                                              |
| 4   | Standard ERC4626 entry points           | Delegate to token-routed with `token = asset()`                                                   |
| 5   | Allowance spend                         | Spent up-front in `_withdraw`, before the mode branch                                             |
| 6   | Fee calculation                         | `assets_gross > assets_net` ⇒ `fee = gross − net`. Burn `sharesGross`, fee accrues to CDO reserve |
| 7   | Default exit-mode lookup for `preview*` | `cdo.calculateExitMode(this, address(0))` — owner-unaware preview                                 |

---

## Goals

- Real bodies for the four withdraw/redeem overloads.
- Real body for `burnSharesAsFee`.
- Max/preview overrides match the CDO's gate semantics.
- Compile-clean against the existing `ICDO` and `IStrategy`
  surfaces (specs 09', 10, 12).

---

## File Structure

```text
contracts/
├── vaults/
│   └── Tranche.sol             # amend — replace stubs, add overrides
│
└── interfaces/
    └── ITranche.sol            # amend — declare new external sigs
```

No new files.

---

## Requirements

### 1. `ITranche.sol` — amend

Append the new external signatures.

```solidity
// Multi-token withdraw/redeem.
function withdraw(address token, uint256 tokenAmount, address receiver, address owner)
    external returns (uint256);

function redeem(address token, uint256 shares, address receiver, address owner)
    external returns (uint256);

// Burn shares as fee — permissionless caller.
function burnSharesAsFee(uint256 shares, address owner) external returns (uint256 assets);

// Meta-token max view.
function maxWithdraw(address token, address owner) external view returns (uint256);
```

Existing signatures stay. Standard ERC4626 entry points
(`withdraw(uint256, address, address)`, `redeem(uint256, address,
address)`) are inherited from `IERC4626` — no re-declaration needed
in `ITranche`.

---

### 2. Storage / state additions

None. Spec 16a uses only inherited state (`cdo` from `CDOComponent`,
ERC4626's `_asset`).

---

### 3. New errors and events

```solidity
event OnPrimeWithdraw(address indexed receiver, address indexed token, uint256 tokenAssets, uint256 shares);
```

`OnExit` with mode metadata is 16b. `OnPrimeWithdraw` mirrors the
existing `OnPrimeDeposit` so indexers have parity on the meta-token
path. Standard ERC4626 `Withdraw` event still fires from OZ.

---

### 4. `totalAssets()` override

```solidity
function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
    return cdo.totalAssets(address(this));
}
```

Replaces OZ's default (which reads internal balance). The Tranche
doesn't actually hold the deposited assets — Strategy does. CDO is
the source of truth.

---

### 5. `maxDeposit` / `maxMint` overrides

```solidity
function maxDeposit(address) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
    return cdo.maxDeposit(address(this));
}

function maxMint(address) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
    uint256 assets = cdo.maxDeposit(address(this));
    if (assets == type(uint256).max) return type(uint256).max;
    return convertToShares(assets);
}
```

`cdo.maxDeposit(tranche)` already enforces the coverage gate (spec
09). `maxMint` translates the asset cap into a share cap with a
sentinel passthrough for `uint256.max`.

---

### 6. `maxWithdraw` / `maxRedeem` overrides

```solidity
function maxWithdraw(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
    return cdo.maxWithdraw(address(this), owner);
}

function maxRedeem(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
    uint256 assets = cdo.maxWithdraw(address(this), owner);
    return convertToShares(assets);
}

function maxWithdraw(address token, address owner) public view returns (uint256) {
    uint256 baseAssets = cdo.maxWithdraw(address(this), owner);
    return cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);
}
```

`cdo.maxWithdraw(tranche, owner)` (spec 12 §10) returns full
unlocked balance for the silo when `owner == sharesCooldown`, and
coverage-gated buffer for Jr/Mz, full TVL for Sr. `maxRedeem`
converts to shares via the standard ERC4626 path.

---

### 7. Fee-aware `previewRedeem` / `previewWithdraw`

These call `calculateExitMode` to discover the current fee, then
adjust the standard preview accordingly.

```solidity
function previewRedeem(uint256 sharesGross)
    public view override(ERC4626Upgradeable, IERC4626) returns (uint256 assetsNet)
{
    (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
    if (fee == 0) return super.previewRedeem(sharesGross);
    uint256 sharesFee = Math.mulDiv(sharesGross, fee, 1e18, Math.Rounding.Floor);
    assetsNet = super.previewRedeem(sharesGross - sharesFee);
}

function previewWithdraw(uint256 assetsNet)
    public view override(ERC4626Upgradeable, IERC4626) returns (uint256 sharesGross)
{
    (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
    if (fee == 0) return super.previewWithdraw(assetsNet);
    uint256 sharesNet = super.previewWithdraw(assetsNet);
    // sharesGross = sharesNet / (1 − fee) = sharesNet + sharesNet × fee / (1e18 − fee)
    uint256 sharesFee = Math.mulDiv(sharesNet, fee, 1e18 - fee, Math.Rounding.Floor);
    sharesGross = sharesNet + sharesFee;
}
```

`calculateExitMode(this, address(0))`:

- `owner = address(0)` → the silo special-case in §4 of spec 12
  doesn't fire; the path returns either `SharesLock` (with fee +
  cooldown) or `Fee` (with per-tranche fallback fee).
- The view is owner-unaware by design — preview values are a public
  quote, not a per-user calculation.

---

### 8. Standard `withdraw(assets, receiver, owner)` override

Delegate to the token-routed flow with `token = asset()`.

```solidity
function withdraw(uint256 assets, address receiver, address owner)
    public override(ERC4626Upgradeable, IERC4626) returns (uint256)
{
    return withdraw(asset(), assets, receiver, owner);
}
```

This replaces the existing implementation that calls
`super.withdraw(...)` directly — that path bypasses mode routing.

---

### 9. `withdraw(token, tokenAmount, receiver, owner)` token-routed

```solidity
function withdraw(address token, uint256 tokenAmount, address receiver, address owner)
    public virtual returns (uint256 shares)
{
    cdo.updateAccounting();

    (ICDO.TExitMode exitMode, uint256 exitFee, uint32 cooldownSec)
        = cdo.calculateExitMode(address(this), owner);

    uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);

    uint256 maxAssets = maxWithdraw(owner);
    if (baseAssets > maxAssets) {
        revert ERC4626ExceededMaxWithdraw(owner, baseAssets, maxAssets);
    }

    shares = _quoteWithdrawShares(baseAssets, exitFee);

    _withdraw(token, _msgSender(), receiver, owner, baseAssets, tokenAmount, shares, exitMode, exitFee, cooldownSec);
}
```

`_quoteWithdrawShares(assetsNet, fee)` is the internal helper used
by both `withdraw` and `previewWithdraw`.

```solidity
function _quoteWithdrawShares(uint256 assetsNet, uint256 fee) internal view returns (uint256 sharesGross) {
    uint256 sharesNet = super.previewWithdraw(assetsNet);
    if (fee == 0) return sharesNet;
    uint256 sharesFee = Math.mulDiv(sharesNet, fee, 1e18 - fee, Math.Rounding.Floor);
    sharesGross = sharesNet + sharesFee;
}
```

---

### 10. Standard `redeem(shares, receiver, owner)` override

```solidity
function redeem(uint256 shares, address receiver, address owner)
    public override(ERC4626Upgradeable, IERC4626) returns (uint256)
{
    return redeem(asset(), shares, receiver, owner);
}
```

---

### 11. `redeem(token, shares, receiver, owner)` token-routed

```solidity
function redeem(address token, uint256 shares, address receiver, address owner)
    public virtual returns (uint256 tokenAssets)
{
    cdo.updateAccounting();

    uint256 maxShares = maxRedeem(owner);
    if (shares > maxShares) {
        revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
    }

    (ICDO.TExitMode exitMode, uint256 exitFee, uint32 cooldownSec)
        = cdo.calculateExitMode(address(this), owner);

    uint256 baseAssets = _quoteRedeemAssets(shares, exitFee);
    tokenAssets = cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);

    _withdraw(token, _msgSender(), receiver, owner, baseAssets, tokenAssets, shares, exitMode, exitFee, cooldownSec);
}

function _quoteRedeemAssets(uint256 sharesGross, uint256 fee) internal view returns (uint256 assetsNet) {
    if (fee == 0) return super.previewRedeem(sharesGross);
    uint256 sharesFee = Math.mulDiv(sharesGross, fee, 1e18, Math.Rounding.Floor);
    assetsNet = super.previewRedeem(sharesGross - sharesFee);
}
```

---

### 12. Internal `_withdraw` — mode router

Order: spend allowance → emit shared event → branch by mode.

```solidity
function _withdraw(
    address token,
    address caller,
    address receiver,
    address owner,
    uint256 baseAssets,
    uint256 tokenAssets,
    uint256 sharesGross,
    ICDO.TExitMode exitMode,
    uint256 exitFee,
    uint32 cooldownSec
) internal virtual {
    if (caller != owner) {
        _spendAllowance(owner, caller, sharesGross);
    }

    if (exitMode == ICDO.TExitMode.SharesLock) {
        // Move shares into the silo; silo finalises on behalf of the
        // owner after cooldown. We don't burn here — silo redeems
        // via Tranche later, which burns then.
        address silo = address(cdo.sharesCooldown());
        _transfer(owner, silo, sharesGross);

        // Recognise external receiver for the silo's slot accounting.
        address initialFrom =
            (caller == receiver || owner == receiver) ? receiver : owner;

        cdo.cooldownShares(
            address(this),
            token,
            sharesGross,
            initialFrom,
            receiver,
            exitFee,
            cooldownSec
        );
        return;
    }

    // ERC4626 + Fee paths share the burn + forward path. Fee path
    // additionally accrues fee against the reserve. Fee here is the
    // base-asset delta between gross and net (computed by the quote
    // helpers as: gross = net + fee).
    uint256 baseAssetsGross = super.previewRedeem(sharesGross);
    uint256 fee = baseAssetsGross > baseAssets ? baseAssetsGross - baseAssets : 0;

    _burn(owner, sharesGross);

    if (fee > 0) {
        cdo.accrueFee(address(this), fee);
    }

    cdo.withdraw(address(this), token, tokenAssets, baseAssets, owner, receiver);

    emit Withdraw(caller, receiver, owner, baseAssets, sharesGross);
    emit OnPrimeWithdraw(receiver, token, tokenAssets, sharesGross);
}
```

Notes on the body:

- `_transfer(owner, silo, sharesGross)` — not a burn. Shares
  continue accruing yield to the silo balance during cooldown.
- Silo branch returns early — emits its own events via the silo and
  the `cdo.cooldownShares` forward.
- `super.previewRedeem(sharesGross)` is the **fee-free** OZ
  conversion. `baseAssets` is the user-receivable net. The delta is
  what the protocol keeps as fee.
- The fee path passes `baseAssets` (net) to `cdo.withdraw(...)` —
  Strategy releases exactly the net amount; the burned fee shares
  represent baseAssets that **stay** in Strategy and are credited to
  the reserve via `accrueFee`.

---

### 13. `burnSharesAsFee(shares, owner)` real body

```solidity
function burnSharesAsFee(uint256 shares, address owner) external returns (uint256 assets) {
    cdo.updateAccounting();

    address caller = _msgSender();
    if (caller != owner) {
        _spendAllowance(owner, caller, shares);
    }

    uint256 maxShares = maxRedeem(owner);
    if (shares > maxShares) {
        revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
    }

    assets = convertToShares(shares) > 0 ? super.previewRedeem(shares) : 0;
    _burn(owner, shares);
    cdo.accrueFee(address(this), assets);
    cdo.updateBalanceFlow();
}
```

Why `super.previewRedeem` instead of the local fee-aware preview:
this entry point IS the fee accrual; treating its output through
another fee-discount would double-charge.

`cdo.updateBalanceFlow()` is the zero-arg variant (spec 12 §8) — it
refreshes Accounting after the NAV-only change of moving assets
between the tranche and reserve buckets.

`_onAfterWithdrawalChecks()` is intentionally absent here. Spec 16b
adds `MIN_SHARES` and wires the check on both `_withdraw` and
`burnSharesAsFee`.

---

## Notes

### Why standard ERC4626 entries delegate to token-routed

The CDO's `calculateExitMode` is owner-aware (silo recognition,
fallback fee). To honour the mode in every entry point, all
withdraw paths must converge on `_withdraw`. Calling
`super.withdraw(...)` directly skips that — that's exactly the bug
in the current pre-spec-16a implementation.

### Why the owner-unaware preview defaults to no-silo case

`calculateExitMode(this, address(0))` won't match the silo
short-circuit (`owner == sharesCooldown`), so the preview reflects
the **public** mode (SharesLock if active, otherwise Fee with the
tranche fallback). Quoting a silo-discounted price to the public
would mislead — only the silo itself gets that price.

### Allowance spend up-front

`_spendAllowance(owner, caller, sharesGross)` runs before the mode
branch. For SharesLock, the silo finalises on behalf of the recipient
(the silo emits the burn-and-release later). Spending the caller's
allowance now means the silo can't be tricked into finalising with a
stale or revoked allowance.

### Fee math reconciliation

For Fee mode:

- User wants `assetsNet` (or burns `sharesGross` and expects
  `assetsNet` back).
- `sharesGross = sharesNet / (1 - fee)` from the quote.
- Net delta to Strategy: `baseAssets = assetsNet`.
- Fee that stays as reserve: `super.previewRedeem(sharesGross) - assetsNet`.

The `baseAssetsGross > baseAssets ? baseAssetsGross - baseAssets : 0`
guard in `_withdraw` is defensive — in practice `>` is always true
when fee > 0; the equality branch returns 0 for fee == 0
deployments.

### Why `previewRedeem` for the gross-asset calculation

`super.previewRedeem(sharesGross)` uses ERC4626's underlying-balance
math, which now routes through the `totalAssets()` override
(`cdo.totalAssets(this)`). So the value is the same number Strategy
would release if no fee applied. Subtracting `assetsNet` gives us
exactly the fee in base-asset units.

### `convertToShares(shares) > 0` guard on `burnSharesAsFee`

Edge: if Tranche total supply collapses to zero due to a previous
burn, calling `burnSharesAsFee(1, ...)` could trigger a division-
by-zero in ERC4626's converter. The guard returns `assets = 0` and
lets the function complete without forwarding to Accounting.
Defensive against extreme test edge cases. Open Question — may be
removable.

### `maxRedeem(silo) → silo balance`

`maxRedeem(owner)` calls `cdo.maxWithdraw(this, owner)`, which (per
spec 12 §10) returns the silo's unlocked balance when
`owner == sharesCooldown`. Converted to shares, this lets the silo
redeem its own holdings via the standard ERC4626 path during
finalise — `silo → Tranche.redeem(token, shares, ..., owner=silo)`.

---

## Non-Goals

- `TRedemptionParams` validation (16b).
- `quoteWithdraw` / `quoteRedeem` external views (16b).
- `OnExit` event (16b).
- `MIN_SHARES` guard (16b).
- Meta-token `previewWithdraw(token, ...)` /
  `previewRedeem(token, ...)` with fee (16b).
- `previewDeposit(token, ...)` / `previewMint(token, ...)` —
  already exist from spec 04 (deposit foundation).

---

## Acceptance Criteria

- `ITranche` declares the four new external sigs (§1).
- `Tranche.sol`:
  - `totalAssets()` returns `cdo.totalAssets(this)`.
  - `maxDeposit(address)` and `maxMint(address)` forward to CDO.
  - `maxWithdraw(address)` and `maxRedeem(address)` forward to CDO.
  - `maxWithdraw(address token, address owner)` meta-view exists.
  - `previewRedeem(uint256)` and `previewWithdraw(uint256)` apply
    the public fee from `calculateExitMode(this, address(0))`.
  - Standard `withdraw(assets, receiver, owner)` and
    `redeem(shares, receiver, owner)` delegate to token-routed
    variants with `token = asset()`. Existing `super.withdraw` /
    `super.redeem` direct calls removed.
  - `withdraw(token, ...)` and `redeem(token, ...)` token-routed
    bodies match §9 and §11.
  - `_withdraw(...)` internal matches §12.
  - `burnSharesAsFee(...)` matches §13.
  - `OnPrimeWithdraw` event fires on the non-SharesLock paths.
  - `NotImplemented()` reverts in the previous stubs are removed.
- Compiles under solc 0.8.35.
- `cdo.updateAccounting()` is called at the top of every public
  state-changing entry (deposit, mint, withdraw, redeem,
  burnSharesAsFee).

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 16a to Completed. Files: `Tranche.sol`, `ITranche.sol`.
  - Architecture decisions:
    - All withdraw entries converge on `_withdraw` with explicit
      `(exitMode, exitFee, cooldownSec)` payload.
    - Standard ERC4626 entries delegate to token-routed flow with
      `token = asset()`.
    - Silo branch transfers shares (not burn); silo redeems via
      standard ERC4626 path on finalise.
    - Public preview/quote uses `calculateExitMode(this, address(0))`.
  - Open Questions:
    - Whether `convertToShares(shares) > 0` defensive guard in
      `burnSharesAsFee` is necessary.
    - Whether `maxRedeem(owner)` should fall back to the local
      ERC4626 calculation when CDO returns zero (avoids accidental
      lockout if a CDO read fails on a fresh deploy).
- Spec 16b unblocked (TRedemptionParams + MIN_SHARES + OnExit +
  meta-token fee previews + after-withdrawal invariants).
- End-to-end deposit + withdraw can be tested in spec 15 — silo
  - Fee + ERC4626 modes all reachable from the public surface.
