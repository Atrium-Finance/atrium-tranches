# 08c - Accounting Loss Waterfall (Case 3 + 4 + Case 2 unification)

## Overview

Implement the negative-delta path of `calculateNAVSplit` and unify
the Case 2 (Sr funding shortfall) logic with the loss waterfall.
Both use the same cascade: Junior absorbs first, then Mezzanine,
then Senior.

Ships:

- `calculateNAVSplit` negative-delta branch (replaces the
  `NotImplemented()` revert from 08b).
- `_applyWaterfall` internal — single cascade used by both loss
  absorption and Case 2 shortfall funding.
- Case 2 rework in 08b: replace the proportional `_splitResidual`
  shortfall with the cascade.
- `delta > navT0` guard (revert).
- Events for loss absorption + Sr impairment.

Out of scope:

- Reserve participation in loss — Reserve never absorbs (D6).
- Auto-pause on impairment — Sr share price drops naturally (D7).
- Sr arrears tracking — no repayment of missed target (D8).
- AprPairFeed concrete — spec 08b'.
- Recovery / re-capitalization tooling.

---

## Architecture Decisions Recap

| #   | Decision           | Value                                                                                    |
| --- | ------------------ | ---------------------------------------------------------------------------------------- |
| D6  | Loss cascade       | Jr → Mz → Sr. **Reserve does NOT absorb loss**                                           |
| D7  | Sr impairment      | When loss exceeds Jr + Mz, Sr absorbs the remainder. No auto-pause; Sr share price falls |
| D8  | Case 2 shortfall   | Uses the same cascade (Jr first, then Mz). Replaces 08b's proportional split             |
| D9  | delta beyond navT0 | Revert `LossExceedsNav` — treat as a bug, block the update                               |
| D10 | Reserve in loss    | Untouched. Reserve = protocol revenue, not insurance                                     |
| D11 | Cascade direction  | Junior is most-subordinate (first loss), then Mezzanine, then Senior (last)              |
| D12 | Impairment event   | Emit `SeniorImpaired(lossToSr, srNavAfter)` for off-chain alerting                       |

---

## Goals

- Negative-delta loss split honoring Jr → Mz → Sr cascade.
- One `_applyWaterfall` helper for both loss and Case 2 shortfall.
- Reserve excluded from absorption.
- Sr impairment handled gracefully (no revert, no pause — just NAV
  reduction + event).
- `delta > navT0` reverts as an invariant violation.
- Invariant preserved: `navT1 == jr + mz + sr + reserve`.

---

## File Structure

```text
contracts/
├── core/
│   └── Accounting.sol          # amend — negative branch + waterfall + Case 2 rework
│
└── interfaces/
    └── IAccounting.sol         # amend — new events
```

No new files.

---

## Requirements

### 1. `_applyWaterfall` internal helper

The shared cascade. Takes the three subordinate-ordered NAVs and an
amount to remove; returns the reduced NAVs and any amount that
reached Senior.

```solidity
/// @notice Cascade an absorption amount across Jr → Mz → Sr.
/// @param  jr0 Junior NAV before.
/// @param  mz0 Mezzanine NAV before.
/// @param  sr0 Senior NAV before.
/// @param  amount The total amount to remove from the stack.
/// @return jr1 Junior NAV after.
/// @return mz1 Mezzanine NAV after.
/// @return sr1 Senior NAV after.
/// @return srHit Amount that reached Senior (0 if Jr+Mz absorbed all).
function _applyWaterfall(
    uint256 jr0,
    uint256 mz0,
    uint256 sr0,
    uint256 amount
) internal pure returns (uint256 jr1, uint256 mz1, uint256 sr1, uint256 srHit) {
    // Junior absorbs first.
    if (amount <= jr0) {
        return (jr0 - amount, mz0, sr0, 0);
    }
    uint256 remaining = amount - jr0;
    jr1 = 0;

    // Mezzanine absorbs next.
    if (remaining <= mz0) {
        return (0, mz0 - remaining, sr0, 0);
    }
    remaining -= mz0;
    mz1 = 0;

    // Senior absorbs the rest — impairment.
    if (remaining <= sr0) {
        return (0, 0, sr0 - remaining, remaining);
    }

    // remaining > sr0 — the entire stack is wiped. Caller guards
    // against this via the navT1 invariant, but defensive zero here.
    return (0, 0, 0, sr0);
}
```

