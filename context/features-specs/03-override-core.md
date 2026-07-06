# 03 - Override ERC4626 Deposit & Withdraw Flows

## Overview

Override all ERC4626 state-changing entrypoints related to deposits and withdrawals.

Before executing any accounting-sensitive operation, the tranche vault must call:

```solidity
cdo.updateAccounting()
```

This ensures the vault always operates using the latest synchronized accounting state.

---

## Goals

- Override all ERC4626 deposit/withdraw related functions
- Ensure accounting synchronization before any state-changing action
- Prevent stale accounting during share/asset calculations
- Centralize accounting updates through the CDO

---

## Requirements

### Affected Contract

```text
contracts/vaults/Tranche.sol
```

---

## Required Behavior

Before executing ANY function that:

- transfers assets
- mints shares
- burns shares
- calculates deposit amounts
- calculates withdrawal amounts

The contract MUST call:

```solidity
cdo.updateAccounting();
```

---

## Functions To Override

The following ERC4626 functions must be overridden.

---

### Deposit Flow

#### deposit

```solidity
function deposit(
    uint256 assets,
    address receiver
) public override returns (uint256);
```

Required flow:

```text
updateAccounting()
→ execute deposit
```

---

#### mint

```solidity
function mint(
    uint256 shares,
    address receiver
) public override returns (uint256);
```

Required flow:

```text
updateAccounting()
→ execute mint
```

---

### Withdraw Flow

#### withdraw

```solidity
function withdraw(
    uint256 assets,
    address receiver,
    address owner
) public override returns (uint256);
```

Required flow:

```text
updateAccounting()
→ execute custom withdraw flow
```

---

#### redeem

```solidity
function redeem(
    uint256 shares,
    address receiver,
    address owner
) public override returns (uint256);
```

Required flow:

```text
updateAccounting()
→ execute custom redeem flow
```

---

## Preview & Max Functions

The following read functions must also use fresh accounting before calculations.

Override:

- `previewDeposit`
- `previewMint`
- `previewWithdraw`
- `previewRedeem`
- `maxDeposit`
- `maxMint`
- `maxWithdraw`
- `maxRedeem`
- `convertToAssets`
- `convertToShares`
- any other function relying on accounting-sensitive values

---

## Accounting Synchronization Rule

### Important

Any function performing:

- share conversion
- asset conversion
- limit calculation
- withdrawal calculation
- mint calculation
- redeem calculation

MUST use updated accounting state first.

No stale accounting calculations are allowed.

---

## Example Pattern

```solidity
function deposit(
    uint256 assets,
    address receiver
) public override returns (uint256 shares) {
    cdo.updateAccounting();

    shares = super.deposit(assets, receiver);
}
```

---

## Notes

- `cdo` reference must already exist in the tranche contract
- Accounting synchronization is mandatory
- This rule applies to both deposit and withdrawal flows
- Future custom withdrawal logic will still follow this synchronization rule

---

## Non-Goals

This task does NOT include:

- implementing final withdrawal mechanics
- fee logic
- tranche rebalancing
- reward distribution
- access control

---

## Acceptance Criteria

- All ERC4626 state-changing flows are overridden
- `cdo.updateAccounting()` is called before calculations/actions
- Deposit flow still works correctly
- Withdraw flow compiles correctly
- Preview/max functions use fresh accounting state
- No stale accounting calculations remain
- No circular imports
- Formatter passes
- No linting errors

---

## Check When Done

- Contracts compile successfully
- All overrides compile correctly
- Accounting updates execute before actions
- Deposit/redeem flows compile correctly
- No default light styling appears
- All components import without errors
