import { createPublicClient, http, type PublicClient, type Address } from "viem";
import { PRIME_LENS_ABI, TRANCHE_VAULT_ABI, ACCOUNTING_ABI, ERC20_ABI } from "./abis";
import { CooldownType, TrancheId } from "./types";
import type {
  PrimeVaultsConfig,
  ContractAddresses,
  TrancheInfo,
  PreviewDeposit,
  PreviewWithdraw,
  PendingWithdraw,
  ProtocolHealth,
  UserPortfolio,
} from "./types";

const PRECISION = 10n ** 18n;

const ERC4626_CONVERT_ABI = [
  {
    inputs: [{ name: "assets", type: "uint256" }],
    name: "convertToShares",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export class PrimeVaultsSDK {
  readonly config: PrimeVaultsConfig;
  readonly publicClient: PublicClient;
  readonly addresses: ContractAddresses;

  constructor(config: PrimeVaultsConfig) {
    this.config = config;
    this.addresses = config.addresses;
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl),
    }) as PublicClient;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Tranches
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get tranche info by ID: trancheId, totalAssets, totalSupply, sharePrice, asset, apy.
   * Works for SENIOR, MEZZ, and JUNIOR — all tranches are base-asset only.
   */
  async getTrancheById(trancheId: TrancheId): Promise<TrancheInfo> {
    const vaultAddr = this._getVaultAddress(trancheId);
    const apyFn =
      trancheId === TrancheId.SENIOR ? "getSeniorAPY" : trancheId === TrancheId.MEZZ ? "getMezzAPY" : "getJuniorAPY";

    const results = await this.publicClient.multicall({
      contracts: [
        {
          address: this.addresses.primeLens as Address,
          abi: PRIME_LENS_ABI,
          functionName: "getTrancheInfo",
          args: [trancheId],
        },
        { address: this.addresses.accounting as Address, abi: ACCOUNTING_ABI, functionName: apyFn },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "asset" },
      ],
    });

    const [lensResult, apyResult, assetResult] = results;
    if (lensResult.status !== "success") throw new Error(`getTrancheInfo(${trancheId}) failed`);

    const info = lensResult.result as any;
    return {
      trancheId,
      vault: info.vault,
      name: info.name,
      symbol: info.symbol,
      totalAssets: info.totalAssets,
      totalSupply: info.totalSupply,
      sharePrice: info.sharePrice,
      asset: assetResult.status === "success" ? (assetResult.result as string) : "",
      apy: apyResult.status === "success" ? (apyResult.result as bigint) : 0n,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Preview Deposit
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Preview deposit for any tranche: how many shares for a given base amount.
   */
  async previewDeposit(trancheId: TrancheId, amount: bigint): Promise<PreviewDeposit> {
    const vaultAddr = this._getVaultAddress(trancheId);
    const results = await this.publicClient.multicall({
      contracts: [
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "previewDeposit", args: [amount] },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalAssets" },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalSupply" },
      ],
    });

    const shares = results[0].status === "success" ? (results[0].result as bigint) : 0n;
    const totalAssets = results[1].status === "success" ? (results[1].result as bigint) : 0n;
    const totalSupply = results[2].status === "success" ? (results[2].result as bigint) : 0n;
    const sharePrice = totalSupply > 0n ? (totalAssets * PRECISION) / totalSupply : PRECISION;

    return { trancheId, shares, sharePrice, totalBaseValue: amount };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Preview Deposit Output Token (e.g. sUSDai)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Preview deposit for the yield-bearing output token (e.g. sUSDai):
   * how many vault shares for a given output token amount.
   * Converts output token amount to base-equivalent internally.
   */
  async previewDepositOutputToken(trancheId: TrancheId, amount: bigint): Promise<PreviewDeposit> {
    const vaultAddr = this._getVaultAddress(trancheId);
    const results = await this.publicClient.multicall({
      contracts: [
        {
          address: vaultAddr as Address,
          abi: TRANCHE_VAULT_ABI,
          functionName: "previewDepositOutputToken",
          args: [amount],
        },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalAssets" },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalSupply" },
      ],
    });

    const shares = results[0].status === "success" ? (results[0].result as bigint) : 0n;
    const totalAssets = results[1].status === "success" ? (results[1].result as bigint) : 0n;
    const totalSupply = results[2].status === "success" ? (results[2].result as bigint) : 0n;
    const sharePrice = totalSupply > 0n ? (totalAssets * PRECISION) / totalSupply : PRECISION;

    // Base-equivalent: derive from shares * sharePrice (since preview already accounts for conversion)
    const totalBaseValue = totalSupply > 0n ? (shares * totalAssets) / totalSupply : shares;

    return { trancheId, shares, sharePrice, totalBaseValue };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Preview Withdraw
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Preview withdrawal: given shares, returns mechanism (lock type), cooldown duration,
   * fee, net base amount out.
   * @param trancheId Tranche to withdraw from
   * @param shares Vault shares to redeem (18 decimals)
   */
  async previewWithdraw(trancheId: TrancheId, shares: bigint): Promise<PreviewWithdraw> {
    const trancheNum = trancheId as number;
    const vaultAddr = this._getVaultAddress(trancheId);

    const results = await this.publicClient.multicall({
      contracts: [
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "convertToAssets", args: [shares] },
        {
          address: this.addresses.primeLens as Address,
          abi: PRIME_LENS_ABI,
          functionName: "previewWithdrawCondition",
          args: [trancheNum],
        },
      ],
    });

    const baseAmountOut = results[0].status === "success" ? (results[0].result as bigint) : 0n;
    const cond = results[1].status === "success" ? (results[1].result as any) : null;

    const mechanism: CooldownType = cond ? Number(cond.mechanism) : CooldownType.NONE;
    const feeBps = cond ? cond.feeBps : 0n;
    const cooldownDuration = cond ? cond.cooldownDuration : 0n;

    const feeAmount = (baseAmountOut * feeBps) / 10_000n;
    const netBaseAmount = baseAmountOut - feeAmount;

    // Convert base amount to actual output token (sUSDai) amount
    let outputTokenAmount = netBaseAmount;
    if (this.addresses.outputToken && netBaseAmount > 0n) {
      outputTokenAmount = (await this.publicClient.readContract({
        address: this.addresses.outputToken as Address,
        abi: ERC4626_CONVERT_ABI,
        functionName: "convertToShares",
        args: [netBaseAmount],
      })) as bigint;
    }

    return {
      trancheId,
      mechanism,
      cooldownDuration,
      feeBps,
      feeAmount,
      netBaseAmount,
      outputTokenAmount,
      baseAmountOut,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Protocol Health
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get protocol health: all TVLs, coverage ratios, pause state.
   */
  async getProtocolHealth(): Promise<ProtocolHealth> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getProtocolHealth",
    });

    const h = result as any;
    return {
      seniorTVL: h.seniorTVL,
      seniorPrincipal: h.seniorPrincipal,
      seniorYield: h.seniorYield,
      mezzTVL: h.mezzTVL,
      juniorTVL: h.juniorTVL,
      totalTVL: h.totalTVL,
      coverageSenior: h.coverageSenior,
      coverageMezz: h.coverageMezz,
      minCoverageForDeposit: h.minCoverageForDeposit,
      shortfallPaused: h.shortfallPaused,
      juniorShortfallPausePrice: h.juniorShortfallPausePrice,
      strategyTVL: h.strategyTVL,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — User Withdraw Requests
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get all pending + claimable withdraw requests for a user.
   * Each item includes: requestId, handler, token, amount, unlockTime, status, isClaimable, timeRemaining.
   * @param user Wallet address
   */
  async getUserWithdrawRequests(user: string): Promise<PendingWithdraw[]> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getUserPendingWithdraws",
      args: [user as Address],
    });

    return (result as any[]).map((w: any) => ({
      requestId: w.requestId,
      handler: w.handler,
      beneficiary: w.beneficiary,
      token: w.token,
      amount: w.amount,
      unlockTime: w.unlockTime,
      status: Number(w.status),
      isClaimable: w.isClaimable,
      timeRemaining: w.timeRemaining,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Token & Share Balances
  // ═══════════════════════════════════════════════════════════════════

  /** Get ERC20 token balance for a user. */
  async getTokenBalance(token: string, user: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user as Address],
    })) as bigint;
  }

  /** Get ERC20 allowance (owner → spender). */
  async getTokenAllowance(token: string, owner: string, spender: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner as Address, spender as Address],
    })) as bigint;
  }

  /** Get vault share balance for a user. */
  async getShareBalance(trancheId: TrancheId, user: string): Promise<bigint> {
    const vaultAddr = this._getVaultAddress(trancheId);
    return (await this.publicClient.readContract({
      address: vaultAddr as Address,
      abi: TRANCHE_VAULT_ABI,
      functionName: "balanceOf",
      args: [user as Address],
    })) as bigint;
  }

  /** Convert shares to assets (no fee/mechanism — raw ERC4626 conversion). */
  async previewRedeem(trancheId: TrancheId, shares: bigint): Promise<bigint> {
    const vaultAddr = this._getVaultAddress(trancheId);
    return (await this.publicClient.readContract({
      address: vaultAddr as Address,
      abi: TRANCHE_VAULT_ABI,
      functionName: "previewRedeem",
      args: [shares],
    })) as bigint;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Portfolio
  // ═══════════════════════════════════════════════════════════════════

  /** Get aggregated user portfolio across all 3 tranches. */
  async getUserPortfolio(user: string): Promise<UserPortfolio> {
    const vaults = [this.addresses.seniorVault, this.addresses.mezzVault, this.addresses.juniorVault];

    // 1. Get share balances
    const balResults = await this.publicClient.multicall({
      contracts: vaults.map((v) => ({
        address: v as Address,
        abi: TRANCHE_VAULT_ABI,
        functionName: "balanceOf" as const,
        args: [user as Address],
      })),
    });

    const shares = balResults.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));

    // 2. Convert shares to assets
    const assetResults = await this.publicClient.multicall({
      contracts: vaults.map((v, i) => ({
        address: v as Address,
        abi: TRANCHE_VAULT_ABI,
        functionName: "convertToAssets" as const,
        args: [shares[i]],
      })),
    });

    const assets = assetResults.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));

    return {
      senior: { shares: shares[0], assets: assets[0] },
      mezz: { shares: shares[1], assets: assets[1] },
      junior: { shares: shares[2], assets: assets[2] },
      totalAssetsUSD: assets[0] + assets[1] + assets[2],
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════════

  private _getVaultAddress(trancheId: TrancheId): string {
    if (trancheId === TrancheId.SENIOR) return this.addresses.seniorVault;
    if (trancheId === TrancheId.MEZZ) return this.addresses.mezzVault;
    return this.addresses.juniorVault;
  }
}
