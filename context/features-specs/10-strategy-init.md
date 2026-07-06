# 10 - Strategy Skeleton & `IStrategy` Expansion

## Overview

Establish the Strategy foundation: full `IStrategy` interface plus an
**empty abstract** `Strategy.sol` that concrete strategies extend.

This spec ships:

- Expanded `IStrategy` interface — final signatures for deposit,
  withdraw (with overload for cooldown-skip), `reduceReserve`,
  `convertToAssets`/`convertToTokens`, `totalAssets`,
  `getSupportedTokens`.
- `Strategy.sol` — empty abstract `is IStrategy, CDOComponent`. No
  storage, no helpers. Concrete strategies own everything else.
- `IERC20Cooldown` interface — the silo used by concrete strategies
  to release shares with an optional cooldown.

What this spec does NOT do:

- Implement any concrete strategy (e.g. `UsdaiStrategy.sol`).
- Implement `ERC20Cooldown.sol` (the silo contract). Interface only.
- Implement `UnstakeCooldown` — Atrium does not invoke USDai's
  protocol-level redeem. `IUnstakeCooldown` is intentionally
  **omitted** from this codebase.
- Wire `Strategy` into deployment.

---

## Architecture Decisions Recap

| #   | Decision                  | Value                                                                                                           |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Abstract `Strategy.sol`   | Empty (`is IStrategy, CDOComponent`). No storage, no init, no helpers                                           |
| 2   | Deposit flow              | 2-hop. Tranche pulls from user via `super._deposit`, then Strategy pulls from Tranche. `owner = tranche`        |
| 3   | Withdraw output (v1)      | sUSDai only — Atrium does not redeem to USDai. Future v2 may expand                                             |
| 4   | Cooldown infrastructure   | `ERC20Cooldown` silo for share lockup. No `UnstakeCooldown` (no underlying-protocol redeem call)                |
| 5   | `withdraw` overload       | Two signatures (with/without `shouldSkipCooldown`) — matches future SharesCooldown integration                  |
| 6   | Base asset / alternatives | USDai (base) + sUSDai (ERC-4626 alternative). Concrete contracts declare both as `IERC20`/`IERC4626` immutables |
| 7   | Token-list registry       | `getSupportedTokens()` returns `IERC20[]` — concrete builds the array on-demand                                 |

---

## Goals

- Define final `IStrategy` interface — no signature changes expected
  after this spec.
- Define `IERC20Cooldown` interface so concrete strategies have a
  typed dependency.
- Land empty `Strategy.sol` abstract that compiles and slots into the
  CDO component tree.

---

## File Structure

```text
contracts/
├── core/
│   └── Strategy.sol                        # NEW — empty abstract
│
└── interfaces/
    ├── IStrategy.sol                       # amend (expand)
    └── cooldown/
        ├── ICooldown.sol                   # NEW — base cooldown interface
        └── IERC20Cooldown.sol              # NEW — ERC20Cooldown silo interface
```

The two cooldown interface files are split per concern: `ICooldown`
holds the shared types (events, errors, balance struct, `finalize`,
`balanceOf`); `IERC20Cooldown` extends it with the transfer entry
point used by Strategy.

---

## Requirements

### 1. `interfaces/cooldown/ICooldown.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  ICooldown
/// @notice Shared base for cooldown silo contracts. Defines the balance
///         shape exposed to viewers and the finalisation entry points
///         shared between every concrete cooldown variant.
interface ICooldown {
    /// @dev Aggregate view of a user's silo state for a given token.
    struct TBalanceState {
        uint256 pending;
        uint256 claimable;
        uint256 nextUnlockAt;
        uint256 nextUnlockAmount;
        uint256 totalRequests;
    }

    event TransferRequested(
        IERC20 indexed token,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 unlockAt
    );
    event Finalized(IERC20 indexed token, address indexed user, uint256 amount);

    error InvalidTime();
    error UnsupportedToken(address token);
    error NothingToFinalize();
    error ExternalReceiverRequestLimitReached(
        IERC20 token,
        address from,
        address to,
        uint256 amount
    );

    function finalize(IERC20 token, address user) external returns (uint256 claimed);
    function finalize(IERC20 token, address user, uint256 at) external returns (uint256 claimed);

    function balanceOf(IERC20 token, address user) external view returns (TBalanceState memory);
    function balanceOf(IERC20 token, address user, uint256 at) external view returns (TBalanceState memory);
}
```

### 2. `interfaces/cooldown/IERC20Cooldown.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICooldown } from "./ICooldown.sol";

