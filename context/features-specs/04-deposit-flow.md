# 04 - Implement PrimeVault Deposit & Mint Flows

## Overview

Implement `IPrimeVault` deposit and mint flows in `Tranche.sol`.

The vault must support:

- native asset deposits
- meta deposits using supported ERC4626 vault tokens
- accounting synchronization through the CDO
- asset/share conversion through the strategy

Withdraw and redeem flows will be implemented later.

---

## Goals

- Implement `deposit(address token, uint256 amount, address receiver)`
- Implement `mint(address token, uint256 shares, address receiver)`
- Implement internal `_deposit(...)`
- Support both direct asset deposits and meta-vault deposits
- Route accounting updates through `cdo.updateAccounting()`

---

## Requirements

### Affected Contract

```text
contracts/vaults/Tranche.sol
```

---

## Existing Interface

`Tranche.sol` already implements:

```solidity
IPrimeVault
```

No additional interface work is required.

---

# Deposit Flow

## Function

```solidity
function deposit(
    address token,
    uint256 tokenAmount,
    address receiver
) public virtual returns (uint256)
```

---

## Required Behavior

### Native Asset Path

If:

```solidity
token == asset()
```

Use native ERC4626 deposit flow:

```solidity
return deposit(tokenAmount, receiver);
```

---

### Meta Vault Path

Otherwise:

1. synchronize accounting
2. convert token amount into base assets
3. preview shares
4. execute internal deposit flow

---

## Required Logic

```solidity
if (token == asset()) {
    return deposit(tokenAmount, receiver);
}

cdo.updateAccounting();

// {Optimistic path} Reverts if token is not supported
uint256 baseAssets =
    cdo.strategy().convertToAssets(
        token,
        tokenAmount,
        Math.Rounding.Floor
    );

uint256 shares = previewDeposit(baseAssets);

_deposit(
    token,
    _msgSender(),
    receiver,
    baseAssets,
    tokenAmount,
    shares
);

return shares;
```

---

# Internal Deposit Flow

## Function

```solidity
function _deposit(
    address token,
    address caller,
    address receiver,
    uint256 baseAssets,
    uint256 tokenAssets,
    uint256 shares
) internal virtual
```

---

## Required Behavior

### Validate Withdraw Capacity

Ensure deposited token vault can withdraw enough base assets.

Required check:

```solidity
uint256 maxTokenToBaseAssetsWithdraw =
    IERC4626(token).maxWithdraw(caller);

require(
    maxTokenToBaseAssetsWithdraw >= baseAssets,
    "MetaVaultExceededMaxWithdraw"
);
```

---

### Transfer Assets

Transfer vault tokens from caller.

```solidity
SafeERC20.safeTransferFrom(
    IERC20(token),
    caller,
    address(this),
    tokenAssets
);
```

---

### Mint Shares

```solidity
_mint(receiver, shares);
```

---

### Deposit Into CDO

```solidity
cdo.deposit(
    address(this),
    token,
    tokenAssets,
    baseAssets
);
```

---

### Emit Events

```solidity
emit Deposit(caller, receiver, baseAssets, shares);

emit OnMetaDeposit(
    receiver,
    token,
    tokenAssets,
    shares
);
```

---

# Mint Flow

## Function

```solidity
function mint(
    address token,
    uint256 shares,
    address receiver
) public virtual returns (uint256)
```

---

## Required Behavior

### Native Asset Path

If:

```solidity
token == asset()
```

Use native ERC4626 mint flow:

```solidity
return mint(shares, receiver);
```

---

### Meta Vault Path

Otherwise:

1. synchronize accounting
2. preview required base assets
3. convert base assets into token assets
4. execute internal deposit flow

---

## Required Logic

```solidity
if (token == asset()) {
    return mint(shares, receiver);
}

cdo.updateAccounting();

uint256 baseAssets = previewMint(shares);

// {Optimistic path} Reverts if token is not supported
uint256 tokenAssets =
    cdo.strategy().convertToTokens(
        token,
        baseAssets,
        Math.Rounding.Ceil
    );

_deposit(
    token,
    _msgSender(),
    receiver,
    baseAssets,
    tokenAssets,
    shares
);

return tokenAssets;
```

---

# Withdraw & Redeem

Withdraw and redeem flows are intentionally excluded from this task.

Implementation will be handled in a future spec.

---

## Required Imports

Expected imports include:

```solidity
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
```

---

## Notes

- Accounting synchronization is mandatory
- Meta deposits rely on strategy conversions
- Token support validation is optimistic
- Reverts expected from unsupported vaults
- Deposit flow must remain upgrade-safe

---

## Non-Goals

This task does NOT include:

- withdraw implementation
- redeem implementation
- fee logic
- access control
- slippage protection
- rebalance logic
- strategy implementation

---

## Acceptance Criteria

- `deposit(token, amount, receiver)` compiles correctly
- `mint(token, shares, receiver)` compiles correctly
- `_deposit(...)` compiles correctly
- Native asset flow works correctly
- Meta vault flow works correctly
- `cdo.updateAccounting()` called before calculations
- SafeERC20 transfers work correctly
- CDO deposit routing works correctly
- Events emit correctly
- No circular imports
- Formatter passes
- No linting errors

---

## Check When Done

- Contracts compile successfully
- All overrides compile correctly
- Deposit/mint flows execute correctly
- Meta vault deposits work correctly
- Events emit correctly
- No default light styling appears
- All components import without errors
