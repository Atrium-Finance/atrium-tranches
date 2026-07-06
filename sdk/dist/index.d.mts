import { Chain, PublicClient } from 'viem';

/**
 * On-chain tranche identity. Matches the Solidity `TrancheKind` enum
 * ordering exactly: JUNIOR = 0, MEZZANINE = 1, SENIOR = 2.
 */
declare enum TrancheId {
    JUNIOR = 0,
    MEZZANINE = 1,
    SENIOR = 2
}
/**
 * Coverage-aware exit mode returned by `PrimeCDO.calculateExitMode`.
 * Matches the Solidity `TExitMode` enum. `Dynamic` is a caller-side
 * sentinel only — the CDO never returns it.
 */
declare enum ExitMode {
    ERC4626 = 0,// instant redeem, no fee/lock
    SharesLock = 1,// shares escrowed in SharesCooldown for `cooldownSeconds`
    Fee = 2,// instant redeem minus an exit fee
    Dynamic = 3
}
interface AtriumConfig {
    rpcUrl: string;
    chain: Chain;
    addresses: ContractAddresses;
}
interface ContractAddresses {
    /** PrimeCDO orchestrator (reads: coverage, exit mode, max limits). */
    cdo: string;
    /** Accounting (reads: TVLs, APRs, senior index). */
    accounting: string;
    /** USDAStrategy (reads: totalAssets). */
    strategy: string;
    /** The three ERC-4626 tranche vaults. */
    jrVault: string;
    mzVault: string;
    srVault: string;
    /** SharesCooldown silo (pending share-lock withdraw requests). */
    sharesCooldown: string;
    /** Base asset — USDai. Deposits approve/transfer this. */
    usdai: string;
    /** Output/alternative token — sUSDai. Withdraws are denominated here. */
    susdai: string;
    /** Optional — ERC20Cooldown silo (token-side lock). */
    erc20Cooldown?: string;
    /** Optional — AprPairFeed oracle (raw round data). */
    aprFeed?: string;
}
interface TrancheInfo {
    trancheId: TrancheId;
    vault: string;
    name: string;
    symbol: string;
    asset: string;
    /** USDai-denominated TVL (this tranche's bucket). */
    totalAssets: bigint;
    /** Outstanding vault shares. */
    totalSupply: bigint;
    /** Assets per 1e18 share (1e18-scaled). */
    sharePrice: bigint;
    /** Indicative APR for this tranche, 1e18-scaled (Senior = target, Jr/Mz = base). */
    apr: bigint;
}
interface PreviewDeposit {
    trancheId: TrancheId;
    /** Shares minted for `assets` USDai. */
    shares: bigint;
    /** Assets per 1e18 share at preview time (1e18-scaled). */
    sharePrice: bigint;
}
interface PreviewWithdraw {
    trancheId: TrancheId;
    /** Exit mode the CDO would apply at current coverage. */
    mode: ExitMode;
    /** Exit fee rate, 1e18-scaled (e.g. 0.01e18 = 1%). */
    fee: bigint;
    /** Cooldown lock in seconds (SharesLock mode). */
    cooldownSeconds: number;
    /** Net USDai value of the redeemed shares, fee already applied. */
    netBaseAssets: bigint;
    /** Net amount denominated in the output token (sUSDai) the user receives. */
    outputTokenAmount: bigint;
}
interface ProtocolHealth {
    /** Senior coverage = pool / seniorNav, 1e18-scaled. type(uint256).max when Sr TVL is 0. */
    coverage: bigint;
    /** Hardcoded minimum coverage gate (1.05e18). */
    minCoverage: bigint;
    jrTvl: bigint;
    mzTvl: bigint;
    srTvl: bigint;
    reserveTvl: bigint;
    totalTvl: bigint;
    /** Strategy's reported USDai TVL (sUSDai valued conservatively + idle USDai). */
    strategyTvl: bigint;
}
interface PendingWithdraw {
    trancheId: TrancheId;
    vault: string;
    /** Index of the request in the silo's per-user queue. */
    index: number;
    /** Escrowed vault shares. */
    shares: bigint;
    /** Token the request redeems into (usually sUSDai). */
    token: string;
    unlockAt: bigint;
    isClaimable: boolean;
    /** Seconds until unlock (0 when claimable). */
    timeRemaining: bigint;
}
interface AprData {
    /** Senior delivered target rate, 1e18-scaled. */
    aprSrt: bigint;
    /** Strategy base APR, 1e18-scaled. */
    aprBase: bigint;
    /** Senior floor target, 1e18-scaled. */
    aprTarget: bigint;
    /** Senior compounding index (1e18 baseline). */
    srtTargetIndex: bigint;
}
interface UserPortfolio {
    junior: {
        shares: bigint;
        assets: bigint;
    };
    mezzanine: {
        shares: bigint;
        assets: bigint;
    };
    senior: {
        shares: bigint;
        assets: bigint;
    };
    /** Total USDai value across all three tranches. */
    totalAssets: bigint;
}
/** A viem-compatible contract write request (pass to walletClient.writeContract). */
interface TxRequest {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
}

