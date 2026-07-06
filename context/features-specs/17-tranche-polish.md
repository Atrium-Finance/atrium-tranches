# 16b - Tranche Polish: Guards, Events, Fee Previews

## Overview

Final layer on `Tranche.sol`. Adds the mode-slippage guard, the
donation-attack protection, the rich exit event, the public quote
helpers, and the fee-aware meta-token preview views. Spec 16a
shipped the working withdraw flow — this spec hardens the surface.

Ships:

- `TRedemptionParams { exitMode, exitFee, cooldownSeconds }` struct
  on `ITranche`.
- `TExitMode.Dynamic` sentinel added to `ICDO.TExitMode`.
- `withdraw(token, ..., params)` and `redeem(token, ..., params)`
  overloads (third overload — 16a shipped the two-arg defaults).
- `validateRedemptionParams(...)` internal helper.
- `MIN_SHARES = 0.1e18` constant + `_onAfterWithdrawalChecks()`
  internal.
- `OnExit` event replacing `OnPrimeWithdraw` on the withdraw paths.
- `quoteWithdraw(assets, fee)` / `quoteRedeem(shares, fee)` external
  views.
- Fee-aware `previewWithdraw(token, ...)` / `previewRedeem(token,
...)` meta-token previews.

Out of scope:

- Multi-tranche fee policy — `cdo.calculateExitMode` already returns
  per-tranche fee.
- Per-block rate-limit on withdraws.
- Off-chain order-book / batch redemption.

---

## Architecture Decisions Recap

