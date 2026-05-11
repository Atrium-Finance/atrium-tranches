export const PRIME_LENS_ABI = [
  {
    inputs: [],
    name: "getAllTranches",
    outputs: [
      {
        components: [
          { name: "trancheId", type: "uint8" },
          { name: "vault", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "totalAssets", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
          { name: "sharePrice", type: "uint256" },
          { name: "apy", type: "uint256" },
        ],
        name: "senior",
        type: "tuple",
      },
      {
        components: [
          { name: "trancheId", type: "uint8" },
          { name: "vault", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "totalAssets", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
          { name: "sharePrice", type: "uint256" },
          { name: "apy", type: "uint256" },
        ],
        name: "junior",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tranche", type: "uint8" }],
    name: "getTrancheInfo",
    outputs: [
      {
        components: [
          { name: "trancheId", type: "uint8" },
          { name: "vault", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "totalAssets", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
          { name: "sharePrice", type: "uint256" },
          { name: "apy", type: "uint256" },
        ],
        name: "info",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getProtocolHealth",
    outputs: [
      {
        components: [
          { name: "seniorTVL", type: "uint256" },
          { name: "seniorPrincipal", type: "uint256" },
          { name: "seniorYield", type: "uint256" },
          { name: "juniorTVL", type: "uint256" },
          { name: "totalTVL", type: "uint256" },
          { name: "coverageSenior", type: "uint256" },
          { name: "minCoverageForDeposit", type: "uint256" },
          { name: "shortfallPaused", type: "bool" },
          { name: "strategyTVL", type: "uint256" },
        ],
        name: "health",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserPendingWithdraws",
    outputs: [
      {
        components: [
          { name: "requestId", type: "uint256" },
          { name: "handler", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "unlockTime", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "isClaimable", type: "bool" },
          { name: "timeRemaining", type: "uint256" },
        ],
        name: "withdraws",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getClaimableWithdraws",
    outputs: [
      {
        components: [
          { name: "requestId", type: "uint256" },
          { name: "handler", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "unlockTime", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "isClaimable", type: "bool" },
          { name: "timeRemaining", type: "uint256" },
        ],
        name: "claimable",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tranche", type: "uint8" }],
    name: "previewWithdrawCondition",
    outputs: [
      {
        components: [
          { name: "mechanism", type: "uint8" },
          { name: "feeBps", type: "uint256" },
          { name: "cooldownDuration", type: "uint256" },
          { name: "coverageSenior", type: "uint256" },
        ],
        name: "cond",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const TRANCHE_VAULT_ABI = [
  {
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "deposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "mint",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "requestWithdraw",
    outputs: [
      {
        components: [
          { name: "isInstant", type: "bool" },
          { name: "amountOut", type: "uint256" },
          { name: "cooldownId", type: "uint256" },
          { name: "cooldownHandler", type: "address" },
          { name: "unlockTime", type: "uint256" },
          { name: "feeAmount", type: "uint256" },
          { name: "appliedCooldownType", type: "uint8" },
        ],
        name: "result",
        type: "tuple",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "owner", type: "address" },
      { indexed: true, name: "receiver", type: "address" },
      { indexed: false, name: "shares", type: "uint256" },
      { indexed: false, name: "baseAmount", type: "uint256" },
      {
        indexed: false,
        name: "result",
        type: "tuple",
        components: [
          { name: "isInstant", type: "bool" },
          { name: "amountOut", type: "uint256" },
          { name: "cooldownId", type: "uint256" },
          { name: "cooldownHandler", type: "address" },
          { name: "unlockTime", type: "uint256" },
          { name: "feeAmount", type: "uint256" },
          { name: "appliedCooldownType", type: "uint8" },
        ],
      },
    ],
    name: "WithdrawRequested",
    type: "event",
  },
  {
    inputs: [
      { name: "cooldownId", type: "uint256" },
      { name: "cooldownHandler", type: "address" },
    ],
    name: "claimWithdraw",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "cooldownId", type: "uint256" }],
    name: "claimSharesWithdraw",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "depositOutputToken",
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "previewDepositOutputToken",
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "previewDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "previewMint",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "previewWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "previewRedeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "convertToAssets",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "convertToShares",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalAssets",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "asset",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "", type: "address" }],
    name: "maxDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "maxRedeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const APR_PAIR_FEED_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      {
        components: [
          { name: "aprTargetSenior", type: "int64" },
          { name: "aprBase", type: "int64" },
          { name: "updatedAt", type: "uint64" },
          { name: "answeredInRound", type: "uint64" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "roundId", type: "uint64" }],
    name: "getRoundData",
    outputs: [
      {
        components: [
          { name: "aprTargetSenior", type: "int64" },
          { name: "aprBase", type: "int64" },
          { name: "updatedAt", type: "uint64" },
          { name: "answeredInRound", type: "uint64" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ACCOUNTING_ABI = [
  {
    inputs: [],
    name: "getSeniorAPY",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getJuniorAPY",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getSeniorPrincipal",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