/**
 * Read-focused SDK for the Atrium three-tranche CDO. Wraps a viem
 * PublicClient for on-chain reads and exposes `build*` helpers that
 * return viem write requests for the FE to submit via a WalletClient.
 *
 * Users interact with the three Tranche vaults (never PrimeCDO directly).
 * Deposits use the base asset (USDai); withdraws are denominated in the
 * output token (sUSDai) via the meta-token `redeem(token, ...)` overload.
 */
declare class AtriumSDK {
    readonly config: AtriumConfig;
    readonly addr: ContractAddresses;
    readonly publicClient: PublicClient;
    constructor(config: AtriumConfig);
    /** Full info for one tranche (TVL, supply, share price, indicative APR). */
    getTranche(id: TrancheId): Promise<TrancheInfo>;
    /** All three tranches. */
    getAllTranches(): Promise<TrancheInfo[]>;
    /** Shares minted for a USDai deposit. */
    previewDeposit(id: TrancheId, assets: bigint): Promise<PreviewDeposit>;
    /**
     * Preview a withdrawal: coverage-aware mode/fee/cooldown plus the net
     * output (both in USDai value and in sUSDai the user receives).
     * `owner` matters — the silo-as-owner case returns a fee-free mode.
     */
    previewWithdraw(id: TrancheId, shares: bigint, owner: string): Promise<PreviewWithdraw>;
    getProtocolHealth(): Promise<ProtocolHealth>;
    /** Raw APR pipeline state (all 1e18-scaled). */
    getApr(): Promise<AprData>;
    /** Pending + claimable share-lock withdraw requests across all tranches. */
    getUserWithdrawRequests(user: string): Promise<PendingWithdraw[]>;
    getTokenBalance(token: string, user: string): Promise<bigint>;
    getTokenAllowance(token: string, owner: string, spender: string): Promise<bigint>;
    getShareBalance(id: TrancheId, user: string): Promise<bigint>;
    /** Aggregated user position across all three tranches (in USDai value). */
    getUserPortfolio(user: string): Promise<UserPortfolio>;
    /** Approve `spender` to pull `amount` of `token` (e.g. USDai → tranche). */
    buildApprove(token: string, spender: string, amount: bigint): TxRequest;
    /** Deposit `assets` USDai into a tranche. Requires a prior USDai approve. */
    buildDeposit(id: TrancheId, assets: bigint, receiver: string): TxRequest;
    /**
     * Redeem `shares` from a tranche, receiving sUSDai. Uses the meta-token
     * `redeem(token, shares, receiver, owner)` overload with token = sUSDai —
     * the plain ERC-4626 overload routes USDai which the v1 Strategy rejects.
     * ALWAYS simulate first to surface coverage/pause reverts.
     */
    buildWithdraw(id: TrancheId, shares: bigint, receiver: string, owner: string): TxRequest;
    /** Finalize a matured share-lock request, releasing sUSDai to `user`. */
    buildFinalizeCooldown(id: TrancheId, user: string): TxRequest;
    private _vault;
}

/**
 * Tranche — the ERC-4626 meta-vault (one deployment each for Jr/Mz/Sr).
 * Includes the standard ERC-4626 surface plus Atrium's meta-token
 * overloads. Withdraw/redeem MUST use the `(token, ...)` overload with
 * `token = sUSDai`; the plain overload routes the base asset which the
 * v1 Strategy rejects.
 */
declare const TRANCHE_ABI: readonly [{
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly name: "deposit";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "tokenAmount";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly name: "deposit";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "tokenAmount";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly name: "withdraw";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly name: "redeem";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly name: "previewDeposit";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "sharesGross";
        readonly type: "uint256";
    }];
    readonly name: "previewRedeem";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }];
    readonly name: "previewRedeem";
    readonly outputs: readonly [{
        readonly name: "tokenAssetsNet";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
    readonly name: "convertToAssets";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly name: "convertToShares";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "totalAssets";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "totalSupply";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly name: "balanceOf";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly name: "maxWithdraw";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly name: "maxRedeem";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly name: "maxDeposit";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "name";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "symbol";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "decimals";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "asset";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
/**
 * PrimeCDO — orchestrator. Read-only surface the SDK uses plus the
 * enum-returning `calculateExitMode`.
 */
declare const PRIME_CDO_ABI: readonly [{
    readonly inputs: readonly [];
    readonly name: "coverage";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "MIN_COVERAGE";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "totalAssetsUnlocked";
    readonly outputs: readonly [{
        readonly name: "jr";
        readonly type: "uint256";
    }, {
        readonly name: "mz";
        readonly type: "uint256";
    }, {
        readonly name: "sr";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly name: "calculateExitMode";
    readonly outputs: readonly [{
        readonly name: "mode";
        readonly type: "uint8";
    }, {
        readonly name: "fee";
        readonly type: "uint256";
    }, {
        readonly name: "cooldownSeconds";
        readonly type: "uint32";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }];
    readonly name: "maxDeposit";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }];
    readonly name: "maxWithdraw";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly name: "maxWithdraw";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }];
    readonly name: "totalAssets";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }];
    readonly name: "kindOf";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "treasury";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "exitFeeJr";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "exitFeeMz";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "exitFeeSr";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "sharesCooldown";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
