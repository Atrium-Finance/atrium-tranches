import { createPublicClient, http } from 'viem';

// AtriumSDK.ts

// abis/index.ts
var TRANCHE_ABI = [
  // --- deposit ---
  {
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" }
    ],
    name: "deposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "receiver", type: "address" }
    ],
    name: "deposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  // --- withdraw / redeem (meta-token overloads) ---
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" }
    ],
    name: "withdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" }
    ],
    name: "redeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  // --- previews ---
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "previewDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ name: "sharesGross", type: "uint256" }],
    name: "previewRedeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "shares", type: "uint256" }
    ],
    name: "previewRedeem",
    outputs: [{ name: "tokenAssetsNet", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  // --- conversions / balances ---
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "convertToAssets",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "convertToShares",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "maxRedeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  { inputs: [{ name: "", type: "address" }], name: "maxDeposit", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "name", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "asset", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" }
];
var PRIME_CDO_ABI = [
  { inputs: [], name: "coverage", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MIN_COVERAGE", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [],
    name: "totalAssetsUnlocked",
    outputs: [
      { name: "jr", type: "uint256" },
      { name: "mz", type: "uint256" },
      { name: "sr", type: "uint256" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "tranche", type: "address" },
      { name: "owner", type: "address" }
    ],
    name: "calculateExitMode",
    outputs: [
      { name: "mode", type: "uint8" },
      { name: "fee", type: "uint256" },
      { name: "cooldownSeconds", type: "uint32" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ name: "tranche", type: "address" }],
    name: "maxDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ name: "tranche", type: "address" }],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "tranche", type: "address" },
      { name: "owner", type: "address" }
    ],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  { inputs: [{ name: "tranche", type: "address" }], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "tranche", type: "address" }], name: "kindOf", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "treasury", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "exitFeeJr", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "exitFeeMz", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "exitFeeSr", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "sharesCooldown", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" }
];
var ACCOUNTING_ABI = [
  {
    inputs: [],
    name: "totalAssetsT0",
    outputs: [
      { name: "jrTvl", type: "uint256" },
      { name: "mzTvl", type: "uint256" },
      { name: "srTvl", type: "uint256" },
      { name: "reserveTvl", type: "uint256" }
    ],
    stateMutability: "view",
    type: "function"
  },
  { inputs: [{ name: "tranche", type: "address" }], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aprSrt", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aprBase", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aprTarget", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "srtTargetIndex", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "reserveBps", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "alphaJr", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "alphaMz", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lastUpdateTime", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" }
];
var STRATEGY_ABI = [
  { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" }
];
var SHARES_COOLDOWN_ABI = [
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "account", type: "address" }
    ],
    name: "activeRequestsLength",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "account", type: "address" },
      { name: "i", type: "uint256" }
    ],
    name: "activeRequests",
    outputs: [
      {
        components: [
          { name: "unlockAt", type: "uint64" },
          { name: "shares", type: "uint192" },
          { name: "token", type: "address" }
        ],
        name: "",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "coverage", type: "uint256" }
    ],
    name: "calculateExitParams",
    outputs: [
      {
        components: [
          { name: "feeBps", type: "uint256" },
          { name: "sharesLock", type: "uint32" }
        ],
        name: "",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  },
  // Permissionless finalize (evaluated at now). vault is ITranche here.
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "token", type: "address" },
      { name: "user", type: "address" }
    ],
    name: "finalize",
    outputs: [{ name: "claimed", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  }
];
var APR_PAIR_FEED_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      {
        components: [
          { name: "aprBase", type: "int64" },
          { name: "aprTarget", type: "int64" },
          { name: "updatedAt", type: "uint64" },
          { name: "answeredInRound", type: "uint64" }
        ],
        name: "",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" }
];
var ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
  }
];

// types.ts
var TrancheId = /* @__PURE__ */ ((TrancheId2) => {
  TrancheId2[TrancheId2["JUNIOR"] = 0] = "JUNIOR";
  TrancheId2[TrancheId2["MEZZANINE"] = 1] = "MEZZANINE";
  TrancheId2[TrancheId2["SENIOR"] = 2] = "SENIOR";
  return TrancheId2;
})(TrancheId || {});
var ExitMode = /* @__PURE__ */ ((ExitMode3) => {
  ExitMode3[ExitMode3["ERC4626"] = 0] = "ERC4626";
  ExitMode3[ExitMode3["SharesLock"] = 1] = "SharesLock";
  ExitMode3[ExitMode3["Fee"] = 2] = "Fee";
  ExitMode3[ExitMode3["Dynamic"] = 3] = "Dynamic";
  return ExitMode3;
})(ExitMode || {});

