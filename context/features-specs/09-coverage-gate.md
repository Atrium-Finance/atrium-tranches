# 09 - Coverage Gates & Max Limits

## Overview

Implement coverage-based gates on `PrimeCDO` to protect existing Senior
holders from dilution and prevent excessive subordinate withdrawal that
would erode Senior buffer.

This spec ships:

- `coverage()` view — protocol-wide buffer ratio (`pool / srNav`),
  computed on `totalAssetsUnlocked()` (silo-excluded TVL).
- `MIN_COVERAGE = 1.05e18` constant.
- `totalAssetsUnlocked()` view — per-tranche TVL with shares
  parked in the `SharesCooldown` silo excluded.
- `setSharesCooldown(address)` setter — owner-gated wire/rewire of
  the silo address.
- `maxDeposit(tranche)` body — returns `0` for Senior when post-deposit
  coverage would fall below `MIN_COVERAGE`.
- `maxWithdraw(tranche)` body — returns `0` for Junior/Mezzanine when
  post-withdraw coverage would fall below `MIN_COVERAGE`. Senior
  unrestricted.
- `maxWithdraw(tranche, owner)` body — same as `maxWithdraw(tranche)`
  for now; the `owner` parameter is reserved for future SharesCooldown
  integration.
- Hard-revert gates in `deposit(...)` and `withdraw(...)` bodies — both
  view and body enforce, so UI cannot be tricked into letting users
  burn gas on doomed transactions.

Locked-share exclusion makes coverage gates predictable: a Jr/Mz
request that would push coverage below the floor is rejected at
request time (not at finalize), because parking shares in the silo
already counts as exiting from coverage perspective.

---

## Architecture Decisions Recap

| #   | Decision                 | Value                                                                                                                       |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Coverage formula         | `pool / srNav = (jrNav + mzNav + srNav) / srNav`                                                                            |
| 2   | `MIN_COVERAGE`           | `1.05e18` (5% subordinate buffer required)                                                                                  |
| 3   | Sr withdraw              | Unrestricted — withdrawing Sr increases coverage                                                                            |
| 4   | Sr deposit               | Blocked when post-deposit coverage `< 1.05`                                                                                 |
| 5   | Jr/Mz withdraw           | Blocked when post-withdraw coverage `< 1.05`. Shared buffer between Jr and Mz (race condition first-come-first-served)      |
| 6   | Logic location           | PrimeCDO. Accounting unchanged                                                                                              |
| 7   | Enforcement              | Both view (`return 0`) + body (`revert`)                                                                                    |
| 8   | Silo handling            | `totalAssetsUnlocked()` excludes shares balance held by `sharesCooldown`. Coverage uses unlocked TVL. Block at request time |
| 9   | `sharesCooldown` storage | Owner-set via `setSharesCooldown`. May be `address(0)` (fallback to raw TVL)                                                |

---

## Math

Let `jr = tvlJr`, `mz = tvlMz`, `sr = tvlSr`, `pool = jr + mz + sr`.

```
coverage = pool / sr
```

Edge case: `sr == 0` → coverage undefined. Convention: `type(uint256).max`
(infinite buffer). All gates pass.

### Sr `maxDeposit` derivation

After depositing `X` into Senior:

```
coverage_after = (pool + X) / (sr + X)
```

For `coverage_after ≥ MIN_COVERAGE`:

```
(pool + X) ≥ MIN_COVERAGE × (sr + X)
pool + X ≥ MIN_COVERAGE × sr + MIN_COVERAGE × X
pool - MIN_COVERAGE × sr ≥ (MIN_COVERAGE - 1) × X
X ≤ (pool - MIN_COVERAGE × sr) / (MIN_COVERAGE - 1)
X ≤ (jr + mz - (MIN_COVERAGE - 1) × sr) / (MIN_COVERAGE - 1)
```

With `MIN_COVERAGE = 1.05e18`, `MIN_COVERAGE - 1 = 0.05e18`:

```
maxSrDeposit = ((jr + mz) × 1e18 - sr × 0.05e18) / 0.05e18
             = (jr + mz) / 0.05 - sr
             = 20 × (jr + mz) - sr
```

(Using `1e18 / 0.05e18 = 20`.)