/** Accounting — TVL buckets, APR pipeline, senior index. */
declare const ACCOUNTING_ABI: readonly [{
    readonly inputs: readonly [];
    readonly name: "totalAssetsT0";
    readonly outputs: readonly [{
        readonly name: "jrTvl";
        readonly type: "uint256";
    }, {
        readonly name: "mzTvl";
        readonly type: "uint256";
    }, {
        readonly name: "srTvl";
        readonly type: "uint256";
    }, {
        readonly name: "reserveTvl";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }];
    readonly name: "totalAssets";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "aprSrt";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "aprBase";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "aprTarget";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "srtTargetIndex";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "reserveBps";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "alphaJr";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "alphaMz";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "lastUpdateTime";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
/** Strategy — single TVL report. */
declare const STRATEGY_ABI: readonly [{
    readonly inputs: readonly [];
    readonly name: "totalAssets";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
/** SharesCooldown — per-user pending share-lock requests. */
declare const SHARES_COOLDOWN_ABI: readonly [{
    readonly inputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "account";
        readonly type: "address";
    }];
    readonly name: "activeRequestsLength";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "account";
        readonly type: "address";
    }, {
        readonly name: "i";
        readonly type: "uint256";
    }];
    readonly name: "activeRequests";
    readonly outputs: readonly [{
        readonly components: readonly [{
            readonly name: "unlockAt";
            readonly type: "uint64";
        }, {
            readonly name: "shares";
            readonly type: "uint192";
        }, {
            readonly name: "token";
            readonly type: "address";
        }];
        readonly name: "";
        readonly type: "tuple";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "coverage";
        readonly type: "uint256";
    }];
    readonly name: "calculateExitParams";
    readonly outputs: readonly [{
        readonly components: readonly [{
            readonly name: "feeBps";
            readonly type: "uint256";
        }, {
            readonly name: "sharesLock";
            readonly type: "uint32";
        }];
        readonly name: "";
        readonly type: "tuple";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "user";
        readonly type: "address";
    }];
    readonly name: "finalize";
    readonly outputs: readonly [{
        readonly name: "claimed";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
/** AprPairFeed — raw round data (aprBase/aprTarget are SD7x12, 12 decimals). */
declare const APR_PAIR_FEED_ABI: readonly [{
    readonly inputs: readonly [];
    readonly name: "latestRoundData";
    readonly outputs: readonly [{
        readonly components: readonly [{
            readonly name: "aprBase";
            readonly type: "int64";
        }, {
            readonly name: "aprTarget";
            readonly type: "int64";
        }, {
            readonly name: "updatedAt";
            readonly type: "uint64";
        }, {
            readonly name: "answeredInRound";
            readonly type: "uint64";
        }];
        readonly name: "";
        readonly type: "tuple";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "decimals";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
/** Standard ERC-20 surface (USDai / sUSDai). */
declare const ERC20_ABI: readonly [{
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly name: "balanceOf";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly name: "spender";
        readonly type: "address";
    }];
    readonly name: "allowance";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "approve";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];

/** PrimeCDO — pause, exit fees, reserve, wiring. */
declare const PRIME_CDO_ADMIN_ABI: readonly [{
    readonly inputs: readonly [];
    readonly name: "actionsJr";
    readonly outputs: readonly [{
        readonly name: "isDepositEnabled";
        readonly type: "bool";
    }, {
        readonly name: "isWithdrawEnabled";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "actionsMezz";
    readonly outputs: readonly [{
        readonly name: "isDepositEnabled";
        readonly type: "bool";
    }, {
        readonly name: "isWithdrawEnabled";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "actionsSr";
    readonly outputs: readonly [{
        readonly name: "isDepositEnabled";
        readonly type: "bool";
    }, {
        readonly name: "isWithdrawEnabled";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }, {
        readonly name: "isDepositEnabled";
        readonly type: "bool";
    }, {
        readonly name: "isWithdrawEnabled";
        readonly type: "bool";
    }];
    readonly name: "setActionStates";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "jr";
        readonly type: "uint256";
    }, {
        readonly name: "mz";
        readonly type: "uint256";
    }, {
        readonly name: "sr";
        readonly type: "uint256";
    }];
    readonly name: "setExitFees";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "treasury_";
        readonly type: "address";
    }];
    readonly name: "setReserveTreasury";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "sharesCooldown_";
        readonly type: "address";
    }];
    readonly name: "setSharesCooldown";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "reduceReserve";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "jr";
        readonly type: "address";
    }, {
        readonly name: "mz";
        readonly type: "address";
    }, {
        readonly name: "sr";
        readonly type: "address";
    }, {
        readonly name: "accounting";
        readonly type: "address";
    }, {
        readonly name: "strategy";
        readonly type: "address";
    }];
    readonly name: "config";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
/** Accounting — risk params, alpha weights, reserve rate, APR triggers. */
declare const ACCOUNTING_ADMIN_ABI: readonly [{
    readonly inputs: readonly [];
    readonly name: "riskX";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "riskY";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "riskK";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "riskX_";
        readonly type: "uint256";
    }, {
        readonly name: "riskY_";
        readonly type: "uint256";
    }, {
        readonly name: "riskK_";
        readonly type: "uint256";
    }];
    readonly name: "setRiskParameters";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "jr";
        readonly type: "uint256";
    }, {
        readonly name: "mz";
        readonly type: "uint256";
    }];
    readonly name: "setAlphaWeights";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "bps";
        readonly type: "uint256";
    }];
    readonly name: "setReserveBps";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "onAprChanged";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "aprPairFeed_";
        readonly type: "address";
    }];
    readonly name: "setAprPairFeed";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
