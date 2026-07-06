/**
 * Fork fixture — deploys a fresh Atrium stack against real Arbitrum
 * mainnet externals (sUSDai, USDai, Aave Pool). Mirrors
 * `test/fixtures/deployAtrium.ts` for the Atrium side; replaces the
 * mocks for the external side.
 *
 * Requires the `forkArbitrum` Hardhat network and a configured RPC URL.
 * Tests are expected to gate themselves with `shouldSkipFork()` and
 * `isConfigured(...)` before calling this fixture.
 */
import { encodeFunctionData, getContract, parseUnits } from "viem";
import { forkViem, getForkClients } from "../helpers/forkClients.js";
import { isConfigured } from "../helpers/addresses.js";
import { addr } from "../helpers/addr.js";
import { ERC20_ABI } from "../helpers/erc20Abi.js";

const ZERO_DURATION = 0;

export interface ForkAtriumCtx {
  // Real external contracts.
  sUSDai: any;
  USDai: any;
  aavePool: any;
  usdc: any;
  usdt: any;
  // Atrium stack.
  acm: any;
  erc20Cooldown: any;
  aprProvider: any;
  feed: any;
  strategy: any;
  accounting: any;
  jr: any;
  mz: any;
  sr: any;
  cdo: any;
  // Accounts.
  owner: any;
  user: any;
  keeper: any;
  treasury: any;
  publicClient: any;
}