If `(jr + mz) × 1e18 ≤ sr × (MIN_COVERAGE - 1e18)`, current coverage
already < MIN_COVERAGE → `maxSrDeposit = 0`.

### Jr/Mz `maxWithdraw` derivation

After withdrawing `Y` from Jr or Mz combined:

```
coverage_after = (pool - Y) / sr
```

For `coverage_after ≥ MIN_COVERAGE`:

```
pool - Y ≥ MIN_COVERAGE × sr
Y ≤ pool - MIN_COVERAGE × sr
Y ≤ jr + mz - (MIN_COVERAGE - 1) × sr
Y ≤ jr + mz - 0.05 × sr
```

If `(MIN_COVERAGE - 1e18) × sr ≥ (jr + mz) × 1e18`, current coverage
already at or below MIN_COVERAGE → `maxJrMzWithdraw = 0`.

**Shared buffer**: same value returned for both Jr and Mz callers.
First-come-first-served — whichever user submits first claims the
remaining buffer.

### Sr `maxWithdraw` derivation

Sr withdraw increases coverage. No coverage block. Return
`srNav` directly.

---

## Goals

- Add `MIN_COVERAGE` constant.
- Implement `coverage()` view + `_coverage()` internal helper.
- Implement `maxDeposit(tranche)` body with Sr-coverage logic.
- Implement `maxWithdraw(tranche)` and `maxWithdraw(tranche, owner)`
  bodies with Jr/Mz coverage logic.
- Add hard-revert checks in `deposit(...)` and `withdraw(...)` bodies.
- Add new custom errors.

---

## File Structure

```text
contracts/
└── core/
    └── PrimeCDO.sol            # amend
```

No other files. No changes to interfaces (`ICDO` already declares
all three views).

---

## Requirements

### 1. Constant

```solidity
/// @notice Minimum acceptable coverage ratio: pool / srNav.
/// @dev    Encoded in 1e18 precision. 1.05e18 = 5% subordinate buffer.
uint256 public constant MIN_COVERAGE = 1.05e18;
```

Declared with other constants. Hardcoded per Q2 (immutable, no
admin override).

---

### 2. Errors

Add to existing error block:

```solidity
/**
 * @notice Thrown when a Senior deposit would drive coverage below
 *         `MIN_COVERAGE`.
 * @param  current    Current coverage (1e18 precision).
 * @param  postAction Coverage that would result from the action.
 */
error CoverageBelowMinimum(uint256 current, uint256 postAction);
```

One error covers both Sr deposit and Jr/Mz withdraw cases. The
`postAction` field tells the caller what coverage would have resulted
— useful for off-chain debugging.

---

### 3. `coverage()` View

```solidity
/// @notice Returns the current protocol coverage ratio:
///         `(jrUnlocked + mzUnlocked + srUnlocked) / srUnlocked`.
/// @dev    Encoded in 1e18 precision. Excludes shares parked in the
///         SharesCooldown silo (when wired). Returns
///         `type(uint256).max` when unlocked Senior TVL is zero.
///         Uses `accounting.totalAssetsT0()` (last-recorded TVL);
///         no fresh strategy fetch.
function coverage() external view returns (uint256) {
    return _coverage();
}

function _coverage() internal view returns (uint256) {
    (uint256 jr, uint256 mz, uint256 sr) = _totalAssetsUnlocked();
    if (sr == 0) return type(uint256).max;
    uint256 pool = jr + mz + sr;
    return pool * 1e18 / sr;
}
```

Notes:

- `_totalAssetsUnlocked()` (§4) returns `(jr, mz, sr)` already net of
  silo balance. No raw `accounting.totalAssetsT0()` access here.
- Stale by design: the Tranche-level `updateAccounting` call before
  any state-changing action refreshes TVLs upstream.
- `uint256.max` sentinel for `sr == 0` keeps all gates trivially
  passing.

---

### 4. Silo-excluded TVL helpers

Coverage and gate calculations exclude shares held by the
`SharesCooldown` silo. The silo is wired separately (see §4a); when
unset, the helper falls back to raw TVL.