// AtriumSDK.ts
var WAD = 10n ** 18n;
var ALL_TRANCHES = [0 /* JUNIOR */, 1 /* MEZZANINE */, 2 /* SENIOR */];
var AtriumSDK = class {
  constructor(config) {
    this.config = config;
    this.addr = config.addresses;
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl)
    });
  }
  // ═══════════════════════════════════════════════════════════════════
  //  READ — Tranches
  // ═══════════════════════════════════════════════════════════════════
  /** Full info for one tranche (TVL, supply, share price, indicative APR). */
  async getTranche(id) {
    const vault = this._vault(id);
    const aprFn = id === 2 /* SENIOR */ ? "aprSrt" : "aprBase";
    const r = await this.publicClient.multicall({
      contracts: [
        { address: vault, abi: TRANCHE_ABI, functionName: "totalAssets" },
        { address: vault, abi: TRANCHE_ABI, functionName: "totalSupply" },
        { address: vault, abi: TRANCHE_ABI, functionName: "convertToAssets", args: [WAD] },
        { address: vault, abi: TRANCHE_ABI, functionName: "name" },
        { address: vault, abi: TRANCHE_ABI, functionName: "symbol" },
        { address: vault, abi: TRANCHE_ABI, functionName: "asset" },
        { address: this.addr.accounting, abi: ACCOUNTING_ABI, functionName: aprFn }
      ]
    });
    const num = (i) => r[i].status === "success" ? r[i].result : 0n;
    return {
      trancheId: id,
      vault,
      totalAssets: num(0),
      totalSupply: num(1),
      sharePrice: num(2),
      // convertToAssets(1e18)
      name: r[3].status === "success" ? r[3].result : "",
      symbol: r[4].status === "success" ? r[4].result : "",
      asset: r[5].status === "success" ? r[5].result : "",
      apr: num(6)
    };
  }
  /** All three tranches. */
  async getAllTranches() {
    return Promise.all(ALL_TRANCHES.map((id) => this.getTranche(id)));
  }
  // ═══════════════════════════════════════════════════════════════════
  //  READ — Previews
  // ═══════════════════════════════════════════════════════════════════
  /** Shares minted for a USDai deposit. */
  async previewDeposit(id, assets) {
    const vault = this._vault(id);
    const r = await this.publicClient.multicall({
      contracts: [
        { address: vault, abi: TRANCHE_ABI, functionName: "previewDeposit", args: [assets] },
        { address: vault, abi: TRANCHE_ABI, functionName: "convertToAssets", args: [WAD] }
      ]
    });
    return {
      trancheId: id,
      shares: r[0].status === "success" ? r[0].result : 0n,
      sharePrice: r[1].status === "success" ? r[1].result : WAD
    };
  }
  /**
   * Preview a withdrawal: coverage-aware mode/fee/cooldown plus the net
   * output (both in USDai value and in sUSDai the user receives).
   * `owner` matters — the silo-as-owner case returns a fee-free mode.
   */
  async previewWithdraw(id, shares, owner) {
    const vault = this._vault(id);
    const r = await this.publicClient.multicall({
      contracts: [
        {
          address: this.addr.cdo,
          abi: PRIME_CDO_ABI,
          functionName: "calculateExitMode",
          args: [vault, owner]
        },
        { address: vault, abi: TRANCHE_ABI, functionName: "previewRedeem", args: [shares] },
        { address: vault, abi: TRANCHE_ABI, functionName: "previewRedeem", args: [this.addr.susdai, shares] }
      ]
    });
    const exit = r[0].status === "success" ? r[0].result : [0, 0n, 0];
    return {
      trancheId: id,
      mode: Number(exit[0]),
      fee: exit[1],
      cooldownSeconds: Number(exit[2]),
      netBaseAssets: r[1].status === "success" ? r[1].result : 0n,
      outputTokenAmount: r[2].status === "success" ? r[2].result : 0n
    };
  }
  // ═══════════════════════════════════════════════════════════════════
  //  READ — Protocol health & APR
  // ═══════════════════════════════════════════════════════════════════
  async getProtocolHealth() {
    const r = await this.publicClient.multicall({
      contracts: [
        { address: this.addr.cdo, abi: PRIME_CDO_ABI, functionName: "coverage" },
        { address: this.addr.cdo, abi: PRIME_CDO_ABI, functionName: "MIN_COVERAGE" },
        { address: this.addr.accounting, abi: ACCOUNTING_ABI, functionName: "totalAssetsT0" },
        { address: this.addr.strategy, abi: STRATEGY_ABI, functionName: "totalAssets" }
      ]
    });
    const tvls = r[2].status === "success" ? r[2].result : [0n, 0n, 0n, 0n];
    const [jrTvl, mzTvl, srTvl, reserveTvl] = tvls;
    return {
      coverage: r[0].status === "success" ? r[0].result : 0n,
      minCoverage: r[1].status === "success" ? r[1].result : 0n,
      jrTvl,
      mzTvl,
      srTvl,
      reserveTvl,
      totalTvl: jrTvl + mzTvl + srTvl + reserveTvl,
      strategyTvl: r[3].status === "success" ? r[3].result : 0n
    };
  }
  /** Raw APR pipeline state (all 1e18-scaled). */
  async getApr() {
    const r = await this.publicClient.multicall({
      contracts: [
        { address: this.addr.accounting, abi: ACCOUNTING_ABI, functionName: "aprSrt" },
        { address: this.addr.accounting, abi: ACCOUNTING_ABI, functionName: "aprBase" },
        { address: this.addr.accounting, abi: ACCOUNTING_ABI, functionName: "aprTarget" },
        { address: this.addr.accounting, abi: ACCOUNTING_ABI, functionName: "srtTargetIndex" }
      ]
    });
    const num = (i) => r[i].status === "success" ? r[i].result : 0n;
    return { aprSrt: num(0), aprBase: num(1), aprTarget: num(2), srtTargetIndex: num(3) };
  }
  // ═══════════════════════════════════════════════════════════════════
  //  READ — User state
  // ═══════════════════════════════════════════════════════════════════
  /** Pending + claimable share-lock withdraw requests across all tranches. */
  async getUserWithdrawRequests(user) {
    const silo = this.addr.sharesCooldown;
    const vaults = ALL_TRANCHES.map((id) => ({ id, vault: this._vault(id) }));
    const lengths = await this.publicClient.multicall({
      contracts: vaults.map((v) => ({
        address: silo,
        abi: SHARES_COOLDOWN_ABI,
        functionName: "activeRequestsLength",
        args: [v.vault, user]
      }))
    });
    const calls = [];
    vaults.forEach((v, vi) => {
      const len = lengths[vi].status === "success" ? Number(lengths[vi].result) : 0;
      for (let i = 0; i < len; i++) calls.push({ id: v.id, vault: v.vault, i });
    });
    if (calls.length === 0) return [];
    const reqs = await this.publicClient.multicall({
      contracts: calls.map((c) => ({
        address: silo,
        abi: SHARES_COOLDOWN_ABI,
        functionName: "activeRequests",
        args: [c.vault, user, BigInt(c.i)]
      }))
    });
    const now = BigInt(Math.floor(Date.now() / 1e3));
    return reqs.map((res, k) => {
      const c = calls[k];
      const req = res.status === "success" ? res.result : null;
      const unlockAt = req ? BigInt(req.unlockAt) : 0n;
      const claimable = unlockAt <= now;
      return {
        trancheId: c.id,
        vault: c.vault,
        index: c.i,
        shares: req ? BigInt(req.shares) : 0n,
        token: req ? req.token : "",
        unlockAt,
        isClaimable: claimable,
        timeRemaining: claimable ? 0n : unlockAt - now
      };
    });
  }
  async getTokenBalance(token, user) {
    return await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user]
    });
  }
  async getTokenAllowance(token, owner, spender) {
    return await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender]
    });
  }
  async getShareBalance(id, user) {
    return await this.publicClient.readContract({
      address: this._vault(id),
      abi: TRANCHE_ABI,
      functionName: "balanceOf",
      args: [user]
    });
  }
  /** Aggregated user position across all three tranches (in USDai value). */
  async getUserPortfolio(user) {
    const vaults = ALL_TRANCHES.map((id) => this._vault(id));
    const bal = await this.publicClient.multicall({
      contracts: vaults.map((v) => ({
        address: v,
        abi: TRANCHE_ABI,
        functionName: "balanceOf",
        args: [user]
      }))
    });
    const shares = bal.map((r) => r.status === "success" ? r.result : 0n);
    const conv = await this.publicClient.multicall({
      contracts: vaults.map((v, i) => ({
        address: v,
        abi: TRANCHE_ABI,
        functionName: "convertToAssets",
        args: [shares[i]]
      }))
    });
    const assets = conv.map((r) => r.status === "success" ? r.result : 0n);
    return {
      junior: { shares: shares[0], assets: assets[0] },
      mezzanine: { shares: shares[1], assets: assets[1] },
      senior: { shares: shares[2], assets: assets[2] },
      totalAssets: assets[0] + assets[1] + assets[2]
    };
  }
  // ═══════════════════════════════════════════════════════════════════
  //  WRITE BUILDERS — pass the result to walletClient.writeContract(...)
  // ═══════════════════════════════════════════════════════════════════
  /** Approve `spender` to pull `amount` of `token` (e.g. USDai → tranche). */
  buildApprove(token, spender, amount) {
    return {
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount]
    };
  }
  /** Deposit `assets` USDai into a tranche. Requires a prior USDai approve. */
  buildDeposit(id, assets, receiver) {
    return {
      address: this._vault(id),
      abi: TRANCHE_ABI,
      functionName: "deposit",
      args: [assets, receiver]
    };
  }
  /**
   * Redeem `shares` from a tranche, receiving sUSDai. Uses the meta-token
   * `redeem(token, shares, receiver, owner)` overload with token = sUSDai —
   * the plain ERC-4626 overload routes USDai which the v1 Strategy rejects.
   * ALWAYS simulate first to surface coverage/pause reverts.
   */
  buildWithdraw(id, shares, receiver, owner) {
    return {
      address: this._vault(id),
      abi: TRANCHE_ABI,
      functionName: "redeem",
      args: [this.addr.susdai, shares, receiver, owner]
    };
  }
  /** Finalize a matured share-lock request, releasing sUSDai to `user`. */
  buildFinalizeCooldown(id, user) {
    return {
      address: this.addr.sharesCooldown,
      abi: SHARES_COOLDOWN_ABI,
      functionName: "finalize",
      args: [this._vault(id), this.addr.susdai, user]
    };
  }
  // ═══════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════════
  _vault(id) {
    if (id === 0 /* JUNIOR */) return this.addr.jrVault;
    if (id === 1 /* MEZZANINE */) return this.addr.mzVault;
    return this.addr.srVault;
  }
};

