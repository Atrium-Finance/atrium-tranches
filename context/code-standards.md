# Code Standards

## General

- Keep contracts small and single-purpose.
- Fix root causes — do not layer workarounds, especially in security-sensitive code.
- Do not mix unrelated concerns in one contract, library, or function.
- Respect the system boundaries defined in `architecture-context.md`.
- Gas optimization comes after correctness, not before. Optimize only with benchmarks.

## Solidity

- Pin the compiler version exactly: `pragma solidity 0.8.26;` — never use `^` or ranges in production.
- Enable the optimizer in `foundry.toml` with a documented `runs` value matching the deployment target.
- Use `unchecked` blocks only when overflow is provably impossible, and document why in a comment.
- Prefer `immutable` for values set in the constructor and never changed; prefer `constant` for compile-time values.
- Mark functions `external` rather than `public` when they are never called internally — it's cheaper and clearer.
- Use named return values only when they improve readability; never rely on implicit returns.
- Follow the official Solidity style guide for ordering: state vars, events, errors, modifiers, constructor, receive, fallback, external, public, internal, private.

## Naming

- Contracts and interfaces: `PascalCase`. Interfaces are prefixed with `I` (e.g. `IVault`).
- Functions and variables: `camelCase`.
- Internal/private functions and state variables: prefix with `_` (e.g. `_transfer`, `_balances`).
- Constants and immutables: `SCREAMING_SNAKE_CASE`.
- Custom errors: `PascalCase`, describing the failure condition (e.g. `InsufficientBalance`).
- Events: `PascalCase`, past tense where natural (e.g. `Deposited`, `RoleGranted`).
- Files match the primary contract they contain: `Vault.sol` contains `contract Vault`.

## Error Handling

- All reverts use **custom errors** — never `require` with strings or `revert("...")`.
- Custom errors carry context parameters where they help diagnose failures.
- `assert` is reserved for invariants that should be unreachable; never use it for input validation.
- Errors local to one contract are declared at the top of that contract.
- Errors shared across multiple contracts live in `src/errors/`.
- Interfaces declare the errors their implementations may revert with.

## Access Control

- Every privileged function carries an explicit role or ownership modifier.
- Validate `msg.sender` authorization before any state change or external call.
- Never use `tx.origin` for authorization.
- Role identifiers are `bytes32` constants, declared once and reused.
- Document the trust assumptions of every externally callable function in NatSpec.

## External Calls

- Follow Checks-Effects-Interactions order strictly. State updates come before external calls.
- Apply `nonReentrant` to any function that updates state and makes external calls.
- Use `SafeERC20` for all ERC20 token transfers.
- Check return values of every external call; bare calls without checks are forbidden.
- Avoid `.transfer` and `.send` for ETH — use `.call{value: ...}("")` with a return value check.

## Storage

- Pack storage variables to minimize SSTORE operations; document packing intent with comments.
- Cache storage reads in memory when the same slot is read multiple times within a function.
- For upgradeable contracts: storage layout is append-only. Never reorder, rename, or remove existing slots.
- Reserve storage gaps (`uint256[50] private __gap`) in upgradeable base contracts.
- Document each storage variable's purpose in NatSpec.

## Math

- Rely on Solidity 0.8+ checked arithmetic by default.
- Use `unchecked` only when overflow is impossible (e.g. loop counters bounded by array length).
- Document rounding direction explicitly — never leave it implicit.
- For fixed-point math, use a library (PRBMath, Solady FixedPointMath) rather than rolling your own.
- Validate divisor != 0 before division if it could be user-controlled.

## Events

- Emit an event for every state change that off-chain consumers must observe.
- Index parameters that consumers will filter or query on (max 3 indexed per event).
- Event names describe what happened, not what the function did (e.g. `Transferred`, not `TransferCalled`).
- Include enough context in event parameters that off-chain consumers do not need to call back into the contract to reconstruct state.

## NatSpec

- Every external and public function has NatSpec: `@notice`, `@param`, `@return`, and `@dev` for implementer notes.
- Errors and events do NOT need NatSpec — the declaration itself is the documentation. The name describes the failure / state change; parameter names describe the payload.
- Document access control assumptions in `@dev`.
- Interfaces carry the canonical NatSpec; implementations may add `@dev` notes but should not duplicate `@notice`.

## Comments

- Keep comments short, clear, and direct. No yapping.
- A reader should grasp the function's main purpose from its `@notice` (or one-line header) alone.
- For non-trivial math, write the formula on the line(s) directly above the implementation. The code is the implementation; the formula is the contract.
- Comment the *why* (constraint, invariant, rounding direction, ordering requirement) — not the *what*, which the code already says.
- Do not narrate obvious steps (`// increment i`, `// emit event`). Delete them.
- Do not leave stale TODOs or commented-out code in production files. Track follow-ups in `progress-tracker.md`.

## Testing

- Test files mirror source structure: `src/Vault.sol` → `test/Vault.t.sol`.
- Test function names follow the pattern `test_Description`, `testFuzz_Description`, `test_RevertWhen_Condition`, `testFork_Description`.
- Always use `vm.expectRevert(ErrorName.selector)` or `abi.encodeWithSelector(...)` — never bare `vm.expectRevert()`.
- One assertion concept per test where possible.
- Bound fuzz inputs to realistic ranges using `bound()` rather than `vm.assume()` when feasible — `bound` doesn't waste fuzz runs.
- Test the revert case for every input validation branch.

## Gas Considerations

- Mark unchangeable values `immutable` or `constant`.
- Prefer `++i` over `i++` in loops.
- Cache `array.length` outside loops.
- Use `calldata` for external function parameters that are not modified.
- Short-circuit boolean expressions with the cheaper condition first.
- Avoid storage writes inside loops where possible.
- Do not sacrifice readability or correctness for gas — benchmark first.

## File Organization

- `src/` — production contracts, organized by domain (`core/`, `periphery/`, `governance/`).
- `src/interfaces/` — external interfaces (`I*.sol`).
- `src/libraries/` — pure or internal libraries.
- `src/errors/` — shared custom errors used across multiple contracts.
- `script/` — Foundry deployment and operational scripts.
- `test/` — tests, mirroring `src/` structure.
- `test/mocks/` — mock contracts used only in tests.
- `test/invariant/` — invariant tests and their handlers.
- `lib/` — git submodule dependencies; treat as read-only.
- Name files after the contract they contain, not the technology.

## Imports

- Use named imports: `import {Vault} from "src/Vault.sol";` — never `import "src/Vault.sol";`.
- Group imports: external libraries first, then internal contracts, then interfaces, then errors.
- Use remappings in `foundry.toml` to keep import paths short and stable.
- Never import from `script/` or `test/` into production code.