```solidity
/// @notice External counterpart to `_totalAssetsUnlocked`.
function totalAssetsUnlocked() external view returns (
    uint256 jr, uint256 mz, uint256 sr
) {
    return _totalAssetsUnlocked();
}

function _totalAssetsUnlocked() internal view returns (
    uint256 jr, uint256 mz, uint256 sr
) {
    (jr, mz, sr, ) = _accounting.totalAssetsT0();
    address silo = sharesCooldown;
    if (silo == address(0)) {
        return (jr, mz, sr);
    }
    uint256 jrLocked = _jrVault.convertToAssets(_jrVault.balanceOf(silo));
    uint256 mzLocked = _mezzVault.convertToAssets(_mezzVault.balanceOf(silo));
    uint256 srLocked = _srVault.convertToAssets(_srVault.balanceOf(silo));
    jr = jr > jrLocked ? jr - jrLocked : 0;
    mz = mz > mzLocked ? mz - mzLocked : 0;
    sr = sr > srLocked ? sr - srLocked : 0;
}

function _tvls() internal view returns (uint256 jr, uint256 mz, uint256 sr) {
    return _totalAssetsUnlocked();
}
```

`_tvls()` is the single point all downstream gate helpers
(`_maxSrDeposit`, `_maxWithdraw`, `_projectedCoverageAfter*`) read
from. Centralising the silo subtraction here means every gate
inherits the correct behaviour without per-call adjustment.

`balanceOf` and `convertToAssets` are OZ ERC-4626 standard methods
already on the Tranche vaults; no new dependency.

Edge cases:

- `silo == address(0)` (not yet wired): returns raw TVL, identical
  to pre-amendment behaviour.
- `silo` balance > tranche TVL (should never happen in practice):
  saturating subtraction clamps to zero.

---

### 4a. `sharesCooldown` storage + setter

Add to existing storage block:

```solidity
/// @notice External SharesCooldown silo. May be `address(0)` —
///         `_totalAssetsUnlocked` then falls back to raw TVL.
address public sharesCooldown;
```

Adjacent to the existing `_strategy` / `_accounting` fields. Adjust
`__gap` count (reduce by one).

Add owner-gated setter:

```solidity
/// @notice Wire (or rewire) the SharesCooldown silo.
/// @dev    Owner-only. Pass `address(0)` to disable silo-aware
///         coverage entirely.
function setSharesCooldown(address sharesCooldown_) external onlyOwner {
    if (sharesCooldown_ == sharesCooldown) {
        revert SharesCooldownUnchanged();
    }
    sharesCooldown = sharesCooldown_;
    emit SharesCooldownChanged(sharesCooldown_);
}
```

Add error and event to the existing blocks:

```solidity
error SharesCooldownUnchanged();
event SharesCooldownChanged(address indexed sharesCooldown);
```

The silo address is opaque at this layer — PrimeCDO does not interact
with the silo's request-tracking surface here. That integration lives
in the withdraw-flow spec (where `cooldownShares` lands).

---

### 5. `maxDeposit(tranche)` Body

Replace the `NotImplemented()` stub.

```solidity
/**
 * @inheritdoc ICDO
 * @dev Junior and Mezzanine: unlimited (`type(uint256).max`).
 *      Senior: capped to keep coverage `≥ MIN_COVERAGE` post-deposit.
 */
function maxDeposit(address tranche) external view returns (uint256) {
    TrancheKind kind = _kindOf(tranche);
    if (kind != TrancheKind.SENIOR) {
        return type(uint256).max;
    }
    return _maxSrDeposit();
}

function _maxSrDeposit() internal view returns (uint256) {
    (uint256 jr, uint256 mz, uint256 sr) = _tvls();
    // Coverage floor in absolute units: (MIN_COVERAGE - 1e18) × sr / 1e18.
    uint256 srFloor = sr * (MIN_COVERAGE - 1e18) / 1e18;
    uint256 subordinate = jr + mz;
    if (subordinate <= srFloor) {
        // Coverage already at or below the minimum — no Sr deposit allowed.
        return 0;
    }
    uint256 headroom = subordinate - srFloor;
    // X = headroom / (MIN_COVERAGE - 1).  With MIN_COVERAGE = 1.05e18,
    // divisor = 0.05e18 → X = headroom × 1e18 / 0.05e18 = headroom × 20.
    return headroom * 1e18 / (MIN_COVERAGE - 1e18);
}
```

Notes:

