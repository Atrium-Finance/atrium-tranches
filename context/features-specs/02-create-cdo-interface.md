# 02 - Create CDO Interfaces

## Overview

Create the base CDO interface used for tranche coordination and accounting.

The interface defines:

- tranche vault accessors
- accounting updates
- deposit flow
- withdrawal flow
- vault limit queries

This interface will act as the primary entry point for tranche interactions.

---

## Goals

- Create `ICDO.sol`
- Expose tranche vault getters
- Define deposit/withdraw interfaces
- Define accounting interfaces
- Prepare architecture for custom tranche flows

---

## File Structure

```text
contracts/
├── interfaces/
│   ├── ITranche.sol
│   └── ICDO.sol
```

---

## Requirements

### 1. Create Interface

### File

```text
contracts/interfaces/ICDO.sol
```

---

## Imports

Use explicit imports only.

Example:

```solidity
import { ITranche } from "./ITranche.sol";
```

---

## Interface Definition

Create interface:

```solidity
interface ICDO {

}
```

---

## Required Functions

### Tranche Vault Getters

```solidity
function jrVault() external view returns (ITranche);

function mezzVault() external view returns (ITranche);

function srVault() external view returns (ITranche);
```

---

### Accounting

```solidity
function totalAssets(
    address tranche
) external view returns (uint256);

function updateAccounting() external;
```

---

### Deposit Flow

```solidity
function deposit(
    address tranche,
    address token,
    uint256 tokenAmount,
    uint256 baseAssets
) external;
```

---

### Withdraw Flow

```solidity
function withdraw(
    address tranche,
    address token,
    uint256 tokenAmount,
    uint256 baseAssets,
    address owner,
    address receiver
) external;
```

---

### Limits

```solidity
function maxWithdraw(
    address tranche
) external view returns (uint256);

function maxWithdraw(
    address tranche,
    address owner
) external view returns (uint256);

function maxDeposit(
    address tranche
) external view returns (uint256);
```

---

## Notes

- Interface only
- No implementation yet
- No access control yet
- No accounting logic yet
- No validation logic yet
- Custom tranche withdrawal flow will be implemented later

---

## Design Notes

### Tranche Routing

The `tranche` parameter determines which vault/accounting path should be used.

Expected supported tranches:

- Junior
- Mezzanine
- Senior

---

### Asset Accounting

`baseAssets` represents normalized accounting assets used internally by the protocol.

`tokenAmount` represents the actual token transfer amount.

---

### Withdraw Flow

Withdrawals are routed through the CDO instead of using native ERC4626 withdrawal logic directly.

---

## Acceptance Criteria

- `ICDO.sol` compiles successfully
- All function signatures compile correctly
- `ITranche` imports resolve correctly
- No circular imports
- Formatter passes
- No linting errors

---

## Check When Done

- Interface compiles successfully
- All imports resolve correctly
- Function signatures match spec exactly
- No default light styling appears
- All components import without errors
