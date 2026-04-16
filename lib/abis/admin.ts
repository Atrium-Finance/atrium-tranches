export const PRIME_CDO_ADMIN_ABI = [
  // ═══════════════════════════════════════════════════════════════════
  //  READ — State
  // ═══════════════════════════════════════════════════════════════════
  {
    inputs: [],
    name: "s_minCoverageForDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_juniorShortfallPausePrice",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_shortfallPaused",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_ratioTarget",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_ratioTolerance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_ratioController",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Rebalance
  // ═══════════════════════════════════════════════════════════════════
  {
    inputs: [],
    name: "rebalanceSellWETH",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "maxBaseToRecall", type: "uint256" }],
    name: "rebalanceBuyWETH",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Loss Coverage
  // ═══════════════════════════════════════════════════════════════════
  {
    inputs: [{ name: "lossUSD", type: "uint256" }],
    name: "executeWETHCoverage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Reserve / Fee
  // ═══════════════════════════════════════════════════════════════════
  {
    inputs: [{ name: "recipient", type: "address" }],
    name: "claimReserve",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Configuration
  // ═══════════════════════════════════════════════════════════════════
  {
    inputs: [{ name: "minCoverage", type: "uint256" }],
    name: "setMinCoverageForDeposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "price", type: "uint256" }],
    name: "setJuniorShortfallPausePrice",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "unpauseShortfall",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "target", type: "uint256" }],
    name: "setRatioTarget",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "tolerance", type: "uint256" }],
    name: "setRatioTolerance",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "controller", type: "address" }],
    name: "setRatioController",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "id", type: "uint8" },
      { name: "vault", type: "address" },
    ],
    name: "registerTranche",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  EVENTS
  // ═══════════════════════════════════════════════════════════════════
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "excessWETH", type: "uint256" },
      { indexed: false, name: "baseReceived", type: "uint256" },
      { indexed: false, name: "newRatio", type: "uint256" },
    ],
    name: "RebalanceSellExecuted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "baseSwapped", type: "uint256" },
      { indexed: false, name: "wethReceived", type: "uint256" },
      { indexed: false, name: "newRatio", type: "uint256" },
    ],
    name: "RebalanceBuyExecuted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "pricePerShare", type: "uint256" },
      { indexed: false, name: "threshold", type: "uint256" },
    ],
    name: "ShortfallPauseTriggered",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [],
    name: "ShortfallUnpaused",
    type: "event",
  },
] as const;

export const ACCOUNTING_ADMIN_ABI = [
  {
    inputs: [],
    name: "s_seniorTVL",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_mezzTVL",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_juniorBaseTVL",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_juniorWethTVL",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_reserveTVL",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_lastUpdateTimestamp",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getSeniorAPR",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getMezzAPR",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const RISK_PARAMS_ABI = [
  // READ
  {
    inputs: [],
    name: "s_seniorPremium",
    outputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "k", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_juniorPremium",
    outputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "k", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_alpha",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_reserveBps",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // WRITE
  {
    inputs: [
      {
        name: "curve",
        type: "tuple",
        components: [
          { name: "x", type: "uint256" },
          { name: "y", type: "uint256" },
          { name: "k", type: "uint256" },
        ],
      },
    ],
    name: "setSeniorPremium",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        name: "curve",
        type: "tuple",
        components: [
          { name: "x", type: "uint256" },
          { name: "y", type: "uint256" },
          { name: "k", type: "uint256" },
        ],
      },
    ],
    name: "setJuniorPremium",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "alpha_", type: "uint256" }],
    name: "setAlpha",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "reserveBps_", type: "uint256" }],
    name: "setReserveBps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const REDEMPTION_POLICY_ABI = [
  // READ
  {
    inputs: [],
    name: "s_mezzParams",
    outputs: [
      { name: "instantCs", type: "uint256" },
      { name: "assetLockCs", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_juniorParams",
    outputs: [
      { name: "instantCs", type: "uint256" },
      { name: "instantCm", type: "uint256" },
      { name: "assetLockCs", type: "uint256" },
      { name: "assetLockCm", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tranche", type: "uint8" }],
    name: "s_mechanismConfig",
    outputs: [
      { name: "instantFeeBps", type: "uint256" },
      { name: "assetsLockFeeBps", type: "uint256" },
      { name: "assetsLockDuration", type: "uint256" },
      { name: "sharesLockFeeBps", type: "uint256" },
      { name: "sharesLockDuration", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getCoverages",
    outputs: [
      { name: "cs", type: "uint256" },
      { name: "cm", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tranche", type: "uint8" }],
    name: "evaluate",
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "mechanism", type: "uint8" },
          { name: "feeBps", type: "uint256" },
          { name: "cooldownDuration", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  // WRITE
  {
    inputs: [
      { name: "instantCs_", type: "uint256" },
      { name: "assetLockCs_", type: "uint256" },
    ],
    name: "setMezzParams",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "instantCs_", type: "uint256" },
      { name: "instantCm_", type: "uint256" },
      { name: "assetLockCs_", type: "uint256" },
      { name: "assetLockCm_", type: "uint256" },
    ],
    name: "setJuniorParams",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "tranche", type: "uint8" },
      {
        name: "config_",
        type: "tuple",
        components: [
          { name: "instantFeeBps", type: "uint256" },
          { name: "assetsLockFeeBps", type: "uint256" },
          { name: "assetsLockDuration", type: "uint256" },
          { name: "sharesLockFeeBps", type: "uint256" },
          { name: "sharesLockDuration", type: "uint256" },
        ],
      },
    ],
    name: "setMechanismConfig",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const SWAP_FACILITY_ABI = [
  // READ
  {
    inputs: [],
    name: "s_maxSlippage",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "s_emergencySlippage",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // WRITE
  {
    inputs: [
      { name: "maxSlippage_", type: "uint256" },
      { name: "emergencySlippage_", type: "uint256" },
    ],
    name: "setSlippage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "cdo", type: "address" },
      { name: "authorized", type: "bool" },
    ],
    name: "setAuthorizedCDO",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    name: "setPoolFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const STRATEGY_ADMIN_ABI = [
  {
    inputs: [],
    name: "pause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "unpause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "paused",
    outputs: [{ name: "", type: "bool" }],
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
    name: "isActive",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