- `_kindOf` reverts `InvalidTranche` for unwired addresses — already
  the right behaviour for `maxDeposit` (caller passing garbage).
- Junior and Mezzanine: unlimited — accepting more subordinate is
  always safe for coverage (raises numerator).
- Senior: cap depends on `subordinate` and `srFloor`. If
  `subordinate ≤ srFloor`, current coverage is already below the
  threshold, no further Senior deposit allowed.

---

### 6. `maxWithdraw(tranche)` and `maxWithdraw(tranche, owner)` Bodies

```solidity
/**
 * @inheritdoc ICDO
 * @dev Senior: unrestricted (withdrawing Sr increases coverage).
 *      Junior/Mezzanine: shared buffer — both see the same available
 *      amount. First-come-first-served on actual withdrawal.
 *      Per-owner limits enforced by the Tranche vault's share balance,
 *      not here.
 */
function maxWithdraw(address tranche) external view returns (uint256) {
    return _maxWithdraw(tranche);
}

function maxWithdraw(address tranche, address /*owner*/) external view returns (uint256) {
    // `owner` is reserved for future SharesCooldown integration.
    return _maxWithdraw(tranche);
}

function _maxWithdraw(address tranche) internal view returns (uint256) {
    TrancheKind kind = _kindOf(tranche);
    (uint256 jr, uint256 mz, uint256 sr) = _tvls();

    if (kind == TrancheKind.SENIOR) {
        return sr;
    }

    // Jr/Mz shared buffer:
    // maxWithdraw_combined = (jr + mz) - sr × (MIN_COVERAGE - 1) / 1e18
    uint256 srFloor = sr * (MIN_COVERAGE - 1e18) / 1e18;
    uint256 subordinate = jr + mz;
    if (subordinate <= srFloor) {
        return 0;
    }
    return subordinate - srFloor;
}
```

Notes:

- Both overloads share `_maxWithdraw` for now. The `owner` overload
  exists in `ICDO` and will diverge when SharesCooldown lands —
  redeeming through the silo lifts coverage gates.
- Sr returns its full TVL — caller's share balance limits how much
  any given user can withdraw.
- Jr and Mz both see the same combined-buffer value. If User A (Jr)
  withdraws first and consumes the buffer, User B (Mz) sees `0` on
  the next call.

---

### 7. Hard-Revert Gates in `deposit(...)`

Modify the existing `deposit` body to add Sr-coverage check **after**
the existing pause check, **before** the strategy call.

```diff
  function deposit(
      address tranche,
      address token,
      uint256 tokenAmount,
      uint256 baseAssets
  ) external override onlyTranche nonReentrant {
      tranche;
      baseAssets;

      _requireSupported(token);

      if (!_actionsOf(msg.sender).isDepositEnabled) {
          revert DepositsDisabled(msg.sender);
      }

+     if (_kindOf(msg.sender) == TrancheKind.SENIOR) {
+         if (baseAssets > _maxSrDeposit()) {
+             // Use baseAssets here, not tokenAmount. The coverage gate
+             // operates on accounting units, not raw token amounts.
+             revert CoverageBelowMinimum(_coverage(), _projectedCoverageAfterSrDeposit(baseAssets));
+         }
+     }

      _strategy.deposit(msg.sender, token, tokenAmount);
  }

  function _projectedCoverageAfterSrDeposit(uint256 amount) internal view returns (uint256) {
      (uint256 jr, uint256 mz, uint256 sr) = _tvls();
      uint256 newSr = sr + amount;
      uint256 newPool = jr + mz + newSr;
      if (newSr == 0) return type(uint256).max;
      return newPool * 1e18 / newSr;
  }
```

Notes:

- Check uses `baseAssets` (accounting units) not `tokenAmount`
  (raw token, may be alt-token like ERC4626 share).
- `_projectedCoverageAfterSrDeposit` is informational for the error;
  it makes `CoverageBelowMinimum` self-explanatory.
- Order: pause check → coverage check → strategy. Pause comes
  first (cheaper to revert) and is purely off-chain
  signal-driven (admin pause = stop everything regardless of
  coverage).

---

### 8. Hard-Revert Gates in `withdraw(...)`

Modify the existing `withdraw` stub body. Pause check stays first;
coverage check after. Body still ends with `revert NotImplemented()`
because the withdraw flow itself is deferred — but the coverage gate
is wired now so the future withdraw spec inherits it.

