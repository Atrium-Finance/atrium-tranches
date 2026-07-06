import "dotenv/config";
import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";

// NOTE: `@nomicfoundation/hardhat-toolbox-viem` already registers
// `hardhat-ignition-viem` and `hardhat-verify` as plugin dependencies,
// so they MUST NOT be added to `plugins` again (duplicate-id error).
// Installing the peer packages is sufficient for `hardhat ignition` and
// `hardhat verify` to be available.

const FORK_TESTS = process.env.FORK_TESTS === "true";
const ARBITRUM_RPC = process.env.ARBITRUM_RPC_URL;
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY;

const FORK_BLOCK_RAW = process.env.FORK_BLOCK_NUMBER;
const FORK_BLOCK: number | undefined =
  FORK_BLOCK_RAW === "latest" || !FORK_BLOCK_RAW ? undefined : parseInt(FORK_BLOCK_RAW);

if (FORK_TESTS && !ARBITRUM_RPC) {
  // eslint-disable-next-line no-console
  console.warn(
    "⚠️  FORK_TESTS=true but ARBITRUM_RPC_URL not set. " + "Fork tests will skip. Add ARBITRUM_RPC_URL to .env",
  );
}

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  // Both build profiles carry `viaIR`. `hardhat ignition deploy` uses the
  // `production` profile, and several contracts (e.g. PrimeCDO.withdraw,
  // Accounting.calculateNAVSplit) overflow the stack without viaIR. The
  // simple single-version form only configures `default`, which is why
  // tests pass but a production build would hit "Stack too deep".
  solidity: {
    profiles: {
      default: {
        version: "0.8.35",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
      production: {
        version: "0.8.35",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
  // Arbitrum's hardfork history isn't part of EDR's built-in chain set,
  // so any historical-block call against the fork fails with "No known
  // hardfork for execution on historical block …" unless we tell EDR
  // what hardfork rules to apply. Shanghai is the latest L1 hardfork
  // BEFORE Cancun added the blob-gas block fields — Arbitrum blocks
  // lack those fields, so executing against them under Cancun rules
  // reverts with `excess_blob_gas not set`. Shanghai keeps PUSH0 and
  // every prior opcode while staying compatible with Arbitrum's block
  // header shape.
  chainDescriptors: {
    42161: {
      name: "Arbitrum One",
      chainType: "l1",
      hardforkHistory: {
        shanghai: { blockNumber: 0 },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    // Arbitrum mainnet fork. Only meaningful when ARBITRUM_RPC_URL is
    // set; otherwise the fork.url stays undefined and connections fall
    // back to a bare EDR (fork tests skip themselves in that case).
    //
    // `hardfork: "cancun"` is required because EDR's chainType="l1"
    // doesn't carry Arbitrum's hardfork activation history — without
    // an explicit hardfork, contract calls on the forked block revert
    // with "No known hardfork for execution on historical block …".
    forkArbitrum: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 42161,
      hardfork: "cancun",
      forking: ARBITRUM_RPC
        ? {
            url: ARBITRUM_RPC,
            ...(FORK_BLOCK !== undefined ? { blockNumber: FORK_BLOCK } : {}),
          }
        : undefined,
    },
    // Real Arbitrum One — used by `hardhat ignition deploy --network
    // arbitrum` and the E2E scripts. Sends real transactions, so
    // DEPLOYER_PRIVATE_KEY must be funded with ETH on Arbitrum.
    arbitrum: {
      type: "http",
      chainType: "l1",
      url: ARBITRUM_RPC ?? "https://arb1.arbitrum.io/rpc",
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
      chainId: 42161,
    },
  },
  // Ignition execution tuning for a live L1 (3 confirmations on mainnet).
  // On an auto-mining EDR fork, no blocks are produced after the last tx
  // in a batch, so >1 confirmation stalls — set IGNITION_CONFIRMATIONS=1
  // for fork dry-runs.
  ignition: {
    blockPollingInterval: 5_000,
    timeBeforeBumpingFees: 60_000,
    maxFeeBumps: 4,
    requiredConfirmations: process.env.IGNITION_CONFIRMATIONS ? Number(process.env.IGNITION_CONFIRMATIONS) : 3,
  },
  // Etherscan V2 uses a single multichain API key (covers Arbiscan).
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY ?? process.env.ARBISCAN_API_KEY ?? "",
    },
  },
};

export default config;
