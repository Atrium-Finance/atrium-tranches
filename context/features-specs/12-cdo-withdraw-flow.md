# 12 - PrimeCDO Withdraw Flow

## Overview

Wire the full user-withdraw path through `PrimeCDO`. Spec 09 stopped
short of calling Strategy or SharesCooldown — this spec turns those
stubs into a working flow with three exit modes (`ERC4626` /
`SharesLock` / `Fee`).

Ships:

- `calculateExitMode(tranche, owner)` view.
- `withdraw(...)` body — replaces the `NotImplemented()` stub.
- `cooldownShares(...)` entry point for the silo path.
- `accrueFee(tranche, assets)` — forward to Accounting.
- `updateBalanceFlow()` no-arg + 6-arg signatures.
- Exit-fee storage and `setExitFees(...)`.
- Silo-recognition: when `owner == sharesCooldown`, Strategy is told
  to skip its own cooldown.

Out of scope:

- Accounting bodies (`accrueFee`, `updateBalanceFlow`, NAV split) —
  08b/c/d.
- Tranche-side mode routing — Tranche.sol owns that.
- Shortfall pauser — rejected (Q2).

---

## Architecture Decisions Recap

| #   | Decision                       | Value                                                                                          |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | Scope                          | Full — calculateExitMode + withdraw + cooldownShares + accrueFee + updateBalanceFlow + setters |
| 2   | Shortfall pauser               | Not implemented                                                                                |
| 3   | Exit fees storage              | Three separate fields `exitFeeJr`, `exitFeeMz`, `exitFeeSr` (1e18)                             |
| 4   | `updateBalanceFlow`            | Six-arg explicit + zero-arg overload                                                           |
| 5   | Exit modes                     | `ERC4626` / `SharesLock` / `Fee`                                                               |
| 6   | Silo recognition               | `owner_ == sharesCooldown` → `shouldSkipCooldown = true`                                       |
| 7   | Fee encoding                   | `uint256` 1e18 (`0.005e18 = 0.5%`)                                                             |
| 8   | Default fee when no silo range | Per-tranche `exitFee*` field                                                                   |

---

## Goals

- Replace `withdraw` stub with the real three-mode router.
- Add `cooldownShares` for the silo path.
- Add `calculateExitMode` view.
- Wire `accrueFee` and `updateBalanceFlow` forwards.
- Add exit-fee storage and owner-gated setter.
- Surface new methods in `ICDO`.

---

## File Structure

```text
contracts/
├── core/
│   └── PrimeCDO.sol            # amend
│
└── interfaces/
    ├── ICDO.sol                # amend — TExitMode enum + new sigs
    ├── IAccounting.sol         # amend — accrueFee + updateBalanceFlow sigs
    ├── ISharesCooldown.sol     # exists (spec 11)
    └── IStrategy.sol           # exists (spec 10)
```

---

## Requirements

### 1. `ICDO.sol` — Amendments

Add the exit-mode enum and the new signatures.

```solidity
/// @notice Routing classification for tranche withdrawals.
enum TExitMode {
    ERC4626,
    SharesLock,
    Fee
}

function calculateExitMode(address tranche, address owner)
    external view
    returns (TExitMode mode, uint256 fee, uint32 cooldownSeconds);

function cooldownShares(
    address tranche,
    address token,
    uint256 shares,
    address sender,
    address receiver,
    uint256 fee,
    uint32  cooldownSeconds
) external;

function accrueFee(address tranche, uint256 assets) external;

function updateBalanceFlow() external;
function updateBalanceFlow(
    uint256 jrIn, uint256 jrOut,
    uint256 mzIn, uint256 mzOut,
    uint256 srIn, uint256 srOut
) external;

function setExitFees(uint256 jr, uint256 mz, uint256 sr) external;

function exitFeeJr() external view returns (uint256);
function exitFeeMz() external view returns (uint256);
function exitFeeSr() external view returns (uint256);
```

`setSharesCooldown` and `sharesCooldown()` were added in spec 09'.