```diff
  function withdraw(
      address tranche,
      address token,
      uint256 tokenAmount,
      uint256 baseAssets,
      address owner_,
      address receiver
  ) external override onlyTranche {
      if (!_actionsOf(msg.sender).isWithdrawEnabled) {
          revert WithdrawalsDisabled(msg.sender);
      }

+     TrancheKind kind = _kindOf(msg.sender);
+     if (kind != TrancheKind.SENIOR) {
+         // Jr or Mz: enforce shared coverage buffer.
+         if (baseAssets > _maxWithdraw(msg.sender)) {
+             revert CoverageBelowMinimum(_coverage(), _projectedCoverageAfterSubWithdraw(baseAssets));
+         }
+     }

      tranche; token; tokenAmount; owner_; receiver;
      revert NotImplemented();
  }

  function _projectedCoverageAfterSubWithdraw(uint256 amount) internal view returns (uint256) {
      (uint256 jr, uint256 mz, uint256 sr) = _tvls();
      if (sr == 0) return type(uint256).max;
      uint256 pool = jr + mz + sr;
      uint256 newPool = pool > amount ? pool - amount : 0;
      return newPool * 1e18 / sr;
  }
```

Notes:

- `baseAssets` again, not `tokenAmount`.
- Sr withdraw: no coverage check. Caller's share balance is the
  only limit, enforced by Tranche.
- `_projectedCoverageAfterSubWithdraw` for the error message.
- The unused `tranche`, `token`, `tokenAmount`, `owner_`, `receiver`
  statements stay — silencing unused-param warnings until the
  withdraw body lands.

---

## Notes

### Why hardcode `MIN_COVERAGE`?

Per Q2. Trade-offs:

- Hardcoded: immutable; auditors verify once; no governance attack
  surface. But protocol cannot react to new market conditions
  without redeploying.
- Configurable: flexible. But governance can lower the floor and
  effectively disable the protection in an emergency.

Hardcoding at deploy is the conservative choice for an unaudited
parameter. If the protocol later wants to tune it, a parameter-update
spec can lift it to storage.

### Why shared Jr/Mz buffer?

Per Q5. Both tranches sit subordinate to Senior in the loss
waterfall — they jointly provide Senior's protection. Splitting
the buffer (e.g. "Jr gets 60%, Mz gets 40%") would require admin
config and introduce a governance attack surface. Race-condition
behaviour (first user to submit wins) is the blockchain default
and acceptable here because:

- The buffer protects Senior, not Jr/Mz specifically.
- No single user can drain the buffer in one tx without coordinated
  selling pressure.
- If Jr holders consistently win the race, the protocol can model
  the steady-state risk distribution.

### Why use `accounting.totalAssetsT0()` not `totalAssets()`?

`totalAssetsT0()` is the last-recorded TVL — no fresh strategy fetch.
`totalAssets(navT1)` would require passing the current strategy NAV,
which (a) costs more gas, (b) is unnecessary because every
state-changing entry first calls `updateAccounting` upstream
(via Tranche), so `T0` reflects the most recent state at the moment
of the check.

### Why no coverage gate for Mz deposit?

Mz deposit raises `mz`, raising numerator, raising coverage. Always
safe. Same reasoning as Jr deposit.

### Stale-snapshot caveat

`coverage()` reads `totalAssetsT0()`. If a Tranche entrypoint computes
`coverage` before the accounting refresh — e.g. an off-chain caller
viewing `coverage()` directly without first calling
`updateAccounting` — the returned value reflects whatever state was
recorded at the last protocol action. This is acceptable because:

- The values bound the protocol's most recent on-chain reality.
- Inside the deposit/withdraw flow, Tranche calls
  `cdo.updateAccounting()` before any limit check (per spec 06 / 08a).
- View-only callers (UIs) can call `accounting.updateAccounting(...)`
  via simulation/staticcall if they need fresh values.

### Silo-locked shares — request-time exclusion

Locked shares are **excluded** from coverage via `totalAssetsUnlocked`.
A Jr/Mz user parking shares in the silo for a SharesLock-mode
withdrawal removes their TVL from the buffer immediately, so:

