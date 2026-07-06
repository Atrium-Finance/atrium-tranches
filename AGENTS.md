<!-- BEGIN:solidity-agent-rules -->

# This is NOT vanilla Solidity/OpenZeppelin

This codebase uses upgradeable contracts and custom tranche withdrawal flows.

Before implementing any contract changes:

- Read existing base contracts and inheritance tree carefully
- Follow the upgradeable pattern consistently
- Never introduce constructors
- Prefer `initialize()` + `__Contract_init()`
- Preserve storage layout compatibility
- Avoid changing variable ordering in deployed contracts
- Check proxy-safe patterns before adding state variables

---

# ERC4626 Rules

This project uses `ERC4626Upgradeable` from OpenZeppelin.

Default ERC4626 withdrawal behavior must NOT be used directly.

The following functions are expected to be overridden for custom withdrawal flows:

- `withdraw`
- `redeem`
- `maxWithdraw`
- `maxRedeem`
- `previewWithdraw`
- `previewRedeem`

Do not assume standard ERC4626 semantics for withdrawals.

Deposits and accounting behavior may still rely on ERC4626 internals.

---

# Upgradeability Rules

Use contracts from:

```solidity
@openzeppelin/contracts-upgradeable/
```

Avoid importing non-upgradeable variants unless explicitly required.

Required patterns:

```solidity
contract Example is Initializable {
    function initialize() public initializer {

    }
}
```

Never use:

```solidity
constructor()
```

---

# Storage Safety

When adding new state variables:

- Append only
- Never reorder existing variables
- Never remove variables
- Reserve storage gaps when needed

Example:

```solidity
uint256[50] private __gap;
```

---

# Error Handling

Prefer custom errors over revert strings.

Example:

```solidity
error NotImplemented();
```

Instead of:

```solidity
require(x, "ERROR");
```

---

# Code Style

- Explicit visibility for all functions
- Explicit imports only
- Use named imports
- Favor small modular contracts
- Keep interfaces minimal
- Avoid unnecessary inheritance

---

# Before Writing Code

Always verify:

- upgrade-safe inheritance
- storage compatibility
- initializer ordering
- ERC4626Upgradeable behavior
- overridden vault flows
- access-control assumptions

<!-- END:solidity-agent-rules -->

## Application Building Context

Read the following files in order before implementing or making any architectural decision:

1. `context/project-overview.md` — product definition, goals, features, and scope
2. `context/architecture-context.md` — system structure, boundaries, storage model, and invariants
3. `context/code-standards.md` — implementation rules and conventions
4. `context/ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach
5. `context/progress-tracker.md` — current phase, completed work, open questions, and next steps

Update `context/progress-tracker.md` after each meaningful implementation change.

If implementation changes the architecture, scope, or standards documented in the context files, update the relevant file before continuing.
