import { Chain } from "viem";

/**
 * On-chain tranche identity. Matches the Solidity `TrancheKind` enum
 * ordering exactly: JUNIOR = 0, MEZZANINE = 1, SENIOR = 2.
 */
export enum TrancheId {
  JUNIOR = 0,
  MEZZANINE = 1,
  SENIOR = 2,
}

/**
 * Coverage-aware exit mode returned by `PrimeCDO.calculateExitMode`.
 * Matches the Solidity `TExitMode` enum. `Dynamic` is a caller-side
 * sentinel only — the CDO never returns it.
 */
export enum ExitMode {
  ERC4626 = 0, // instant redeem, no fee/lock
  SharesLock = 1, // shares escrowed in SharesCooldown for `cooldownSeconds`
  Fee = 2, // instant redeem minus an exit fee
  Dynamic = 3, // caller sentinel (opt out of slippage validation)
}

export interface AtriumConfig {
  rpcUrl: string;
  chain: Chain;
  addresses: ContractAddresses;
}

export interface ContractAddresses {
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

export interface TrancheInfo {
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

export interface PreviewDeposit {
  trancheId: TrancheId;
  /** Shares minted for `assets` USDai. */
  shares: bigint;
  /** Assets per 1e18 share at preview time (1e18-scaled). */
  sharePrice: bigint;
}

export interface PreviewWithdraw {
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

export interface ProtocolHealth {
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

export interface PendingWithdraw {
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

export interface AprData {
  /** Senior delivered target rate, 1e18-scaled. */
  aprSrt: bigint;
  /** Strategy base APR, 1e18-scaled. */
  aprBase: bigint;
  /** Senior floor target, 1e18-scaled. */
  aprTarget: bigint;
  /** Senior compounding index (1e18 baseline). */
  srtTargetIndex: bigint;
}

export interface UserPortfolio {
  junior: { shares: bigint; assets: bigint };
  mezzanine: { shares: bigint; assets: bigint };
  senior: { shares: bigint; assets: bigint };
  /** Total USDai value across all three tranches. */
  totalAssets: bigint;
}

/** A viem-compatible contract write request (pass to walletClient.writeContract). */
export interface TxRequest {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}
