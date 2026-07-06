import { createPublicClient, http, type PublicClient, type Address, type Abi } from "viem";
import {
  TRANCHE_ABI,
  PRIME_CDO_ABI,
  ACCOUNTING_ABI,
  STRATEGY_ABI,
  SHARES_COOLDOWN_ABI,
  ERC20_ABI,
} from "./abis";
import { ExitMode, TrancheId } from "./types";
import type {
  AtriumConfig,
  ContractAddresses,
  TrancheInfo,
  PreviewDeposit,
  PreviewWithdraw,
  PendingWithdraw,
  ProtocolHealth,
  AprData,
  UserPortfolio,
  TxRequest,
} from "./types";

const WAD = 10n ** 18n;

const ALL_TRANCHES = [TrancheId.JUNIOR, TrancheId.MEZZANINE, TrancheId.SENIOR] as const;

/**
 * Read-focused SDK for the Atrium three-tranche CDO. Wraps a viem
 * PublicClient for on-chain reads and exposes `build*` helpers that
 * return viem write requests for the FE to submit via a WalletClient.
 *
 * Users interact with the three Tranche vaults (never PrimeCDO directly).
 * Deposits use the base asset (USDai); withdraws are denominated in the
 * output token (sUSDai) via the meta-token `redeem(token, ...)` overload.
 */
export class AtriumSDK {
  readonly config: AtriumConfig;
  readonly addr: ContractAddresses;
  readonly publicClient: PublicClient;

