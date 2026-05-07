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
    name: "s_guardian",
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
  //  WRITE — Configuration (owner)
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
    inputs: [{ name: "guardian_", type: "address" }],
    name: "setGuardian",
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
  //  WRITE — Emergency (owner OR guardian)
  // ═══════════════════════════════════════════════════════════════════
  {
    inputs: [],
    name: "unpauseShortfall",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "triggerShortfallPause",
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
  {
    anonymous: false,
    inputs: [{ indexed: true, name: "guardian", type: "address" }],
    name: "GuardianSet",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: "guardian", type: "address" }],
    name: "EmergencyPauseTriggered",
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
    name: "s_seniorPrincipal",
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
    name: "getSeniorAPY",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getMezzAPY",
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

export const APR_PAIR_FEED_ADMIN_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      {
        components: [
          { name: "aprTargetSenior", type: "int64" },
          { name: "aprTargetMezz", type: "int64" },
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
    inputs: [],
    name: "updateRoundData",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "tranche", type: "uint8" },
      { name: "value", type: "int64" },
      { name: "timestamp", type: "uint64" },
    ],
    name: "pushAprTarget",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "value", type: "int64" },
      { name: "timestamp", type: "uint64" },
    ],
    name: "pushAprBase",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "roundId", type: "uint64" },
      { indexed: false, name: "aprTargetSenior", type: "int64" },
      { indexed: false, name: "aprTargetMezz", type: "int64" },
      { indexed: false, name: "aprBase", type: "int64" },
      { indexed: false, name: "updatedAt", type: "uint64" },
    ],
    name: "RoundUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "tranche", type: "uint8" },
      { indexed: false, name: "roundId", type: "uint64" },
      { indexed: false, name: "value", type: "int64" },
      { indexed: false, name: "updatedAt", type: "uint64" },
    ],
    name: "AprTargetPushed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "roundId", type: "uint64" },
      { indexed: false, name: "value", type: "int64" },
      { indexed: false, name: "updatedAt", type: "uint64" },
    ],
    name: "AprBasePushed",
    type: "event",
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
  {
    inputs: [],
    name: "s_guardian",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "guardian_", type: "address" }],
    name: "setGuardian",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
