# Architecture Context

## Stack

| Layer             | Technology                   | Role                                                              |
| ----------------- | ---------------------------- | ----------------------------------------------------------------- |
| Language          | Solidity 0.8.35              | Smart contract implementation language                            |
| Framework         | Foundry (forge, cast, anvil) | Compilation, testing, scripting, and local node                   |
| Libraries         | OpenZeppelin Contracts       | Audited primitives: ERC standards, access control, security utils |
| Testing           | forge-std + Foundry fuzzing  | Unit, fuzz, and invariant tests                                   |
| Static Analysis   | Slither + Aderyn             | Vulnerability detection and code quality checks                   |
| Coverage          | forge coverage + lcov        | Line and branch coverage reporting                                |
| Deployment        | Foundry scripts + Forge      | Deterministic deployment via `forge script`                       |
| Verification      | Etherscan / Sourcify         | Source code verification on target chains                         |
| Frontend Bindings | Wagmi + Viem (TypeScript)    | Typed contract ABIs for off-chain consumers                       |
| Indexing          | The Graph or Ponder          | Event-driven off-chain state reconstruction                       |

## System Boundaries

- `src/` — Production contracts deployed on-chain. Organized by domain (core, periphery, governance).
- `src/interfaces/` — External interfaces (`I*.sol`) consumed by integrators and other contracts.
- `src/libraries/` — Pure / internal libraries with no storage of their own.
- `src/errors/` — Shared custom error definitions used across multiple contracts.
- `script/` — Foundry deployment and operational scripts. Never imported by production contracts.
- `test/` — Unit, fuzz, and invariant tests. Mirrors `src/` structure.
- `test/mocks/` — Mock contracts used only in tests. Never deployed.
- `lib/` — Git submodule dependencies (OpenZeppelin, forge-std, Solmate). Treat as read-only.
- `out/` — Compiler artifacts. Generated. Not committed.
- `broadcast/` — Deployment transaction records. Committed for audit trail.

## Storage Model

- **On-chain storage**: contract state variables — balances, ownership, configuration, accounting. Expensive; minimize.
- **Events**: state transitions that off-chain consumers need to observe. Indexed where queryability matters.
- **Off-chain (indexer)**: historical state reconstructed from events. Use for UI queries, analytics, and reporting.
- Storage slots must be packed where possible to minimize SSTORE costs.
- For upgradeable contracts, storage layout is append-only — never reorder, rename, or remove existing slots.
- Storage gaps (`uint256[50] __gap`) are reserved in upgradeable base contracts to allow future fields.

## Error Handling Model

- All reverts use **custom errors**, never `require` with string messages or `revert("...")`.
- Custom errors are cheaper at deploy time and runtime, and produce structured selectors that off-chain consumers can decode reliably.
- Custom errors carry contextual parameters whenever they help diagnose the failure (caller address, expected vs. actual values, identifiers).
- Naming convention: `PascalCase` describing the failure condition, e.g. `Unauthorized()`, `InsufficientBalance(uint256 available, uint256 required)`, `InvalidAddress(address provided)`.
- Errors local to a single contract are declared at the top of that contract.
- Errors shared by multiple contracts live in `src/errors/` and are imported where needed.
- Interface contracts declare the errors that their implementations may revert with, so integrators can handle them by selector.
- Tests assert reverts using `vm.expectRevert(SelectorName.selector)` or `abi.encodeWithSelector(SelectorName.selector, args)` — never generic revert matching.
- Off-chain consumers (frontend, indexer, monitoring) decode error selectors into human-readable messages using the published ABI.

### Forbidden Patterns

- `require(condition, "string message")` — use a custom error instead.
- `revert("string message")` — use a custom error instead.
- `assert()` for input validation — `assert` is reserved for invariants that should never fail in correct code.
- Generic errors like `Error()` or `Failed()` — names must describe the specific failure.

## Access Control Model

