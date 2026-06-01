import "dotenv/config";
import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";

const FORK_TESTS = process.env.FORK_TESTS === "true";
const ARBITRUM_RPC = process.env.ARBITRUM_RPC_URL;

const FORK_BLOCK_RAW = process.env.FORK_BLOCK_NUMBER;
const FORK_BLOCK: number | undefined =
  FORK_BLOCK_RAW === "latest" || !FORK_BLOCK_RAW
    ? undefined
    : parseInt(FORK_BLOCK_RAW);

if (FORK_TESTS && !ARBITRUM_RPC) {
  // eslint-disable-next-line no-console
  console.warn(
    "⚠️  FORK_TESTS=true but ARBITRUM_RPC_URL not set. " +
      "Fork tests will skip. Add ARBITRUM_RPC_URL to .env"
  );
}

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.35",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
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
  },
};

export default config;