| #   | Decision                                      | Value                                                                                                                                                  |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `Dynamic` sentinel                            | Added to `TExitMode` enum as the **last** variant so existing storage layouts of the first three modes stay stable                                     |
| 2   | Overload count per entry                      | 3 — `(assets, ...)` ERC4626 + `(token, ..., owner)` default-Dynamic + `(token, ..., owner, params)` strict                                             |
| 3   | `MIN_SHARES` value                            | `0.1e18`. Donation-attack mitigation                                                                                                                   |
| 4   | `_onAfterWithdrawalChecks` placement          | Called after burn in `_withdraw` (ERC4626/Fee paths) and after burn in `burnSharesAsFee`                                                               |
| 5   | Skip `_onAfterWithdrawalChecks` on SharesLock | Shares transfer to silo — `totalSupply` unchanged, no check needed                                                                                     |
| 6   | First-deposit exemption                       | `totalSupply == 0` after a burn means a clean drain (the only holder withdrew everything). Allow it — `MIN_SHARES` applies only when `totalSupply > 0` |
| 7   | `OnExit` event                                | Replaces `OnPrimeWithdraw` on the withdraw paths. Carries `exitMode`, `exitFee`, `cooldownSeconds`                                                     |
| 8   | Meta-token fee previews                       | Default fee taken from `cdo.calculateExitMode(this, address(0))` — owner-unaware (consistent with 16a's `previewRedeem(shares)`)                       |

---

## Goals

- User-side mode-slippage protection.
- Donation-attack hardening.
- Richer event surface for indexers.
- Symmetric quote helpers (mirror of OZ's `preview*` with an
  explicit fee argument).
- Fee-aware previews on every meta-token entry — currently only
  non-meta previews respect the fee (16a).

---

## File Structure

```text
contracts/
├── vaults/
│   └── Tranche.sol             # amend
│
└── interfaces/
    ├── ITranche.sol            # amend — TRedemptionParams + sigs
    └── ICDO.sol                # amend — TExitMode.Dynamic
```

---

## Requirements

### 1. `ICDO.sol` — add `Dynamic`

```solidity
enum TExitMode {
    ERC4626,
    SharesLock,
    Fee,
    Dynamic       // ← NEW. Caller-side sentinel only — CDO never returns this.
}
```

`Dynamic` is appended last so on-chain enum values for the existing
three modes don't shift. Any storage or calldata holding raw enum
values (e.g., serialized `TRedemptionParams`) keeps reading the same
mode after the amend.

`cdo.calculateExitMode(...)` continues to return only `ERC4626 |
SharesLock | Fee` — never `Dynamic`. The sentinel is purely a
caller-side flag.

---

### 2. `ITranche.sol` — add struct + sigs

```solidity
/// @notice User-side guard against mode slippage between submission
///         and execution.
/// @dev    Set `exitMode = ICDO.TExitMode.Dynamic` to opt out of
///         validation entirely (defaults of `withdraw/redeem`
///         without `params`).
struct TRedemptionParams {
    ICDO.TExitMode exitMode;
    uint256 exitFee;
    uint32  cooldownSeconds;
}

error RedemptionParamsMismatch(
    TRedemptionParams requested,
    TRedemptionParams current
);
error MinSharesViolation();

function withdraw(
    address token,
    uint256 tokenAmount,
    address receiver,
    address owner,
    TRedemptionParams memory params
) external returns (uint256);

function redeem(
    address token,
    uint256 shares,
    address receiver,
    address owner,
    TRedemptionParams memory params
) external returns (uint256);

function quoteWithdraw(uint256 assetsNet, uint256 fee)
    external view returns (uint256 sharesGross);

function quoteRedeem(uint256 sharesGross, uint256 fee)
    external view returns (uint256 assetsNet);

function previewWithdraw(address token, uint256 tokenAmount)
    external view returns (uint256 sharesGross);

function previewRedeem(address token, uint256 shares)
    external view returns (uint256 tokenAssetsNet);
```

The two-arg variants from 16a stay unchanged. The new three-arg
versions are additive.

---

### 3. Storage / state additions

```solidity
/// @notice Minimum non-zero share supply. Drops below this in
///         `_onAfterWithdrawalChecks` revert as a donation-attack
///         safeguard.
uint256 private constant MIN_SHARES = 0.1 ether;
```

No new storage slot — constant.

---

### 4. `OnExit` event

```solidity
event OnExit(
    address indexed receiver,
    address indexed token,
    uint256 tokenAssets,
    uint256 shares,
    ICDO.TExitMode exitMode,
    uint256 exitFee,
    uint32  cooldownSeconds
);
```

Replaces `OnPrimeWithdraw` from 16a. Indexers get the mode metadata
per-exit without polling CDO.

---

### 5. Withdraw/redeem default overloads — re-route through new variant

The 16a `withdraw(token, amount, receiver, owner)` and
`redeem(token, shares, receiver, owner)` bodies become **thin
wrappers** that pass `TExitMode.Dynamic` as the implicit guard:

```solidity
function withdraw(address token, uint256 tokenAmount, address receiver, address owner)
    public override returns (uint256)
{
    return withdraw(
        token,
        tokenAmount,
        receiver,
        owner,
        TRedemptionParams(ICDO.TExitMode.Dynamic, 0, 0)
    );
}

function redeem(address token, uint256 shares, address receiver, address owner)
    public override returns (uint256)
{
    return redeem(
        token,
        shares,
        receiver,
        owner,
        TRedemptionParams(ICDO.TExitMode.Dynamic, 0, 0)
    );
}
```

The full bodies move into the new five-arg overloads.

---

### 6. `withdraw(token, ..., params)` strict overload

```solidity
function withdraw(
    address token,
    uint256 tokenAmount,
    address receiver,
    address owner,
    TRedemptionParams memory params
) public virtual returns (uint256 shares) {
    cdo.updateAccounting();

    (ICDO.TExitMode exitMode, uint256 exitFee, uint32 cooldownSec)
        = cdo.calculateExitMode(address(this), owner);
    _validateRedemptionParams(params, exitMode, exitFee, cooldownSec);

    uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);

    uint256 maxAssets = maxWithdraw(owner);
    if (baseAssets > maxAssets) {
        revert ERC4626ExceededMaxWithdraw(owner, baseAssets, maxAssets);
    }

    shares = _quoteWithdrawShares(baseAssets, exitFee);

    _withdraw(token, _msgSender(), receiver, owner, baseAssets, tokenAmount, shares, exitMode, exitFee, cooldownSec);
}
```

Identical to 16a's body except for the `_validateRedemptionParams`
call after `calculateExitMode`. The validation happens before any
balance reads or state changes.

---

### 7. `redeem(token, ..., params)` strict overload

```solidity
function redeem(
    address token,
    uint256 shares,
    address receiver,
    address owner,
    TRedemptionParams memory params
) public virtual returns (uint256 tokenAssets) {
    cdo.updateAccounting();

    uint256 maxShares = maxRedeem(owner);
    if (shares > maxShares) {
        revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
    }

    (ICDO.TExitMode exitMode, uint256 exitFee, uint32 cooldownSec)
        = cdo.calculateExitMode(address(this), owner);
    _validateRedemptionParams(params, exitMode, exitFee, cooldownSec);

    uint256 baseAssets = _quoteRedeemAssets(shares, exitFee);
    tokenAssets = cdo.strategy().convertToTokens(token, baseAssets, Math.Rounding.Ceil);

    _withdraw(token, _msgSender(), receiver, owner, baseAssets, tokenAssets, shares, exitMode, exitFee, cooldownSec);
}
```

---

### 8. `_validateRedemptionParams` internal

```solidity
function _validateRedemptionParams(
    TRedemptionParams memory params,
    ICDO.TExitMode exitMode,
    uint256 exitFee,
    uint32 cooldownSec
) internal pure {
    if (params.exitMode == ICDO.TExitMode.Dynamic) return;
    if (
        params.exitMode != exitMode ||
        params.exitFee != exitFee ||
        params.cooldownSeconds != cooldownSec
    ) {
        revert RedemptionParamsMismatch(
            params,
            TRedemptionParams(exitMode, exitFee, cooldownSec)
        );
    }
}
```

`pure` because the function compares only its arguments — no state
reads.

---

### 9. `_withdraw` — update event + add MIN_SHARES check

Two edits to the 16a body:

**Edit 1**: replace the `OnPrimeWithdraw` emit with `OnExit`,
extending the metadata.

```solidity
emit Withdraw(caller, receiver, owner, baseAssets, sharesGross);
emit OnExit(receiver, token, tokenAssets, sharesGross, exitMode, exitFee, cooldownSec);
```

**Edit 2**: add `_onAfterWithdrawalChecks()` after the burn in the
ERC4626/Fee branch. SharesLock branch unchanged (no burn, no
totalSupply mutation).

```solidity
if (exitMode == ICDO.TExitMode.SharesLock) {
    // ... unchanged silo path ...
    return;
}

uint256 baseAssetsGross = super.previewRedeem(sharesGross);
uint256 fee = baseAssetsGross > baseAssets ? baseAssetsGross - baseAssets : 0;

_burn(owner, sharesGross);
_onAfterWithdrawalChecks();    // ← NEW

if (fee > 0) {
    cdo.accrueFee(address(this), fee);
}

cdo.withdraw(address(this), token, tokenAssets, baseAssets, owner, receiver);

emit Withdraw(caller, receiver, owner, baseAssets, sharesGross);
emit OnExit(receiver, token, tokenAssets, sharesGross, exitMode, exitFee, cooldownSec);
```

The SharesLock branch retains its silo-side `cooldownShares` flow.
No event change there — silo emits its own `RequestedCooldown`
event (spec 11). If `OnExit` is desired for that path too, add it
inside the silo branch before `return` — Open Question.

---

### 10. `_onAfterWithdrawalChecks` internal

```solidity
function _onAfterWithdrawalChecks() internal view {
    uint256 supply = totalSupply();
    if (supply > 0 && supply < MIN_SHARES) {
        revert MinSharesViolation();
    }
}
```

`supply == 0` exemption (Decision #6): a clean drain to zero by the
last holder is OK — they took back exactly what they put in. The
attack vector is when a single dust-holder remains while reserves
inflate share price.

---

### 11. `burnSharesAsFee` — add MIN_SHARES check

Append the check after the burn:

```solidity
_burn(owner, shares);
_onAfterWithdrawalChecks();      // ← NEW
cdo.accrueFee(address(this), assets);
cdo.updateBalanceFlow();
```

---

### 12. Public quote helpers

```solidity
function quoteWithdraw(uint256 assetsNet, uint256 fee)
    public view returns (uint256 sharesGross)
{
    return _quoteWithdrawShares(assetsNet, fee);
}

function quoteRedeem(uint256 sharesGross, uint256 fee)
    public view returns (uint256 assetsNet)
{
    return _quoteRedeemAssets(sharesGross, fee);
}
```

Thin externalisations of the existing internal helpers from 16a.
Used by UI / SDK to pre-compute exact share/asset amounts for a
given `fee` without polling `calculateExitMode` twice.

---

### 13. Fee-aware meta-token previews

The 16a-shipped meta-token `previewDeposit(token, ...)` and
`previewMint(token, ...)` already match deposit-side math (no fee
on the deposit path). The new fee-aware previews are for the exit
side.

```solidity
function previewWithdraw(address token, uint256 tokenAmount)
    public view override returns (uint256 sharesGross)
{
    uint256 baseAssets = cdo.strategy().convertToAssets(token, tokenAmount, Math.Rounding.Floor);
    (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
    sharesGross = _quoteWithdrawShares(baseAssets, fee);
}

function previewRedeem(address token, uint256 shares)
    public view override returns (uint256 tokenAssetsNet)
{
    (, uint256 fee, ) = cdo.calculateExitMode(address(this), address(0));
    uint256 baseAssetsNet = _quoteRedeemAssets(shares, fee);
    tokenAssetsNet = cdo.strategy().convertToTokens(token, baseAssetsNet, Math.Rounding.Floor);
}
```

`address(0)` for the owner-unaware lookup matches the
`previewRedeem(shares)` / `previewWithdraw(assets)` convention from
16a — public quotes don't carry a silo discount.

The non-meta `previewWithdraw(uint256)` and `previewRedeem(uint256)`
from 16a stay unchanged.

---

## Notes

### Why `Dynamic` appended last in the enum

If `Dynamic` were inserted at the front (`0`), the existing modes
(`ERC4626 = 0`, `SharesLock = 1`, `Fee = 2`) would shift. Any
storage value or hash holding the integer encoding of the enum
would silently change meaning. Appending preserves the wire format.

### Why pure for `_validateRedemptionParams`

The function reads only from its arguments — no SLOAD, no callee.
Marking it `pure` makes the compiler enforce the no-state-read
property and signals to readers that the validation is fully
deterministic given the inputs.

### `_onAfterWithdrawalChecks` placement order

The check sits **after** the burn and **before** the CDO forward.
After-burn: `totalSupply` reflects the post-burn state, which is
the state we want to validate. Before-CDO-forward: if the check
reverts, no token movement happens — Strategy never gets called.
Ordering matters because Strategy and SharesCooldown both have
side effects that would be hard to roll back if reverted later.

### `supply == 0` exemption

Three cases:

| Scenario                  | `supply` after burn   | Allow?             |
| ------------------------- | --------------------- | ------------------ |
| Last holder withdraws all | 0                     | Yes — clean drain  |
| Dust holder remains       | `> 0 && < MIN_SHARES` | No — attack vector |
| Normal user, supply large | `>= MIN_SHARES`       | Yes — normal flow  |

The middle row is what `MIN_SHARES` blocks. The protocol can be
freshly re-deployed if everyone exits.

### Silo branch and `OnExit`

The current spec emits `OnExit` only on the burn-and-forward paths
(ERC4626 + Fee). For SharesLock, the silo emits its own
`RequestedCooldown`. An indexer that wants per-mode parity might
prefer `OnExit` fired on every withdraw entry — open question:
either accept the asymmetry, or move `OnExit` above the silo
branch (which exposes the silo path's existence even before the
silo finalises). Default in this spec is per-branch.

### Why `cdo.calculateExitMode(this, address(0))` for previews

`previewRedeem` / `previewWithdraw` are owner-unaware by the
ERC4626 spec — they answer "for the current public price, how many
shares/assets?". Using `address(0)` deterministically misses the
silo special-case (`owner == sharesCooldown`), so previews always
reflect the public mode (Fee, possibly SharesLock if active). A
keeper bot that does need silo-aware previews can read
`calculateExitMode(this, silo)` directly.

### Why `quoteWithdraw` / `quoteRedeem` over-expose

The internal helpers (`_quoteWithdrawShares`, `_quoteRedeemAssets`)
already exist from 16a. Wrapping them externally costs no extra
storage and lets integrators avoid duplicating the fee math in
their SDKs — they can pass a fee value from any source
(`calculateExitMode` result, a hypothetical worst-case fee, a
user-input slider) and get the corresponding shares/assets.

### Meta-token `previewWithdraw` rounding

`convertToAssets(token, ..., Floor)` matches the deposit-side
convention from spec 04 (favour protocol on conversion). The
follow-up `_quoteWithdrawShares` may round up shares to honour the
fee; that's intentional — `previewWithdraw` returns the shares the
user must burn to receive `assetsNet`, and rounding up shares keeps
the user honest.

---

## Non-Goals

- Removing the `Dynamic` sentinel from on-chain APIs (it stays as
  the default).
- Configurable `MIN_SHARES` — hardcoded constant only.
- Slippage protection on deposit (not the same attack surface).
- Multi-mode preview helpers (one mode lookup per call).
- Trimming the `OnExit` event payload — all five fields kept.

---

## Acceptance Criteria

- `ICDO.TExitMode` enum extends with `Dynamic` as the last variant.
- `ITranche` exposes `TRedemptionParams` struct,
  `RedemptionParamsMismatch` and `MinSharesViolation` errors, and
  the new function signatures from §2.
- `Tranche.sol`:
  - `MIN_SHARES = 0.1 ether` constant defined.
  - `OnExit` event defined.
  - `withdraw(token, amount, receiver, owner)` becomes a thin
    wrapper that forwards to the five-arg overload with a
    `Dynamic` `TRedemptionParams`.
  - `redeem(token, shares, receiver, owner)` likewise.
  - Five-arg `withdraw(token, ..., params)` and `redeem(token, ...,
params)` exist and call `_validateRedemptionParams` after
    `calculateExitMode`.
  - `_validateRedemptionParams(...)` matches §8.
  - `_withdraw(...)`:
    - Emits `OnExit` in place of `OnPrimeWithdraw`.
    - Calls `_onAfterWithdrawalChecks()` after burn in the
      ERC4626/Fee branch only.
  - `_onAfterWithdrawalChecks()` reverts `MinSharesViolation` when
    `totalSupply > 0 && totalSupply < MIN_SHARES`.
  - `burnSharesAsFee(...)` calls `_onAfterWithdrawalChecks()` after
    its burn.
  - `quoteWithdraw`, `quoteRedeem` external views match §12.
  - `previewWithdraw(token, ...)` and `previewRedeem(token, ...)`
    apply the public fee from `calculateExitMode(this, address(0))`.
- `OnPrimeWithdraw` event from 16a is removed.
- Compiles under solc 0.8.35.
- Existing 16a behaviour preserved on the Dynamic path — when a
  caller passes `Dynamic`, validation is a no-op and the rest of
  the body matches 16a's flow.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Move 16b to Completed. Files: `Tranche.sol`, `ITranche.sol`,
    `ICDO.sol`.
  - Architecture decisions:
    - `Dynamic` appended to the exit-mode enum; never returned by
      CDO, only consumed as a caller sentinel.
    - `MIN_SHARES = 0.1e18`, post-burn check, exemption for
      `totalSupply == 0`.
    - `OnExit` carries full mode metadata; replaces
      `OnPrimeWithdraw`.
    - Meta-token previews apply the public exit fee.
  - Open Questions:
    - Whether to emit `OnExit` also from the SharesLock branch
      (currently asymmetric).
    - Whether the first-deposit case needs an additional
      `MIN_SHARES`-floor check on `deposit` (currently only
      enforced on withdraw paths).
- End-to-end UX: a UI can fetch mode, build `TRedemptionParams`,
  submit, and have the transaction revert on mismatch — full
  slippage protection.
- Spec 15 (deployment + tests) is the next and last spec needed for
  Track A.
