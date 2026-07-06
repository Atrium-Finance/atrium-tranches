// Minimal, hand-written ABIs matching the deployed Atrium contracts.
// Only the surface the SDK actually calls is included. For the full ABIs
// use the Hardhat artifacts under `artifacts/contracts/**`.

/**
 * Tranche — the ERC-4626 meta-vault (one deployment each for Jr/Mz/Sr).
 * Includes the standard ERC-4626 surface plus Atrium's meta-token
 * overloads. Withdraw/redeem MUST use the `(token, ...)` overload with
 * `token = sUSDai`; the plain overload routes the base asset which the
 * v1 Strategy rejects.
 */
export const TRANCHE_ABI = [
  // --- deposit ---
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
      { name: "token", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "deposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  // --- withdraw / redeem (meta-token overloads) ---
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    name: "withdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    name: "redeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  // --- previews ---
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "previewDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "sharesGross", type: "uint256" }],
    name: "previewRedeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "shares", type: "uint256" },
    ],
    name: "previewRedeem",
    outputs: [{ name: "tokenAssetsNet", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // --- conversions / balances ---
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
  { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
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
  { inputs: [{ name: "", type: "address" }], name: "maxDeposit", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "name", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "asset", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

/**
 * PrimeCDO — orchestrator. Read-only surface the SDK uses plus the
 * enum-returning `calculateExitMode`.
 */
export const PRIME_CDO_ABI = [
  { inputs: [], name: "coverage", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MIN_COVERAGE", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [],
    name: "totalAssetsUnlocked",
    outputs: [
      { name: "jr", type: "uint256" },
      { name: "mz", type: "uint256" },
      { name: "sr", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "tranche", type: "address" },
      { name: "owner", type: "address" },
    ],
    name: "calculateExitMode",
    outputs: [
      { name: "mode", type: "uint8" },
      { name: "fee", type: "uint256" },
      { name: "cooldownSeconds", type: "uint32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tranche", type: "address" }],
    name: "maxDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tranche", type: "address" }],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "tranche", type: "address" },
      { name: "owner", type: "address" },
    ],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [{ name: "tranche", type: "address" }], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "tranche", type: "address" }], name: "kindOf", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "treasury", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "exitFeeJr", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "exitFeeMz", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "exitFeeSr", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "sharesCooldown", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

/** Accounting — TVL buckets, APR pipeline, senior index. */
export const ACCOUNTING_ABI = [
  {
    inputs: [],
    name: "totalAssetsT0",
    outputs: [
      { name: "jrTvl", type: "uint256" },
      { name: "mzTvl", type: "uint256" },
      { name: "srTvl", type: "uint256" },
      { name: "reserveTvl", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [{ name: "tranche", type: "address" }], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aprSrt", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aprBase", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aprTarget", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "srtTargetIndex", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "reserveBps", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "alphaJr", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "alphaMz", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lastUpdateTime", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

/** Strategy — single TVL report. */
export const STRATEGY_ABI = [
  { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

/** SharesCooldown — per-user pending share-lock requests. */
export const SHARES_COOLDOWN_ABI = [
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "account", type: "address" },
    ],
    name: "activeRequestsLength",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "account", type: "address" },
      { name: "i", type: "uint256" },
    ],
    name: "activeRequests",
    outputs: [
      {
        components: [
          { name: "unlockAt", type: "uint64" },
          { name: "shares", type: "uint192" },
          { name: "token", type: "address" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "coverage", type: "uint256" },
    ],
    name: "calculateExitParams",
    outputs: [
      {
        components: [
          { name: "feeBps", type: "uint256" },
          { name: "sharesLock", type: "uint32" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  // Permissionless finalize (evaluated at now). vault is ITranche here.
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "token", type: "address" },
      { name: "user", type: "address" },
    ],
    name: "finalize",
    outputs: [{ name: "claimed", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** AprPairFeed — raw round data (aprBase/aprTarget are SD7x12, 12 decimals). */
export const APR_PAIR_FEED_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      {
        components: [
          { name: "aprBase", type: "int64" },
          { name: "aprTarget", type: "int64" },
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
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

/** Standard ERC-20 surface (USDai / sUSDai). */
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