export async function forkAtriumFixture(): Promise<ForkAtriumCtx> {
  if (!isConfigured("sUSDai")) {
    throw new Error(
      "forkAtriumFixture: ARBITRUM_ADDRESSES.sUSDai is the zero address. " +
        "Set it in test/fork/helpers/addresses.ts before running this fixture.",
    );
  }

  const { owner, user, keeper, treasury, publicClient } = await getForkClients();

  // ---- Real Arbitrum contracts (NO deploy) ----
  const sUSDai = await forkViem.getContractAt("IsUSDai", addr("sUSDai"));
  const aavePool = await forkViem.getContractAt("IAavePool", addr("aavePool"));

  // USDai derived from sUSDai.asset() — sUSDai is the source of truth.
  const usdaiAddress = (await sUSDai.read.asset()) as `0x${string}`;
  const USDai = getContract({
    address: usdaiAddress,
    abi: ERC20_ABI,
    client: { public: publicClient, wallet: owner },
  });
  const usdc = getContract({
    address: addr("USDC"),
    abi: ERC20_ABI,
    client: { public: publicClient, wallet: owner },
  });
  const usdt = getContract({
    address: addr("USDT"),
    abi: ERC20_ABI,
    client: { public: publicClient, wallet: owner },
  });

  // ---- Atrium stack (deploy fresh proxies) ----
  // ACM
  const acmImpl = await forkViem.deployContract("AccessControlManager");
  const acmInit = encodeFunctionData({
    abi: acmImpl.abi,
    functionName: "initialize",
    args: [owner.account.address],
  });
  const acmProxy = await forkViem.deployContract("ProjectERC1967Proxy", [acmImpl.address, acmInit]);
  const acm = await forkViem.getContractAt("AccessControlManager", acmProxy.address);

  // ERC20Cooldown silo
  const cdImpl = await forkViem.deployContract("ERC20Cooldown");
  const cdInit = encodeFunctionData({
    abi: cdImpl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const cdProxy = await forkViem.deployContract("ProjectERC1967Proxy", [cdImpl.address, cdInit]);
  const erc20Cooldown = await forkViem.getContractAt("ERC20Cooldown", cdProxy.address);

  // PrimeCDO (must exist before Strategy initialize)
  const cdoImpl = await forkViem.deployContract("PrimeCDO");
  const cdoInit = encodeFunctionData({
    abi: cdoImpl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const cdoProxy = await forkViem.deployContract("ProjectERC1967Proxy", [cdoImpl.address, cdoInit]);
  const cdo = await forkViem.getContractAt("PrimeCDO", cdoProxy.address);

  // APR provider: real Aave + real sUSDai
  const apImpl = await forkViem.deployContract("AaveAprPairProvider", [sUSDai.address, aavePool.address]);
  const apInit = encodeFunctionData({
    abi: apImpl.abi,
    functionName: "initialize",
    args: [owner.account.address, acm.address],
  });
  const apProxy = await forkViem.deployContract("ProjectERC1967Proxy", [apImpl.address, apInit]);
  const aprProvider = await forkViem.getContractAt("AaveAprPairProvider", apProxy.address);

  // Set benchmark tokens (gated by UPDATER_STRAT_CONFIG_ROLE — role
  // constant lives on AccessControlled-derived contracts, not ACM).
  const UPDATER_STRAT_CONFIG_ROLE = await aprProvider.read.UPDATER_STRAT_CONFIG_ROLE();
  await acm.write.grantRole([UPDATER_STRAT_CONFIG_ROLE, owner.account.address]);
  await aprProvider.write.setBenchmarkTokens([[usdc.address, usdt.address]]);

  // AprPairFeed wired to the provider (PUSH + PULL).
  const feedImpl = await forkViem.deployContract("AprPairFeed");
  const feedInit = encodeFunctionData({
    abi: feedImpl.abi,
    functionName: "initialize",
    args: [
      owner.account.address,
      acm.address,
      aprProvider.address,
      24n * 60n * 60n, // roundStaleAfter: 24h
      "USDA APR Feed (fork)",
    ],
  });
  const feedProxy = await forkViem.deployContract("ProjectERC1967Proxy", [feedImpl.address, feedInit]);
  const feed = await forkViem.getContractAt("AprPairFeed", feedProxy.address);

  // USDAStrategy — constructor takes (sUSDai, erc20Cooldown); initializer
  // takes (cdo, owner, acm).
  const stImpl = await forkViem.deployContract("USDAStrategy", [sUSDai.address, erc20Cooldown.address]);
  const stInit = encodeFunctionData({
    abi: stImpl.abi,
    functionName: "initialize",
    args: [cdo.address, owner.account.address, acm.address],
  });
  const stProxy = await forkViem.deployContract("ProjectERC1967Proxy", [stImpl.address, stInit]);
  const strategy = await forkViem.getContractAt("USDAStrategy", stProxy.address);

  // Accounting — pass real feed straight in. aprTarget/aprBase seeded
  // to match the integration fixture defaults (4% target, 12% base).
  const acImpl = await forkViem.deployContract("Accounting");
  const acInit = encodeFunctionData({
    abi: acImpl.abi,
    functionName: "initialize",
    args: [
      cdo.address,
      feed.address,
      owner.account.address,
      acm.address,
      parseUnits("0.04", 18),
      parseUnits("0.12", 18),
    ],
  });
  const acProxy = await forkViem.deployContract("ProjectERC1967Proxy", [acImpl.address, acInit]);
  const accounting = await forkViem.getContractAt("Accounting", acProxy.address);

  // Tranches — denominated in USDai (the strategy's base asset).
  async function deployTranche(name: string, symbol: string) {
    const impl = await forkViem.deployContract("Tranche");
    const init = encodeFunctionData({
      abi: impl.abi,
      functionName: "initialize",
      args: [usdaiAddress, name, symbol, cdo.address],
    });
    const proxy = await forkViem.deployContract("ProjectERC1967Proxy", [impl.address, init]);
    return await forkViem.getContractAt("Tranche", proxy.address);
  }
  const jr = await deployTranche("Junior", "JR");
  const mz = await deployTranche("Mezzanine", "MZ");
  const sr = await deployTranche("Senior", "SR");

  // Wire components — PrimeCDO.config validates back-references.
  await cdo.write.config([jr.address, mz.address, sr.address, accounting.address, strategy.address]);

  // Role grants (mirror integration fixture).
  const PAUSER_ROLE = await cdo.read.PAUSER_ROLE();
  const RESERVE_MANAGER_ROLE = await cdo.read.RESERVE_MANAGER_ROLE();
  const COOLDOWN_WORKER_ROLE = await cdo.read.COOLDOWN_WORKER_ROLE();
  const UPDATER_FEED_ROLE = await cdo.read.UPDATER_FEED_ROLE();

  await acm.write.grantRole([PAUSER_ROLE, owner.account.address]);
  await acm.write.grantRole([RESERVE_MANAGER_ROLE, owner.account.address]);
  await acm.write.grantRole([COOLDOWN_WORKER_ROLE, strategy.address]);
  await acm.write.grantRole([UPDATER_FEED_ROLE, keeper.account.address]);

  // Default to instant withdraw (cooldown = 0) — matches integration fixture.
  await strategy.write.setCooldowns([ZERO_DURATION, ZERO_DURATION, ZERO_DURATION]);

  // Seed the APR feed with an initial PUSH so `latestRoundData()`
  // returns the cached value instead of falling through to
  // `provider.getApr()` on every read. The AaveAprPairProvider PULL
  // path touches real sUSDai vesting state + real Aave reserves, which
  // can revert at specific fork blocks depending on protocol state.
  // Pre-seeding decouples the bulk of the suite (deposits, withdraws,
  // accounting refreshes) from those real-contract quirks — provider
  // behaviour gets exercised explicitly in the AaveAprPairProvider
  // tests instead of implicitly on every flow.
  //
  // Values mirror the integration fixture defaults: 12% base, 4%
  // target, SD7x12 (12 decimals).
  const seedBlock = await publicClient.getBlock();
  await feed.write.updateRoundData(
    [120_000_000_000n, 40_000_000_000n, seedBlock.timestamp],
    { account: keeper.account }
  );

  return {
    sUSDai,
    USDai,
    aavePool,
    usdc,
    usdt,
    acm,
    erc20Cooldown,
    aprProvider,
    feed,
    strategy,
    accounting,
    jr,
    mz,
    sr,
    cdo,
    owner,
    user,
    keeper,
    treasury,
    publicClient,
  };
}