- Coverage gate evaluates the post-lock state at **request time**.
- A request that would push coverage below `MIN_COVERAGE` reverts
  upfront (predictable UX), not at finalize.
- After lock, `srNav_unlocked` decreases when a Sr user requests —
  but Sr requests are not gated by coverage in the first place
  (Sr exits only lift coverage).
- A Mz/Jr request similarly lowers `(jr + mz)_unlocked`, which
  reduces the numerator and tightens future buffer calculations.

Locked shares still **earn yield** on the Tranche side (they remain
in the vault's `totalSupply`); the silo holds them but does not
burn them until finalisation. Coverage exclusion is purely about
the gate semantics — not about yield accrual.

When `sharesCooldown` is `address(0)` (deploy-time default until
admin wires it), `_totalAssetsUnlocked` returns raw TVL — coverage
behaves exactly as in the pre-amendment spec.

---

## Non-Goals

- Withdraw flow body (still `NotImplemented()`; only the gate is
  wired).
- `cooldownShares` entrypoint and silo interaction beyond the
  `setSharesCooldown` setter — covered in the withdraw-flow spec.
- Configurable `MIN_COVERAGE`.
- Buffer-time anti-front-run threshold (single threshold per Q1).
- Adjusting the coverage threshold over time.
- Surfacing `coverage` to UI or external indexers — `coverage()`
  is the view; off-chain consumers query directly.

---

## Acceptance Criteria

- `MIN_COVERAGE` is a `public constant uint256 = 1.05e18`.
- `sharesCooldown` storage exists, default `address(0)`.
- `setSharesCooldown(address)` is `onlyOwner`, reverts
  `SharesCooldownUnchanged` when the new value equals the current.
  Emits `SharesCooldownChanged`.
- `totalAssetsUnlocked()` external view exists; returns raw TVL
  when `sharesCooldown == address(0)`, otherwise subtracts silo
  balance × share price per tranche (saturating to zero).
- `coverage()` reads `totalAssetsUnlocked()`, returns
  `type(uint256).max` when `srUnlocked == 0`, otherwise
  `poolUnlocked × 1e18 / srUnlocked`.
- `maxDeposit(jr)` and `maxDeposit(mz)` return `type(uint256).max`.
- `maxDeposit(sr)` returns the computed cap (on unlocked TVL), `0`
  when coverage already at or below `MIN_COVERAGE`.
- `maxWithdraw(sr)` returns `srUnlocked` (full unlocked Senior TVL).
- `maxWithdraw(jr)` and `maxWithdraw(mz)` return the shared
  subordinate buffer computed from unlocked TVL, or `0` when
  exhausted.
- `maxWithdraw(tranche, owner)` returns same value as
  `maxWithdraw(tranche)` (owner unused for now).
- `deposit(...)` for Senior reverts `CoverageBelowMinimum(current,
postAction)` when `baseAssets > _maxSrDeposit()`.
- `deposit(...)` for Junior/Mezzanine is unaffected by the new gate.
- `withdraw(...)` for Junior/Mezzanine reverts `CoverageBelowMinimum`
  when `baseAssets > _maxWithdraw(msg.sender)`. After the check the
  function still ultimately reverts `NotImplemented()` (body
  deferred).
- `withdraw(...)` for Senior bypasses the coverage check (still
  reverts `NotImplemented()` for now).
- Order in `deposit` and `withdraw`: pause check → coverage check
  → next step.
- All reverts use custom errors.
- `pnpm build` clean under solc 0.8.35.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move spec to Completed with file changed (`PrimeCDO.sol`).
  - Architecture decisions:
    - `MIN_COVERAGE = 1.05e18` hardcoded.
    - Sr withdraw unrestricted; Jr/Mz shared coverage-aware buffer.
    - Coverage gate on Sr deposit + Jr/Mz withdraw, hard revert
      in body + view returns 0.
    - Coverage uses `totalAssetsUnlocked` — silo-locked shares
      excluded from the buffer.
  - Open Questions:
    - `MIN_COVERAGE` hardcoded — convert to configurable if
      market conditions demand.
    - Jr/Mz buffer race condition is currently accepted —
      revisit if a fair-split scheme is needed.
- Spec for withdraw flow body unblocked.
- Spec for SharesCooldown unblocked.
