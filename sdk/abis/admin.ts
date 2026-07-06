// Admin / governance ABIs for the deployed Atrium contracts. Every write
// here is role- or owner-gated on-chain (via the AccessControlManager).

/** PrimeCDO — pause, exit fees, reserve, wiring. */
export const PRIME_CDO_ADMIN_ABI = [
  // reads — per-tranche pause state
  {
    inputs: [],
    name: "actionsJr",
    outputs: [
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "actionsMezz",
    outputs: [
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "actionsSr",
    outputs: [
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // writes
  {
    inputs: [
      { name: "tranche", type: "address" }, // address(0) fans out to all three
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" },
    ],
    name: "setActionStates",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "jr", type: "uint256" },
      { name: "mz", type: "uint256" },
      { name: "sr", type: "uint256" },
    ],
    name: "setExitFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "treasury_", type: "address" }], name: "setReserveTreasury", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "sharesCooldown_", type: "address" }], name: "setSharesCooldown", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "reduceReserve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "jr", type: "address" },
      { name: "mz", type: "address" },
      { name: "sr", type: "address" },
      { name: "accounting", type: "address" },
      { name: "strategy", type: "address" },
    ],
    name: "config",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** Accounting — risk params, alpha weights, reserve rate, APR triggers. */
export const ACCOUNTING_ADMIN_ABI = [
  { inputs: [], name: "riskX", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "riskY", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "riskK", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { name: "riskX_", type: "uint256" },
      { name: "riskY_", type: "uint256" },
      { name: "riskK_", type: "uint256" },
    ],
    name: "setRiskParameters",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "jr", type: "uint256" },
      { name: "mz", type: "uint256" },
    ],
    name: "setAlphaWeights",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "bps", type: "uint256" }], name: "setReserveBps", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "onAprChanged", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "aprPairFeed_", type: "address" }], name: "setAprPairFeed", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

/** SharesCooldown — per-vault coverage exit ranges + early-exit fee. */
export const SHARES_COOLDOWN_ADMIN_ABI = [
  {
    inputs: [
      { name: "vault", type: "address" },
      {
        name: "bounds",
        type: "tuple",
        components: [
          { name: "p0", type: "uint256" },
          { name: "p1", type: "uint256" },
          {
            name: "r0",
            type: "tuple",
            components: [
              { name: "feeBps", type: "uint256" },
              { name: "sharesLock", type: "uint32" },
            ],
          },
          {
            name: "r1",
            type: "tuple",
            components: [
              { name: "feeBps", type: "uint256" },
              { name: "sharesLock", type: "uint32" },
            ],
          },
          {
            name: "r2",
            type: "tuple",
            components: [
              { name: "feeBps", type: "uint256" },
              { name: "sharesLock", type: "uint32" },
            ],
          },
        ],
      },
    ],
    name: "setVaultExitBounds",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "fee", type: "uint256" },
    ],
    name: "setVaultEarlyExitFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** USDAStrategy — per-tranche withdrawal cooldown durations. */
export const STRATEGY_ADMIN_ABI = [
  {
    inputs: [
      { name: "jr", type: "uint32" },
      { name: "mz", type: "uint32" },
      { name: "sr", type: "uint32" },
    ],
    name: "setCooldowns",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** AccessControlManager — role + call-based grant surface. */
export const ACM_ABI = [
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "revokeRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "hasRole",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "contractAddress", type: "address" },
      { name: "sel", type: "bytes4" },
      { name: "accountToPermit", type: "address" },
    ],
    name: "grantCall",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
