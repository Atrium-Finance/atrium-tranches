# 01 - Create Tranches Interface & Base Contract

## Overview

Create the base tranche interface and upgradeable contract structure.

This task introduces:

- `ITranche.sol` interface
- `Tranche.sol` base contract
- ERC4626Upgradeable inheritance using OpenZeppelin upgradeable contracts
- Custom withdrawal flow overrides

The goal is to establish the foundational abstraction for future tranche vault logic while allowing custom withdrawal behavior later.

---

## Goals

- Create `ITranche.sol`
- Create upgradeable `Tranche.sol`
- Use OpenZeppelin `ERC4626Upgradeable`
- Override ERC4626 withdrawal functions for future custom flow
- Prepare base architecture for tranche-specific logic

---

## File Structure

```text
contracts/
├── interfaces/
│   └── ITranche.sol
│
└── vaults/
    └── Tranche.sol
```

---

## Requirements

### 1. Create Interface

### File

```text
contracts/interfaces/ITranche.sol
```

### Implementation

Import OpenZeppelin ERC4626 interface.

```solidity
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
```

Create interface:

```solidity
interface ITranche is IERC4626 {

}
```

---

## 2. Create Upgradeable Base Contract

### File

```text
contracts/vaults/Tranche.sol
```

### Implementation

Use OpenZeppelin upgradeable contracts.

Imports:

```solidity
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
```

The contract must:

- inherit from `Initializable`
- inherit from `ERC4626Upgradeable`
- implement `ITranche`
- use initializer instead of constructor

Example structure:

```solidity
contract Tranche is
    Initializable,
    ERC4626Upgradeable,
    ITranche
{
    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_
    ) public initializer {
        __ERC20_init_unchained(name_, symbol_);
        __ERC4626_init_unchained(asset_);
    }
}
```

---

## Notes

- Use upgradeable contract pattern only
- No constructors
- Deposits remain enabled
- ERC4626 accounting still used
- Withdrawal mechanics will be implemented separately
- No access control yet
- No tranche-specific business logic yet

---

## Acceptance Criteria

- `ITranche.sol` compiles successfully
- `Tranche.sol` compiles successfully
- Contract uses `ERC4626Upgradeable`
- Contract uses initializer pattern correctly
- No constructors used
- No circular imports
- Formatter passes
- No linting errors

---

## Check When Done

- Contracts compile successfully
- All imports resolve correctly
- Initializer works correctly
- No default light styling appears
- All components import without errors