Pure function. No state reads — operates entirely on its arguments.
The `srHit` return lets the caller decide whether to emit the
impairment event.

---

### 2. `calculateNAVSplit` — negative-delta branch

Replace the `NotImplemented()` revert from 08b with the loss path.

```solidity
function calculateNAVSplit(
    uint256 navT0,
    uint256 jrtNavT0,
    uint256 mzNavT0,
    uint256 srtNavT0,
    uint256 reserveNavT0,
    uint256 navT1
) public view returns (
    uint256 jrtNavT1,
    uint256 mzNavT1,
    uint256 srtNavT1,
    uint256 reserveNavT1
) {
    if (jrtNavT0 == 0 && mzNavT0 == 0 && srtNavT0 == 0 && navT1 > 0) {
        return (0, 0, 0, navT1);
    }

    int256 delta = int256(navT1) - int256(navT0);

    if (delta < 0) {
        uint256 loss = uint256(-delta);

        // D9: loss can't exceed the total NAV the tranches hold.
        // reserveNavT0 is excluded — Reserve doesn't absorb.
        uint256 absorbable = jrtNavT0 + mzNavT0 + srtNavT0;
        if (loss > absorbable) {
            revert LossExceedsNav(loss, absorbable);
        }

        (jrtNavT1, mzNavT1, srtNavT1, ) =
            _applyWaterfall(jrtNavT0, mzNavT0, srtNavT0, loss);

        // Reserve untouched.
        reserveNavT1 = reserveNavT0;

        // Invariant.
        if (navT1 != jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1) {
            revert InvalidNavSplit(navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
        }
        return (jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
    }

    // ---- positive-delta path from 08b (Case 1 + Case 2) ----
    uint256 deltaAbs = uint256(delta);

    uint256 reserveCut = 0;
    if (deltaAbs > 0 && reserveBps > 0) {
        reserveCut = deltaAbs * reserveBps / PERCENTAGE_100;
        deltaAbs -= reserveCut;
    }
    reserveNavT1 = reserveNavT0 + reserveCut;

    uint256 srtTargetIndexT1 = getSrtTargetIndexT1();
    int256 srtGainTarget = calculateGain(srtNavT0, srtTargetIndexT1, srtTargetIndex);
    if (srtGainTarget < 0) srtGainTarget = 0;
    uint256 srtGainTargetAbs = uint256(srtGainTarget);

    if (deltaAbs >= srtGainTargetAbs) {
        // Case 1: meets target
        srtNavT1 = srtNavT0 + srtGainTargetAbs;
        uint256 residual = deltaAbs - srtGainTargetAbs;
        (uint256 jrGain, uint256 mzGain) = _splitResidual(jrtNavT0, mzNavT0, residual);
        jrtNavT1 = jrtNavT0 + jrGain;
        mzNavT1 = mzNavT0 + mzGain;
    } else {
        // Case 2: drag — Sr funded by cascade through Jr → Mz (D8)
        uint256 shortfall = srtGainTargetAbs - deltaAbs;

        // Cascade the shortfall through Jr → Mz. Sr receives delta +
        // whatever the cascade frees up. If Jr+Mz can't cover the
        // full shortfall, Sr simply receives less than target (no
        // impairment — this is a gain period, just a small one).
        (uint256 jrAfter, uint256 mzAfter, , uint256 unfunded) =
            _applyWaterfallNoSr(jrtNavT0, mzNavT0, shortfall);

        uint256 srFunded = shortfall - unfunded;
        srtNavT1 = srtNavT0 + deltaAbs + srFunded;
        jrtNavT1 = jrAfter;
        mzNavT1 = mzAfter;
    }

    if (navT1 != jrtNavT1 + mzNavT1 + srtNavT1 + reserveNavT1) {
        revert InvalidNavSplit(navT1, jrtNavT1, mzNavT1, srtNavT1, reserveNavT1);
    }
}
```

