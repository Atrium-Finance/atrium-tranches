# Development Workflow

## Approach

Build smart contracts incrementally using a spec-driven workflow. Context files define what to build, how to build it, and what the current state of progress is. Always implement against these specs — do not infer or invent contract behavior, tokenomics, or access control rules from scratch.

Security and correctness take precedence over speed. A working contract that violates an invariant is worse than no contract at all.

## Scoping Rules

- Work on one contract, module, or function group at a time.
- Prefer small, verifiable increments backed by tests over large speculative changes.
- Do not combine unrelated contract boundaries in a single implementation step.
- Every new function must have a corresponding test before moving on.

## When To Split Work

Split an implementation step if it combines:

- Storage layout changes and business logic changes
- Access control / role changes and feature logic
- Multiple unrelated contracts or facets
- On-chain logic and off-chain integration (scripts, indexers, frontend hooks)
- External integrations (oracles, bridges, other protocols) and core contract logic
- Upgrade logic and feature logic
- Behavior that is not clearly defined in the context files

If a change cannot be covered by a focused unit or invariant test, the scope is too broad — split it.

## Handling Missing Requirements

- Do not invent tokenomics, fee structures, access roles, or economic behavior that is not defined in the context files.
- If a requirement is ambiguous (e.g. rounding direction, fee recipient, slippage tolerance), resolve it in the relevant context file before implementing.
- If a requirement is missing, add it as an open question in `progress-tracker.md` before continuing.
- Never silently choose a default for security-sensitive parameters.

## Protected Foundation Components

Do not modify audited or third-party foundation contracts unless explicitly instructed.

This includes:

- OpenZeppelin contracts (`@openzeppelin/contracts/*`)
- Solmate, Solady, or other vendored libraries
- Foundry / Hardhat standard libraries (`forge-std`, `hardhat/console.sol`)
- Compiled artifacts and generated bindings

These must remain at their published versions so audits, upgrades, and dependency tracking stay clean.

Project-specific logic must be implemented by inheriting from or composing with these contracts in app-level contracts, never by editing them in place.

Only modify these files when a task explicitly requires forking a library, and document the fork in the context files.

## Security Invariants

Every implementation step must preserve the invariants defined in `architecture-context.md`. At minimum, the following must always hold unless a context file explicitly overrides them:

- Checks-Effects-Interactions order on every external call
- No use of `tx.origin` for authorization
- No unbounded loops over user-controlled data
- Reentrancy guards on all functions that make external calls and touch state
- Integer operations either use Solidity 0.8+ checked math or explicitly justify `unchecked` blocks
- Storage layout is append-only for upgradeable contracts
- Access control modifiers are present on every privileged function

If a change would violate an invariant, stop and update the context file first.

## Testing Requirements

Before a unit is considered done:

- Unit tests cover happy path and revert cases
- Fuzz tests exist for any function taking numeric or address input from users
- Invariant tests exist for contracts holding funds or managing accounting
- Gas snapshots are recorded for hot paths
- Coverage does not regress

Do not move on if tests are skipped, commented out, or marked as `vm.skip`.

## Keeping Docs In Sync

Update the relevant context file whenever implementation changes:

- Contract architecture, inheritance chains, or module boundaries
- Storage layout (especially for upgradeable contracts)
- Access control roles and privileged actions
- External dependencies (oracles, tokens, protocols)
- Deployment order and constructor arguments
- Code conventions or standards
- Feature scope

Progress state must reflect the actual state of the implementation, not the intended state. A contract is not "done" until it is tested, documented, and its invariants are verified.

## Before Moving To The Next Unit

1. The current contract or function works end to end within its defined scope.
2. All tests pass, including fuzz and invariant tests where required.
3. No invariant defined in `architecture-context.md` was violated.
4. Storage layout changes (if any) are documented and compatible with the upgrade strategy.
5. Gas costs for hot paths are within budget defined in the context files.
6. `progress-tracker.md` reflects the completed work.