`IAccounting.sol` amend — declare the new signatures (bodies stay
`NotImplemented()` until 08b):

```solidity
function accrueFee(address tranche, uint256 assets) external;
function updateBalanceFlow(
    uint256 jrIn, uint256 jrOut,
    uint256 mzIn, uint256 mzOut,
    uint256 srIn, uint256 srOut
) external;
function updateBalanceFlow() external;
```

If 08a had different signatures, replace with the above.

---

### 2. Storage Additions

```solidity
/// @notice Per-tranche fallback fee when no silo range applies.
uint256 public exitFeeJr;
uint256 public exitFeeMz;
uint256 public exitFeeSr;
```

Adjacent to `sharesCooldown` (from 09'). Adjust `__gap` count
(reduce by 3).

---

### 3. New Errors and Events

```solidity
error ZeroAmount();
error WithdrawalCapReached(address tranche);
error InvalidExitFee(uint256 value);

event ExitFeesSet(uint256 jr, uint256 mz, uint256 sr);
```

---

### 4. `calculateExitMode(tranche, owner)` View

Silo-as-owner short-circuits to `ERC4626` so finalisation doesn't
re-lock. Otherwise the silo's coverage range is consulted; if no
lock is requested, fall through to the per-tranche fallback.

```solidity
function calculateExitMode(address tranche, address owner)
    external view
    returns (TExitMode mode, uint256 fee, uint32 cooldownSeconds)
{
    address silo = sharesCooldown;
    if (silo != address(0)) {
        if (owner == silo) {
            return (TExitMode.ERC4626, 0, 0);
        }

        uint256 cov = _coverage();
        ISharesCooldown.TExitParams memory exit =
            ISharesCooldown(silo).calculateExitParams(tranche, cov);

        fee = exit.feeBps;

        if (exit.sharesLock > 0) {
            return (TExitMode.SharesLock, fee, exit.sharesLock);
        }
    }

    if (fee == 0) {
        TrancheKind kind = _kindOf(tranche);
        if (kind == TrancheKind.JUNIOR) {
            fee = exitFeeJr;
        } else if (kind == TrancheKind.MEZZANINE) {
            fee = exitFeeMz;
        } else {
            fee = exitFeeSr;
        }
    }

    return (TExitMode.Fee, fee, 0);
}
```

- `_coverage()` from spec 09' — returns 1e18.
- `exit.feeBps` field name from spec 11.
- View never reverts.

---

### 5. `withdraw(...)` Body

Replaces the spec 09 stub. Pause and coverage gates already wired by
spec 09 — re-listed here for clarity of order.

```solidity
function withdraw(
    address tranche,
    address token,
    uint256 tokenAmount,
    uint256 baseAssets,
    address owner_,
    address receiver
) external override onlyTranche nonReentrant {
    if (tokenAmount == 0 || baseAssets == 0) revert ZeroAmount();

    if (!_actionsOf(msg.sender).isWithdrawEnabled) {
        revert WithdrawalsDisabled(msg.sender);
    }

    TrancheKind kind = _kindOf(msg.sender);
    if (kind != TrancheKind.SENIOR) {
        if (baseAssets > _maxWithdraw(msg.sender)) {
            revert CoverageBelowMinimum(
                _coverage(),
                _projectedCoverageAfterSubWithdraw(baseAssets)
            );
        }
    }

    // Silo finalisations skip Strategy's own cooldown — user already
    // served the lock on the SharesCooldown side.
    bool isSharesLockup = owner_ == sharesCooldown && sharesCooldown != address(0);

    _strategy.withdraw(
        msg.sender,
        token,
        tokenAmount,
        baseAssets,
        owner_,
        receiver,
        isSharesLockup
    );

    _recordWithdraw(kind, baseAssets);
}

function _recordWithdraw(TrancheKind kind, uint256 baseAssets) internal {
    uint256 jrOut = kind == TrancheKind.JUNIOR    ? baseAssets : 0;
    uint256 mzOut = kind == TrancheKind.MEZZANINE ? baseAssets : 0;
    uint256 srOut = kind == TrancheKind.SENIOR    ? baseAssets : 0;
    _accounting.updateBalanceFlow(0, jrOut, 0, mzOut, 0, srOut);
}
```

Order: pause → coverage → Strategy → Accounting.

`_strategy.withdraw` is the 7-arg overload (`shouldSkipCooldown`)
from spec 10.

`_accounting.updateBalanceFlow(...)` reverts `NotImplemented()`
until 08b — known runtime gap.

---

### 6. `cooldownShares(...)` Entry Point

Tranche transfers shares into the silo BEFORE calling this method.
CDO validates pause + silo wiring, then forwards.

```solidity
function cooldownShares(
    address tranche,
    address token,
    uint256 shares,
    address sender,
    address receiver,
    uint256 fee,
    uint32  cooldownSeconds
) external override onlyTranche nonReentrant {
    if (shares == 0) revert ZeroAmount();
    if (!_actionsOf(msg.sender).isWithdrawEnabled) {
        revert WithdrawalsDisabled(msg.sender);
    }
    if (sharesCooldown == address(0)) {
        revert SharesCooldownUnchanged();
    }

    ISharesCooldown(sharesCooldown).requestRedeem(
        ITranche(tranche),
        token,
        sender,
        receiver,
        shares,
        fee,
        cooldownSeconds
    );
}
```

Why no coverage gate here: low coverage already routes through the
silo's harshest range (longer lock, higher fee). Adding a hard gate
would block users from the protection mechanism they're using.

Why pause check here: without it, the silo can queue requests
behind the back of an active pause and finalise them later.

`SharesCooldownUnchanged` is reused from 09'. A dedicated
`SharesCooldownNotConfigured()` is an Open Question.

---

### 7. `accrueFee(tranche, assets)` Forward

```solidity
function accrueFee(address tranche, uint256 assets) external override onlyTranche {
    _accounting.accrueFee(tranche, assets);
}
```

No `tranche == msg.sender` check — Tranche is a protocol-owned
contract trusted as a unit (Open Question).

---

### 8. `updateBalanceFlow(...)` Forwards

Zero-arg for NAV-only refreshes (e.g. after `accrueFee`). Six-arg
for explicit balance deltas.

```solidity
function updateBalanceFlow() external override onlyTranche {
    _accounting.updateBalanceFlow();
}

function updateBalanceFlow(
    uint256 jrIn, uint256 jrOut,
    uint256 mzIn, uint256 mzOut,
    uint256 srIn, uint256 srOut
) external override onlyTranche {
    _accounting.updateBalanceFlow(jrIn, jrOut, mzIn, mzOut, srIn, srOut);
}
```

`onlyTranche` is conservative — tightened later if a non-Tranche
caller proves necessary (Open Question).

---

### 9. `setExitFees(jr, mz, sr)` Setter

```solidity
uint256 public constant MAX_EXIT_FEE = 0.1e18;

function setExitFees(uint256 jr, uint256 mz, uint256 sr) external onlyOwner {
    if (jr > MAX_EXIT_FEE) revert InvalidExitFee(jr);
    if (mz > MAX_EXIT_FEE) revert InvalidExitFee(mz);
    if (sr > MAX_EXIT_FEE) revert InvalidExitFee(sr);
    exitFeeJr = jr;
    exitFeeMz = mz;
    exitFeeSr = sr;
    emit ExitFeesSet(jr, mz, sr);
}
```

`MAX_EXIT_FEE` hardcoded (anti-confiscation) — consistent with
`MIN_COVERAGE` from spec 09.

---

### 10. `maxWithdraw(tranche, owner)` Update

Silo-as-owner bypasses the coverage gate and returns its own locked
balance.

```solidity
function maxWithdraw(address tranche, address owner) external view returns (uint256) {
    if (sharesCooldown != address(0) && owner == sharesCooldown) {
        return _maxWithdrawForSilo(tranche);
    }
    return _maxWithdraw(tranche);
}

function _maxWithdrawForSilo(address tranche) internal view returns (uint256) {
    address silo = sharesCooldown;
    TrancheKind kind = _kindOf(tranche);

    uint256 siloShares;
    uint256 siloAssets;
    if (kind == TrancheKind.JUNIOR) {
        siloShares = _jrVault.balanceOf(silo);
        siloAssets = _jrVault.convertToAssets(siloShares);
    } else if (kind == TrancheKind.MEZZANINE) {
        siloShares = _mezzVault.balanceOf(silo);
        siloAssets = _mezzVault.convertToAssets(siloShares);
    } else {
        siloShares = _srVault.balanceOf(silo);
        siloAssets = _srVault.convertToAssets(siloShares);
    }

    return siloAssets;
}
```

---

## Notes

### Tranche-vs-CDO split

Three withdraw modes have three different share-manipulation
patterns (burn full / burn-with-fee-split / transfer-to-silo). Only
Tranche owns shares, so mode routing lives there. CDO sees two
entry points — `withdraw` and `cooldownShares` — and applies pause

- coverage gates uniformly.

### Why infer silo from `owner_`, not pass a flag

A `bool isSiloFinalising` flag from Tranche would be lie-coordinated
— a misbehaving Tranche could fake it and skip cooldowns for normal
users. Comparing `owner_` against the CDO's own `sharesCooldown`
storage makes the recognition unforgeable.

### Runtime gap

Spec 12 compiles cleanly but `withdraw`, `accrueFee`, and
`updateBalanceFlow` all revert at the Accounting boundary. This is
intentional — Accounting bodies are owned by 08b/c/d (the yield
model). Spec 12 unblocks Track A wiring without taking a dependency
on Track B.

### `cooldownShares` no coverage gate

Coverage already steers users into the silo's worst range at low
buffer levels (long lock, high fee). A second hard gate would just
block them from the throttle that exists for that exact case.

### `MAX_EXIT_FEE = 10%`

Round number, defensible. High enough to deter exits during a
crunch, low enough that admin compromise can't convert exit fees
into outright confiscation. Bump-as-code only — consistent with
`MIN_COVERAGE`.

---

## Non-Goals

- Accounting bodies (08b/c/d).
- Tranche-side changes.
- Per-tranche-individual setters (atomic three-field only).
- Fee-retention split between tranche and reserve — Accounting's
  responsibility.
- Removal of the `sharesCooldown == address(0)` fallback.

---

## Acceptance Criteria

- `ICDO.sol` declares `TExitMode` and the new signatures.
- `IAccounting.sol` declares `accrueFee(...)` and
  `updateBalanceFlow(...)` overloads.
- `PrimeCDO.sol`:
  - Three new storage fields `exitFeeJr/Mz/Sr` after
    `sharesCooldown`. `__gap` adjusted.
  - `MAX_EXIT_FEE = 0.1e18` constant.
  - `calculateExitMode(...)` per §4.
  - `withdraw(...)` per §5.
  - `cooldownShares(...)` per §6.
  - `accrueFee(...)` per §7.
  - `updateBalanceFlow()` and 6-arg overload per §8.
  - `setExitFees(...)` per §9.
  - `maxWithdraw(tranche, owner)` per §10.
- All new functions use custom errors.
- `pnpm build` clean under solc 0.8.35.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 12 to Completed. Files: `PrimeCDO.sol`, `ICDO.sol`,
    `IAccounting.sol`.
  - Architecture decisions:
    - `TExitMode` enum on `ICDO`.
    - Silo recognition via `owner == sharesCooldown`.
    - `MAX_EXIT_FEE = 10%`.
    - Tranche routes by mode; CDO routes by gate.
  - Open Questions:
    - `accrueFee` enforce `tranche == msg.sender`?
    - `MAX_EXIT_FEE` ever made configurable?
    - Dedicated `SharesCooldownNotConfigured()` vs reused
      `SharesCooldownUnchanged`?
    - Runtime gap closed when Accounting bodies (08b/c/d) land.
- Spec 13 (reserve management) unblocked.
- Spec 15 (deployment) gains role-grant step.