---

### 3. `_applyWaterfallNoSr` internal (Case 2 helper)

Case 2 cascades through Jr → Mz only — Sr is the _recipient_, not an
absorber. If Jr+Mz can't cover the shortfall, the uncovered part is
"unfunded" and Sr just receives less.

```solidity
/// @notice Cascade through Jr → Mz only. Used for Case 2 where Sr is
///         the recipient of the freed value, not an absorber.
/// @return jr1 Junior NAV after.
/// @return mz1 Mezzanine NAV after.
/// @return mzReached Always 0 — present for signature parity.
/// @return unfunded Amount Jr+Mz could not cover.
function _applyWaterfallNoSr(
    uint256 jr0,
    uint256 mz0,
    uint256 amount
) internal pure returns (uint256 jr1, uint256 mz1, uint256 mzReached, uint256 unfunded) {
    mzReached = 0;
    if (amount <= jr0) {
        return (jr0 - amount, mz0, 0, 0);
    }
    uint256 remaining = amount - jr0;
    if (remaining <= mz0) {
        return (0, mz0 - remaining, 0, 0);
    }
    // Jr + Mz exhausted; the rest is unfunded.
    return (0, 0, 0, remaining - mz0);
}
```

Why a separate helper from `_applyWaterfall`: in Case 2 the freed
value flows _to_ Senior (a positive period), so Senior never
"absorbs". The full `_applyWaterfall` would incorrectly let the
amount eat into `sr0`. Keeping the helpers distinct prevents that
class of bug.

---

### 4. `updateAccountingInner` — impairment event

Extend the 08b `updateAccountingInner` to detect and emit when
Senior takes a hit on the loss path.

```solidity
function updateAccountingInner(uint256 navT1) internal {
    (bool aprChanged, , ) = fetchAprs();
    if (!aprChanged) {
        updateAprSrt(aprTarget, aprBase);
    }

    uint256 srtNavBefore = srtNav;

    (uint256 jrtNavT1, uint256 mzNavT1, uint256 srtNavT1, uint256 reserveNavT1)
        = calculateNAVSplit(nav, jrtNav, mzNav, srtNav, reserveNav, navT1);

    // Detect Sr impairment — only meaningful on the loss path.
    if (navT1 < nav && srtNavT1 < srtNavBefore) {
        emit SeniorImpaired(srtNavBefore - srtNavT1, srtNavT1);
    }

    updateIndex();

    nav = navT1;
    jrtNav = jrtNavT1;
    mzNav = mzNavT1;
    srtNav = srtNavT1;
    reserveNav = reserveNavT1;
}
```

Index note: on a loss, `updateIndex()` still rolls forward at the
current `aprSrt`. Sr's _target_ keeps accruing even though its NAV
dropped. This means after an impairment, Sr's future target gain is
computed off the reduced NAV — Sr doesn't "catch up" the lost
principal automatically (D8: no arrears tracking). The reduced NAV
simply earns target APR going forward.

---

### 5. New errors + events

```solidity
error LossExceedsNav(uint256 loss, uint256 absorbable);

event SeniorImpaired(uint256 lossToSenior, uint256 seniorNavAfter);
event LossAbsorbed(uint256 totalLoss, uint256 jrAbsorbed, uint256 mzAbsorbed, uint256 srAbsorbed);
```

Optionally emit `LossAbsorbed` inside the negative branch with the
per-tranche breakdown:

```solidity
emit LossAbsorbed(
    loss,
    jrtNavT0 - jrtNavT1,
    mzNavT0 - mzNavT1,
    srtNavT0 - srtNavT1
);
```

---

### 6. 08b amendment — Case 2 rework

Spec 08b's Case 2 used `_splitResidual` to spread the shortfall
proportionally (α × TVL) across Jr and Mz. Decision D8 changes this
to the cascade. The 08b `calculateNAVSplit` Case 2 branch is
replaced by the version in §2 above (`_applyWaterfallNoSr`).