// abis/admin.ts
var PRIME_CDO_ADMIN_ABI = [
  // reads — per-tranche pause state
  {
    inputs: [],
    name: "actionsJr",
    outputs: [
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "actionsMezz",
    outputs: [
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "actionsSr",
    outputs: [
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" }
    ],
    stateMutability: "view",
    type: "function"
  },
  // writes
  {
    inputs: [
      { name: "tranche", type: "address" },
      // address(0) fans out to all three
      { name: "isDepositEnabled", type: "bool" },
      { name: "isWithdrawEnabled", type: "bool" }
    ],
    name: "setActionStates",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "jr", type: "uint256" },
      { name: "mz", type: "uint256" },
      { name: "sr", type: "uint256" }
    ],
    name: "setExitFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [{ name: "treasury_", type: "address" }], name: "setReserveTreasury", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "sharesCooldown_", type: "address" }], name: "setSharesCooldown", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    name: "reduceReserve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "jr", type: "address" },
      { name: "mz", type: "address" },
      { name: "sr", type: "address" },
      { name: "accounting", type: "address" },
      { name: "strategy", type: "address" }
    ],
    name: "config",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];
var ACCOUNTING_ADMIN_ABI = [
  { inputs: [], name: "riskX", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "riskY", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "riskK", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { name: "riskX_", type: "uint256" },
      { name: "riskY_", type: "uint256" },
      { name: "riskK_", type: "uint256" }
    ],
    name: "setRiskParameters",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "jr", type: "uint256" },
      { name: "mz", type: "uint256" }
    ],
    name: "setAlphaWeights",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [{ name: "bps", type: "uint256" }], name: "setReserveBps", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "onAprChanged", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "aprPairFeed_", type: "address" }], name: "setAprPairFeed", outputs: [], stateMutability: "nonpayable", type: "function" }
];
var SHARES_COOLDOWN_ADMIN_ABI = [
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
              { name: "sharesLock", type: "uint32" }
            ]
          },
          {
            name: "r1",
            type: "tuple",
            components: [
              { name: "feeBps", type: "uint256" },
              { name: "sharesLock", type: "uint32" }
            ]
          },
          {
            name: "r2",
            type: "tuple",
            components: [
              { name: "feeBps", type: "uint256" },
              { name: "sharesLock", type: "uint32" }
            ]
          }
        ]
      }
    ],
    name: "setVaultExitBounds",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "vault", type: "address" },
      { name: "fee", type: "uint256" }
    ],
    name: "setVaultEarlyExitFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];
var STRATEGY_ADMIN_ABI = [
  {
    inputs: [
      { name: "jr", type: "uint32" },
      { name: "mz", type: "uint32" },
      { name: "sr", type: "uint32" }
    ],
    name: "setCooldowns",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];
var ACM_ABI = [
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" }
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" }
    ],
    name: "revokeRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" }
    ],
    name: "hasRole",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "contractAddress", type: "address" },
      { name: "sel", type: "bytes4" },
      { name: "accountToPermit", type: "address" }
    ],
    name: "grantCall",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];

export { ACCOUNTING_ABI, ACCOUNTING_ADMIN_ABI, ACM_ABI, APR_PAIR_FEED_ABI, AtriumSDK, ERC20_ABI, ExitMode, PRIME_CDO_ABI, PRIME_CDO_ADMIN_ABI, SHARES_COOLDOWN_ABI, SHARES_COOLDOWN_ADMIN_ABI, STRATEGY_ABI, STRATEGY_ADMIN_ABI, TRANCHE_ABI, TrancheId };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map