/** SharesCooldown — per-vault coverage exit ranges + early-exit fee. */
declare const SHARES_COOLDOWN_ADMIN_ABI: readonly [{
    readonly inputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "bounds";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "p0";
            readonly type: "uint256";
        }, {
            readonly name: "p1";
            readonly type: "uint256";
        }, {
            readonly name: "r0";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "feeBps";
                readonly type: "uint256";
            }, {
                readonly name: "sharesLock";
                readonly type: "uint32";
            }];
        }, {
            readonly name: "r1";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "feeBps";
                readonly type: "uint256";
            }, {
                readonly name: "sharesLock";
                readonly type: "uint32";
            }];
        }, {
            readonly name: "r2";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "feeBps";
                readonly type: "uint256";
            }, {
                readonly name: "sharesLock";
                readonly type: "uint32";
            }];
        }];
    }];
    readonly name: "setVaultExitBounds";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "fee";
        readonly type: "uint256";
    }];
    readonly name: "setVaultEarlyExitFee";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
/** USDAStrategy — per-tranche withdrawal cooldown durations. */
declare const STRATEGY_ADMIN_ABI: readonly [{
    readonly inputs: readonly [{
        readonly name: "jr";
        readonly type: "uint32";
    }, {
        readonly name: "mz";
        readonly type: "uint32";
    }, {
        readonly name: "sr";
        readonly type: "uint32";
    }];
    readonly name: "setCooldowns";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
/** AccessControlManager — role + call-based grant surface. */
declare const ACM_ABI: readonly [{
    readonly inputs: readonly [{
        readonly name: "role";
        readonly type: "bytes32";
    }, {
        readonly name: "account";
        readonly type: "address";
    }];
    readonly name: "grantRole";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "role";
        readonly type: "bytes32";
    }, {
        readonly name: "account";
        readonly type: "address";
    }];
    readonly name: "revokeRole";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "role";
        readonly type: "bytes32";
    }, {
        readonly name: "account";
        readonly type: "address";
    }];
    readonly name: "hasRole";
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly name: "contractAddress";
        readonly type: "address";
    }, {
        readonly name: "sel";
        readonly type: "bytes4";
    }, {
        readonly name: "accountToPermit";
        readonly type: "address";
    }];
    readonly name: "grantCall";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];

export { ACCOUNTING_ABI, ACCOUNTING_ADMIN_ABI, ACM_ABI, APR_PAIR_FEED_ABI, type AprData, type AtriumConfig, AtriumSDK, type ContractAddresses, ERC20_ABI, ExitMode, PRIME_CDO_ABI, PRIME_CDO_ADMIN_ABI, type PendingWithdraw, type PreviewDeposit, type PreviewWithdraw, type ProtocolHealth, SHARES_COOLDOWN_ABI, SHARES_COOLDOWN_ADMIN_ABI, STRATEGY_ABI, STRATEGY_ADMIN_ABI, TRANCHE_ABI, TrancheId, type TrancheInfo, type TxRequest, type UserPortfolio };