When implementing, treat §2 of THIS spec as the authoritative
`calculateNAVSplit` — it supersedes the 08b body entirely (08b's
positive path is reproduced here with the Case 2 fix folded in).

The `_splitResidual` helper from 08b is still used — but only for
Case 1 gain distribution, not Case 2.

---

## Notes

### Why Reserve doesn't absorb (D6/D10)

Reserve is protocol revenue accumulated from the yield cut (5%) and
fees. Decision D6 keeps it out of the loss path entirely. Rationale:
Reserve funds operations and eventual treasury distributions;
turning it into a loss buffer would make protocol income hostage to
underlying performance. Subordinate tranches (Jr/Mz) are the
designated risk absorbers — they're compensated via leveraged
residual yield (αJr = 2.5).

Consequence: Sr impairment occurs _sooner_ than if Reserve buffered
first. The protocol accepts this — Sr's protection is the Jr+Mz
buffer plus the coverage gate (1.05×), not Reserve.

### Why Sr impairment doesn't auto-pause (D7)

When loss exceeds Jr+Mz, Sr's NAV drops. ERC4626 share price for
the Senior tranche falls accordingly. Existing Sr holders see their
shares worth less; new depositors enter at the depressed price.
This is the honest market state — pausing would freeze users out of
an accurate price and could worsen panic on unpause.

The `SeniorImpaired` event gives off-chain monitoring a signal to
alert governance, who can manually pause via `setActionStates` if
they judge it necessary. Automatic pause is intentionally NOT wired
— it removes optionality at the worst moment.

### Why two waterfall helpers

`_applyWaterfall` (Jr → Mz → Sr) is for actual losses — Sr can be an
absorber of last resort.

`_applyWaterfallNoSr` (Jr → Mz only) is for Case 2 — Sr is the
_recipient_ of freed subordinate value. Using the full waterfall
here would let the shortfall eat into Sr's own NAV, which is
backwards (Case 2 is a gain period for Sr).

Keeping them separate is a guard against a subtle sign error.

### Case 2 vs loss — same direction, different meaning

|              | Loss (delta < 0)       | Case 2 (0 ≤ delta < srTarget)   |
| ------------ | ---------------------- | ------------------------------- |
| Cascade      | Jr → Mz → Sr           | Jr → Mz (Sr receives)           |
| Jr NAV       | decreases              | decreases                       |
| Mz NAV       | decreases              | decreases                       |
| Sr NAV       | decreases (if reached) | **increases** (funded by Jr/Mz) |
| Net protocol | shrinks                | grows (small gain)              |

The cascade _direction_ is identical (subordinate absorbs first),
but in Case 2 the absorbed value is transferred up to Sr rather
than destroyed.

### D9 guard rationale

`loss > jr + mz + sr` means the Strategy reported a NAV drop larger
than the entire tranche stack. Since `nav` should always equal the
sum of tranche NAVs plus reserve, and reserve is excluded from
absorption, the only way `loss > absorbable` is a bookkeeping bug or
a Strategy mis-report. Reverting `LossExceedsNav` blocks the update
and surfaces the bug rather than silently zeroing everyone.

Note the guard uses `jr + mz + sr` (excludes reserve) — consistent
with Reserve never absorbing. If `loss` happens to be between
`absorbable` and `absorbable + reserve`, it still reverts — Reserve
is not a fallback.

### Index behavior post-impairment

After Sr is impaired, `srtTargetIndex` keeps ratcheting at `aprSrt`.
Sr's next-period target is `reducedSrNav × (newIndex/oldIndex - 1)`.
Because the NAV is smaller, the absolute target shrinks too. Sr does
NOT accrue a claim to recover the impaired principal (D8: no
arrears). The protocol treats the impairment as a permanent
repricing.

---

## Non-Goals