/// @title  IERC20Cooldown
/// @notice Silo that locks generic ERC-20 tokens for a configurable
///         cooldown period before they can be released to the user.
///         Used by Strategy contracts when releasing sUSDai shares
///         on withdrawal.
interface IERC20Cooldown is ICooldown {
    /// @notice Transfer `amount` of `token` from the caller into the
    ///         silo on behalf of `initialFrom`, recording a lockup
    ///         until `block.timestamp + cooldownSeconds`. After the
    ///         lock expires, the recipient `to` finalises via
    ///         {ICooldown.finalize} to claim the tokens.
    /// @dev    Caller must hold `COOLDOWN_WORKER_ROLE`. When
    ///         `cooldownSeconds == 0`, the silo immediately forwards
    ///         the tokens to `to` (no lockup, no record).
    function transfer(
        IERC20 token,
        address initialFrom,
        address to,
        uint256 amount,
        uint256 cooldownSeconds
    ) external;

    /// @notice Toggle cooldown enforcement for a token. When disabled,
    ///         pending requests finalise immediately regardless of
    ///         their recorded `unlockAt`.
    /// @dev    Emergency-exit switch. Callable by
    ///         `COOLDOWN_WORKER_ROLE` so Strategy can lift the lock
    ///         when its own cooldown configuration is set to zero.
    function setCooldownDisabled(IERC20 token, bool isCooldownDisabled) external;
}
```

### 3. Expand `IStrategy.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICDOComponent } from "./ICDOComponent.sol";

/// @title  IStrategy
/// @notice Investment strategy that holds protocol funds, converts
///         between accepted tokens and the base asset, and reports
///         total assets in base-asset units.
/// @dev    Concrete implementations declare their own supported-token
///         registry; this interface does not impose a base-asset
///         distinction at the type level.
interface IStrategy is ICDOComponent {
    // ---------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------

    /// @notice Pull `tokenAmount` of `token` from `owner` and integrate
    ///         it into the strategy's holdings.
    /// @dev    Caller must be the CDO (`onlyCDO` in the concrete
    ///         implementation). `owner` is the source of the
    ///         allowance — typically the Tranche vault (CDO passes
    ///         the tranche address through). `baseAssets` is the
    ///         pre-computed base-asset equivalent provided by the
    ///         CDO for accounting purposes; the strategy may use it
    ///         or recompute via {convertToAssets}.
    /// @param  tranche     The tranche initiating the deposit
    ///                     (informational).
    /// @param  token       The deposited token. Must be supported.
    /// @param  tokenAmount The amount of `token` to pull from `owner`.
    /// @param  baseAssets  The base-asset equivalent of the deposit.
    /// @param  owner       The source of the pull. The strategy
    ///                     executes
    ///                     `safeTransferFrom(token, owner, this, tokenAmount)`.
    /// @return The amount of base assets credited.
    function deposit(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address owner
    ) external returns (uint256);

    // ---------------------------------------------------------------
    // Withdraw (2 overloads)
    // ---------------------------------------------------------------