- Privileged actions are gated by `AccessControl` roles, not `Ownable`, unless the project is single-admin.
- Roles are defined as `bytes32` constants and documented in `architecture-context.md`.
- The `DEFAULT_ADMIN_ROLE` is held by a multisig or timelock, never by an EOA in production.
- Role grants and revocations emit events and are observable on-chain.
- All privileged functions carry an explicit role modifier; no implicit trust based on `msg.sender`.
- Unauthorized access reverts with `Unauthorized(address caller, bytes32 requiredRole)` (or the equivalent custom error from OpenZeppelin's `AccessControl`).
- Externally callable functions clearly declare their visibility and trust assumptions in NatSpec.

## Upgradeability Model

- Upgrade pattern: UUPS proxy (or Transparent — pick one and document).
- Implementation contracts are stateless beyond storage slots declared in their inheritance chain.
- Initializers (`initialize()`) replace constructors; constructors are disabled via `_disableInitializers()`.
- Storage layout compatibility is verified on every deploy using `forge inspect` and the OpenZeppelin upgrades plugin where applicable.
- Upgrades are executed by a timelock-controlled multisig. No direct upgrades from EOAs.
- Non-upgradeable contracts must explicitly state immutability in NatSpec.

## External Integrations

### Oracles

- Price feeds use Chainlink with staleness checks (`updatedAt`) and `answeredInRound` validation.
- Stale or invalid oracle data reverts with a specific custom error, e.g. `StaleOracleData(uint256 updatedAt, uint256 maxAge)`.
- Fallback behavior is defined per integration: revert, pause, or use TWAP backup.
- Oracle addresses are configurable via privileged functions, not hardcoded.

### Tokens

- ERC20 transfers use OpenZeppelin's `SafeERC20` to handle non-standard tokens.
- Token allowlists are explicit when the protocol does not support arbitrary ERC20s.
- Disallowed tokens revert with `TokenNotSupported(address token)`.
- Fee-on-transfer and rebasing tokens are either supported explicitly or rejected at integration time.

### External Protocols

- Each external protocol integration has a dedicated adapter contract.
- Adapters isolate failure modes and version drift from core protocol logic.
- Return values from external calls are always checked; bare calls without checks are forbidden.
- Failed external calls revert with `ExternalCallFailed(address target, bytes returnData)` so the underlying revert reason is preserved for off-chain decoding.

## Testing Model

### Unit Tests

- One test contract per source contract, located at `test/{ContractName}.t.sol`.
- Cover happy paths and every revert branch.
- Use `vm.expectRevert(ErrorName.selector)` for parameterless errors.
- Use `vm.expectRevert(abi.encodeWithSelector(ErrorName.selector, expectedArg1, expectedArg2))` for errors with parameters.
- Never use generic `vm.expectRevert()` without a selector — it masks unrelated reverts and hides regressions.

### Fuzz Tests

- Required for any function accepting numeric input, address input, or bytes input from external callers.
- Bound inputs to realistic ranges using `vm.assume` or `bound()`.
- Fuzz runs default to 256; critical paths run 10,000+.

### Invariant Tests

- Required for any contract holding funds, managing accounting, or enforcing global properties.
- Handler contracts constrain the fuzzer to valid call sequences.
- Invariants are stated in `architecture-context.md` and asserted in `test/invariant/`.

### Fork Tests

- Integrations with live protocols (oracles, DEXes, lending markets) are tested against forked mainnet state.
- Fork block numbers are pinned for reproducibility.

## Deployment Model

- All deployments go through Foundry scripts in `script/`.
- Constructor and initializer arguments are loaded from environment variables or `foundry.toml` profiles, never hardcoded.
- Deployment scripts are idempotent where possible and emit `console2.log` records for verification.
- Post-deployment, the deployer runs verification scripts that assert configured state matches expectations (roles granted, parameters set, ownership transferred).
- Mainnet deployments require a dry-run on a fork and a testnet deployment before execution.

## Invariants

1. Privileged functions are never callable by unauthorized addresses, under any call path.
2. External calls follow Checks-Effects-Interactions; state is finalized before any external transfer or call.
3. Funds held by the protocol are always accounted for — sum of internal balances equals contract token balance (or deficit is explicitly tracked).
4. Storage layout of upgradeable contracts is append-only across versions.
5. No function uses `tx.origin` for authorization.
6. All external calls check return values; failed calls revert with a custom error or are handled explicitly.
7. Mathematical operations either use Solidity 0.8+ checked arithmetic or document why `unchecked` is safe.
8. Events are emitted for every state change that off-chain consumers must observe.
9. Initializers can only be called once and are protected by the `initializer` modifier.
10. No contract holds more authority than it needs — privilege is partitioned by role, not concentrated.
11. All reverts use custom errors — no string-based `require` or `revert` in production contracts.