- Reserve-as-insurance (explicitly rejected, D6).
- Auto-pause on impairment (explicitly rejected, D7).
- Sr arrears / catch-up accrual (explicitly rejected, D8).
- Recovery or re-capitalization mechanics.
- Loss attribution events beyond `SeniorImpaired` / `LossAbsorbed`.
- Partial-Reserve absorption modes.

---

## Acceptance Criteria

- `calculateNAVSplit` negative branch cascades Jr → Mz → Sr.
- Reserve NAV unchanged on any loss.
- `loss > jr + mz + sr` reverts `LossExceedsNav`.
- Sr impairment (loss > jr + mz) reduces Sr NAV and emits
  `SeniorImpaired`.
- `_applyWaterfall` returns `jr + mz + sr` after == before − amount
  (when amount ≤ stack).
- Case 2 uses `_applyWaterfallNoSr` (cascade Jr → Mz, Sr receives).
- Case 2 with Jr+Mz insufficient leaves Sr below target (no
  impairment, no revert).
- 08b's positive path preserved; only Case 2 internals changed.
- Invariant `navT1 == jr + mz + sr + reserve` holds on all paths.
- Compiles under solc 0.8.35.

---

## Worked examples

**Loss within subordinate (Case 3)**

```
Before: jr=100, mz=300, sr=1000, reserve=50, nav=1450
navT1 = 1200, delta = -250, loss = 250
absorbable = 100+300+1000 = 1400 ≥ 250 ✓
Waterfall: Jr absorbs 100 → 0, remaining 150
           Mz absorbs 150 → 150, remaining 0
After: jr=0, mz=150, sr=1000, reserve=50, nav=1200 ✓
No SeniorImpaired event (sr unchanged).
```

**Loss reaching Senior (Case 4 — impairment)**

```
Before: jr=100, mz=300, sr=1000, reserve=50, nav=1450
navT1 = 600, delta = -850, loss = 850
absorbable = 1400 ≥ 850 ✓
Waterfall: Jr 100 → 0, remaining 750
           Mz 300 → 0, remaining 450
           Sr 1000 → 550, srHit = 450
After: jr=0, mz=0, sr=550, reserve=50, nav=600 ✓
SeniorImpaired(450, 550) emitted.
```

**Catastrophic loss (D9 revert)**

```
Before: jr=100, mz=300, sr=1000, reserve=50, nav=1450
navT1 = 30, delta = -1420, loss = 1420
absorbable = 1400 < 1420 → revert LossExceedsNav(1420, 1400)
```

**Case 2 drag with cascade**

```
Before: jr=100, mz=300, sr=1000, reserve=0, nav=1400
srTarget = 4.11, delta = +2 (after reserve cut: 1.90)
1.90 < 4.11 → Case 2
shortfall = 4.11 - 1.90 = 2.21
_applyWaterfallNoSr(100, 300, 2.21):
  2.21 ≤ 100 → jr = 97.79, mz = 300, unfunded = 0
srFunded = 2.21
sr = 1000 + 1.90 + 2.21 = 1004.11 ✓ (Sr met target)
After: jr=97.79, mz=300, sr=1004.11, reserve=0.10, nav=1402 ✓
```

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 08c to Completed.
  - Note 08b Case 2 superseded by 08c cascade version.
  - Architecture decisions:
    - Jr → Mz → Sr cascade; Reserve excluded from loss.
    - Sr impairment = NAV reduction + event, no auto-pause, no arrears.
    - Two waterfall helpers (with-Sr for loss, no-Sr for Case 2).
    - `LossExceedsNav` guard on loss > tranche stack.
  - Open questions:
    - Whether governance wants an _optional_ auto-pause hook on
      `SeniorImpaired` (off by default).
    - Whether `LossAbsorbed` event is worth the gas on every loss.
    - Whether a per-call max-loss guard (analogous to max-gain)
      should cap single-update impairment.
- Spec 08d (edge cases + max limits) is the last Track B spec.
- Runtime: with 08b + 08c, Accounting handles both gain and loss.
  Deposit/withdraw flows are fully unblocked once 08b' (feed) is
  wired or APR set manually.