    /// @notice Release holdings to `receiver` denominated in `token`.
    ///         Defaults to applying the strategy's configured
    ///         cooldown.
    /// @dev    Caller must be the CDO. Returns the amount of `token`
    ///         released (which may be shares of an ERC-4626 wrapper).
    /// @param  tranche     The tranche initiating the withdrawal.
    /// @param  token       The output token. Must be supported.
    /// @param  tokenAmount The amount of `token` requested
    ///                     (informational; strategy may recompute
    ///                     via `convertToTokens(baseAssets)`).
    /// @param  baseAssets  The base-asset equivalent to release.
    /// @param  sender      The account that initiated the withdrawal
    ///                     (the request originator — used to identify
    ///                     SharesCooldown silo calls in future flows).
    /// @param  receiver    Address receiving the output token.
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver
    ) external returns (uint256);

    /// @notice Same as {withdraw} above, with an explicit flag to
    ///         bypass the strategy's configured cooldown.
    /// @dev    Caller must be the CDO. The flag is set when the
    ///         caller knows the user has already served their
    ///         cooldown elsewhere (e.g. via the CDO's
    ///         `SharesCooldown` silo). When `shouldSkipCooldown` is
    ///         true the strategy releases tokens immediately.
    function withdraw(
        address tranche,
        address token,
        uint256 tokenAmount,
        uint256 baseAssets,
        address sender,
        address receiver,
        bool shouldSkipCooldown
    ) external returns (uint256);

    // ---------------------------------------------------------------
    // Reserve
    // ---------------------------------------------------------------

    /// @notice Transfer `tokenAmount` of `token` to `receiver`.
    /// @dev    Caller must be the CDO. Used by
    ///         `CDO.reduceReserve(...)` to drain the protocol reserve
    ///         into the treasury. Concrete strategies are free to
    ///         re-use their cooldown infrastructure here (with a
    ///         zero-cooldown transfer) — they do NOT need an extra
    ///         direct path.
    function reduceReserve(
        address token,
        uint256 tokenAmount,
        address receiver
    ) external;

    // ---------------------------------------------------------------
    // Reporting
    // ---------------------------------------------------------------

    /// @notice Total assets the strategy controls, denominated in
    ///         base-asset units.
    function totalAssets() external view returns (uint256);

    /// @notice Convert `tokenAmount` of `token` into base-asset units.
    /// @dev    For ERC-4626 alternatives, uses the vault's
    ///         exchange rate with the requested rounding direction.
    function convertToAssets(
        address token,
        uint256 tokenAmount,
        Math.Rounding rounding
    ) external view returns (uint256 baseAssets);

    /// @notice Inverse of {convertToAssets}.
    function convertToTokens(
        address token,
        uint256 baseAssets,
        Math.Rounding rounding
    ) external view returns (uint256 tokenAmount);

    // ---------------------------------------------------------------
    // Registry
    // ---------------------------------------------------------------

    /// @notice Returns the tokens the strategy accepts on deposit
    ///         (and emits on withdrawal where the concrete policy
    ///         allows it).
    function getSupportedTokens() external view returns (IERC20[] memory);
}
```

Notes on the interface:

- The base-asset / alternative split is **not encoded in the
  interface**. Concrete strategies hold whatever immutables they
  need. PrimeCDO never needs `baseAsset()` directly — it queries the
  Tranche, which holds `asset()` from ERC-4626.
- `deposit` returns `uint256` of base assets credited. Concrete
  implementations decide what value makes sense to return when the
  deposit token is itself the base.
- Both `withdraw` overloads exist. Concrete strategies typically
  implement one and forward the other (`withdraw(...) =>
withdrawInner(..., false)`).
- `sender` parameter on `withdraw` is the request originator
  identification used in the future SharesCooldown flow:
  - User submits a vault redeem → Tranche calls CDO → CDO passes the
    user as `sender`. Strategy applies cooldown for that user.
  - Later, SharesCooldown silo finalises → it calls Tranche.redeem
    → Tranche → CDO → Strategy with `sender = sharesCooldown` and
    `shouldSkipCooldown = true`. Strategy releases immediately
    because the user already waited.

### 4. `Strategy.sol` — Empty Abstract

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { IStrategy } from "../interfaces/IStrategy.sol";
import { CDOComponent } from "../base/CDOComponent.sol";

/// @title  Strategy
/// @notice Abstract base contract for CDO investment strategies.
/// @dev    Concrete strategies extend this and implement every
///         {IStrategy} method. The base contract intentionally holds
///         no storage and exposes no helpers — concrete contracts
///         own:
///           - The supported-token registry and base-asset reference.
///           - The integration with the underlying yield protocol
///             (e.g. sUSDai / Aave / Pendle).
///           - The cooldown infrastructure (typically an
///             `IERC20Cooldown` silo) used by `withdraw` and
///             `reduceReserve`.
///         Keeping the base empty avoids over-fitting the abstraction
///         to a single strategy shape; alternative strategies on
///         different underlyings can share only the
///         `IStrategy + CDOComponent` surface.
abstract contract Strategy is IStrategy, CDOComponent {
}
```

That is the entire contract. Two-line body, three imports counting
the one in `CDOComponent`.

---

## Notes

### Why `Strategy.sol` is empty

Mirrors the upstream pattern. Holding storage in the base contract
(`_supportedTokens`, `_baseAsset`, init helpers) was a premature
abstraction — every concrete strategy ends up declaring its own
ERC-4626 wrapper as an `immutable`, its own constructor signature
for that immutable, and its own initialiser to set up cooldown
infrastructure. Putting any of that in the base makes subclass
boilerplate longer, not shorter.

### Why `withdraw` has two overloads