  constructor(config: AtriumConfig) {
    this.config = config;
    this.addr = config.addresses;
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl),
    }) as PublicClient;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Tranches
  // ═══════════════════════════════════════════════════════════════════

  /** Full info for one tranche (TVL, supply, share price, indicative APR). */
  async getTranche(id: TrancheId): Promise<TrancheInfo> {
    const vault = this._vault(id) as Address;
    const aprFn = id === TrancheId.SENIOR ? "aprSrt" : "aprBase";

    const r = await this.publicClient.multicall({
      contracts: [
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "totalAssets" },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "totalSupply" },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "convertToAssets", args: [WAD] },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "name" },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "symbol" },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "asset" },
        { address: this.addr.accounting as Address, abi: ACCOUNTING_ABI as Abi, functionName: aprFn },
      ],
    });

    const num = (i: number) => (r[i].status === "success" ? (r[i].result as bigint) : 0n);
    return {
      trancheId: id,
      vault,
      totalAssets: num(0),
      totalSupply: num(1),
      sharePrice: num(2), // convertToAssets(1e18)
      name: r[3].status === "success" ? (r[3].result as string) : "",
      symbol: r[4].status === "success" ? (r[4].result as string) : "",
      asset: r[5].status === "success" ? (r[5].result as string) : "",
      apr: num(6),
    };
  }

  /** All three tranches. */
  async getAllTranches(): Promise<TrancheInfo[]> {
    return Promise.all(ALL_TRANCHES.map((id) => this.getTranche(id)));
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Previews
  // ═══════════════════════════════════════════════════════════════════

  /** Shares minted for a USDai deposit. */
  async previewDeposit(id: TrancheId, assets: bigint): Promise<PreviewDeposit> {
    const vault = this._vault(id) as Address;
    const r = await this.publicClient.multicall({
      contracts: [
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "previewDeposit", args: [assets] },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "convertToAssets", args: [WAD] },
      ],
    });
    return {
      trancheId: id,
      shares: r[0].status === "success" ? (r[0].result as bigint) : 0n,
      sharePrice: r[1].status === "success" ? (r[1].result as bigint) : WAD,
    };
  }

  /**
   * Preview a withdrawal: coverage-aware mode/fee/cooldown plus the net
   * output (both in USDai value and in sUSDai the user receives).
   * `owner` matters — the silo-as-owner case returns a fee-free mode.
   */
  async previewWithdraw(id: TrancheId, shares: bigint, owner: string): Promise<PreviewWithdraw> {
    const vault = this._vault(id) as Address;
    const r = await this.publicClient.multicall({
      contracts: [
        {
          address: this.addr.cdo as Address,
          abi: PRIME_CDO_ABI as Abi,
          functionName: "calculateExitMode",
          args: [vault, owner as Address],
        },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "previewRedeem", args: [shares] },
        { address: vault, abi: TRANCHE_ABI as Abi, functionName: "previewRedeem", args: [this.addr.susdai as Address, shares] },
      ],
    });

    const exit = r[0].status === "success" ? (r[0].result as readonly [number, bigint, number]) : [0, 0n, 0];
    return {
      trancheId: id,
      mode: Number(exit[0]) as ExitMode,
      fee: exit[1] as bigint,
      cooldownSeconds: Number(exit[2]),
      netBaseAssets: r[1].status === "success" ? (r[1].result as bigint) : 0n,
      outputTokenAmount: r[2].status === "success" ? (r[2].result as bigint) : 0n,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Protocol health & APR
  // ═══════════════════════════════════════════════════════════════════

  async getProtocolHealth(): Promise<ProtocolHealth> {
    const r = await this.publicClient.multicall({
      contracts: [
        { address: this.addr.cdo as Address, abi: PRIME_CDO_ABI as Abi, functionName: "coverage" },
        { address: this.addr.cdo as Address, abi: PRIME_CDO_ABI as Abi, functionName: "MIN_COVERAGE" },
        { address: this.addr.accounting as Address, abi: ACCOUNTING_ABI as Abi, functionName: "totalAssetsT0" },
        { address: this.addr.strategy as Address, abi: STRATEGY_ABI as Abi, functionName: "totalAssets" },
      ],
    });

    const tvls = r[2].status === "success" ? (r[2].result as readonly [bigint, bigint, bigint, bigint]) : [0n, 0n, 0n, 0n];
    const [jrTvl, mzTvl, srTvl, reserveTvl] = tvls;
    return {
      coverage: r[0].status === "success" ? (r[0].result as bigint) : 0n,
      minCoverage: r[1].status === "success" ? (r[1].result as bigint) : 0n,
      jrTvl,
      mzTvl,
      srTvl,
      reserveTvl,
      totalTvl: jrTvl + mzTvl + srTvl + reserveTvl,
      strategyTvl: r[3].status === "success" ? (r[3].result as bigint) : 0n,
    };
  }

  /** Raw APR pipeline state (all 1e18-scaled). */
  async getApr(): Promise<AprData> {
    const r = await this.publicClient.multicall({
      contracts: [
        { address: this.addr.accounting as Address, abi: ACCOUNTING_ABI as Abi, functionName: "aprSrt" },
        { address: this.addr.accounting as Address, abi: ACCOUNTING_ABI as Abi, functionName: "aprBase" },
        { address: this.addr.accounting as Address, abi: ACCOUNTING_ABI as Abi, functionName: "aprTarget" },
        { address: this.addr.accounting as Address, abi: ACCOUNTING_ABI as Abi, functionName: "srtTargetIndex" },
      ],
    });
    const num = (i: number) => (r[i].status === "success" ? (r[i].result as bigint) : 0n);
    return { aprSrt: num(0), aprBase: num(1), aprTarget: num(2), srtTargetIndex: num(3) };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — User state
  // ═══════════════════════════════════════════════════════════════════

  /** Pending + claimable share-lock withdraw requests across all tranches. */
  async getUserWithdrawRequests(user: string): Promise<PendingWithdraw[]> {
    const silo = this.addr.sharesCooldown as Address;
    const vaults = ALL_TRANCHES.map((id) => ({ id, vault: this._vault(id) as Address }));

    const lengths = await this.publicClient.multicall({
      contracts: vaults.map((v) => ({
        address: silo,
        abi: SHARES_COOLDOWN_ABI as Abi,
        functionName: "activeRequestsLength" as const,
        args: [v.vault, user as Address],
      })),
    });

    const calls: { id: TrancheId; vault: Address; i: number }[] = [];
    vaults.forEach((v, vi) => {
      const len = lengths[vi].status === "success" ? Number(lengths[vi].result as bigint) : 0;
      for (let i = 0; i < len; i++) calls.push({ id: v.id, vault: v.vault, i });
    });
    if (calls.length === 0) return [];

    const reqs = await this.publicClient.multicall({
      contracts: calls.map((c) => ({
        address: silo,
        abi: SHARES_COOLDOWN_ABI as Abi,
        functionName: "activeRequests" as const,
        args: [c.vault, user as Address, BigInt(c.i)],
      })),
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    return reqs.map((res, k) => {
      const c = calls[k];
      const req = res.status === "success" ? (res.result as { unlockAt: bigint; shares: bigint; token: string }) : null;
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
        timeRemaining: claimable ? 0n : unlockAt - now,
      };
    });
  }

  async getTokenBalance(token: string, user: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI as Abi,
      functionName: "balanceOf",
      args: [user as Address],
    })) as bigint;
  }

  async getTokenAllowance(token: string, owner: string, spender: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI as Abi,
      functionName: "allowance",
      args: [owner as Address, spender as Address],
    })) as bigint;
  }

  async getShareBalance(id: TrancheId, user: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this._vault(id) as Address,
      abi: TRANCHE_ABI as Abi,
      functionName: "balanceOf",
      args: [user as Address],
    })) as bigint;
  }

  /** Aggregated user position across all three tranches (in USDai value). */
  async getUserPortfolio(user: string): Promise<UserPortfolio> {
    const vaults = ALL_TRANCHES.map((id) => this._vault(id) as Address);

    const bal = await this.publicClient.multicall({
      contracts: vaults.map((v) => ({
        address: v,
        abi: TRANCHE_ABI as Abi,
        functionName: "balanceOf" as const,
        args: [user as Address],
      })),
    });
    const shares = bal.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));

    const conv = await this.publicClient.multicall({
      contracts: vaults.map((v, i) => ({
        address: v,
        abi: TRANCHE_ABI as Abi,
        functionName: "convertToAssets" as const,
        args: [shares[i]],
      })),
    });
    const assets = conv.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));

    return {
      junior: { shares: shares[0], assets: assets[0] },
      mezzanine: { shares: shares[1], assets: assets[1] },
      senior: { shares: shares[2], assets: assets[2] },
      totalAssets: assets[0] + assets[1] + assets[2],
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE BUILDERS — pass the result to walletClient.writeContract(...)
  // ═══════════════════════════════════════════════════════════════════

  /** Approve `spender` to pull `amount` of `token` (e.g. USDai → tranche). */
  buildApprove(token: string, spender: string, amount: bigint): TxRequest {
    return {
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as `0x${string}`, amount],
    };
  }

  /** Deposit `assets` USDai into a tranche. Requires a prior USDai approve. */
  buildDeposit(id: TrancheId, assets: bigint, receiver: string): TxRequest {
    return {
      address: this._vault(id) as `0x${string}`,
      abi: TRANCHE_ABI,
      functionName: "deposit",
      args: [assets, receiver as `0x${string}`],
    };
  }

  /**
   * Redeem `shares` from a tranche, receiving sUSDai. Uses the meta-token
   * `redeem(token, shares, receiver, owner)` overload with token = sUSDai —
   * the plain ERC-4626 overload routes USDai which the v1 Strategy rejects.
   * ALWAYS simulate first to surface coverage/pause reverts.
   */
  buildWithdraw(id: TrancheId, shares: bigint, receiver: string, owner: string): TxRequest {
    return {
      address: this._vault(id) as `0x${string}`,
      abi: TRANCHE_ABI,
      functionName: "redeem",
      args: [this.addr.susdai as `0x${string}`, shares, receiver as `0x${string}`, owner as `0x${string}`],
    };
  }

  /** Finalize a matured share-lock request, releasing sUSDai to `user`. */
  buildFinalizeCooldown(id: TrancheId, user: string): TxRequest {
    return {
      address: this.addr.sharesCooldown as `0x${string}`,
      abi: SHARES_COOLDOWN_ABI,
      functionName: "finalize",
      args: [this._vault(id) as `0x${string}`, this.addr.susdai as `0x${string}`, user as `0x${string}`],
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════════

  private _vault(id: TrancheId): string {
    if (id === TrancheId.JUNIOR) return this.addr.jrVault;
    if (id === TrancheId.MEZZANINE) return this.addr.mzVault;
    return this.addr.srVault;
  }
}