The default flow — user redeems from Tranche directly — applies the
strategy's standard cooldown to protect against bank runs. The
override exists because SharesCooldown silo holds shares **on behalf
of users** during the CDO-level cooldown. When the silo finalises a
batch, the user has already served the time; running the strategy's
cooldown again would double-lock them. The CDO knows the call comes
from the silo (it checks `sender == sharesCooldown`) and asks the
strategy to skip cooldown.

### Why no `UnstakeCooldown` in Atrium

The upstream codebase has `UnstakeCooldown` for protocols whose
underlying redemption is asynchronous (e.g. Ethena's 7-day unstake
on `sUSDe → USDe`). Atrium intentionally does not invoke USDai's
30-day `sUSDai → USDai` redemption — users receive sUSDai on
withdrawal and can convert to USDai themselves through the USDai
protocol. So the only async layer Atrium introduces is the
Atrium-side `SharesCooldown` silo (covered in a separate spec). No
`UnstakeCooldown` interface or contract is required.

### Why `getSupportedTokens` returns a built array each call

A concrete strategy holds 2-3 tokens as immutables (e.g. sUSDai,
USDai). Building the array on each call is cheaper than maintaining
a storage array — view functions don't pay for memory expansion
beyond the immediate caller.

### `sender` vs `owner` parameter semantics

These are different things:

- `owner` (on `deposit`): the holder of the token balance the
  strategy pulls. With Pattern B/3, this is the Tranche vault — the
  CDO sets `owner = tranche` when forwarding. Strategy uses
  `safeTransferFrom(token, owner, this, ...)`.
- `sender` (on `withdraw`): the request originator. Distinguishes
  user-initiated redeems from silo-finalised redeems. Strategy uses
  it for cooldown bookkeeping (and the silo special-case).

### Storage layout

`Strategy.sol` declares no storage. Layout is entirely the
responsibility of the concrete subclass:

```text
[CDOComponent]                – cdo (1 slot) + __gap[49]
[Strategy own]                – (none)
[Concrete strategy storage]   – e.g. sUSDai (immutable, no slot),
                                USDai (immutable, no slot),
                                erc20Cooldown,
                                sUsdaiCooldownJr,
                                sUsdaiCooldownMz,
                                sUsdaiCooldownSr
```

The cooldown periods are now **three** values (Jr/Mz/Sr) — Atrium
has three tranches.

---

## Non-Goals

- `UsdaiStrategy.sol` concrete implementation — spec 10'.
- `ERC20Cooldown.sol` concrete silo — spec 10''.
- `Tranche.sol` allowance changes for the 2-hop pattern — covered
  in spec 06.
- Underlying USDai protocol integration details.
- Admin setters on the abstract base.
- Multi-output withdraw expansion (v2).
- Deployment scripts.

---

## Acceptance Criteria

- `IStrategy.sol` matches §3 with all six methods plus two
  `withdraw` overloads.
- `ICooldown.sol` and `IERC20Cooldown.sol` exist at the paths in §1
  and §2 with the documented surfaces.
- `Strategy.sol` is exactly the abstract in §4 — no storage, no
  helpers, no init.
- `Strategy` inherits `IStrategy` and `CDOComponent` in that order.
- `pnpm build` clean under solc 0.8.35.
- No changes to `CDOComponent.sol`, `AccessControlled.sol`,
  `PrimeCDO.sol`, `Tranche.sol`, `IAccounting.sol`.

---

## Check When Done

- Build passes.
- `progress-tracker.md` updated:
  - Add files: `Strategy.sol`, `ICooldown.sol`, `IERC20Cooldown.sol`.
  - Amend: `IStrategy.sol`.
  - Architecture decisions:
    - `Strategy.sol` is empty abstract; concrete contracts own
      storage and infrastructure.
    - `IStrategy` matches the upstream pattern, with the
      `UnstakeCooldown`-related entry points omitted because Atrium
      does not call USDai's async redeem.
    - Deposit is 2-hop: Tranche pulls from user, Strategy pulls
      from Tranche (`owner = tranche`).
    - Withdraw has two overloads; the silo skips cooldown via the
      explicit flag.
  - Open Questions:
    - Concrete strategy (spec 10') — confirm Atrium's per-tranche
      cooldown durations and whether the cooldown silo should be
      disabled by default until governance enables it.
    - `ERC20Cooldown` silo (spec 10'') — owner, role plumbing, and
      whether the silo is shared across strategies or per-strategy.
- Spec 10' (`UsdaiStrategy.sol`) unblocked.
- Spec 10'' (`ERC20Cooldown.sol`) unblocked.
- PrimeCDO withdraw body unblocked once 10' lands.
