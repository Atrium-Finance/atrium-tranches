import { keccak256, toBytes } from "viem";

/**
 * Print the keccak256 role identifiers used across the Atrium stack.
 *
 * The Ignition deployment reads these on-chain via `staticCall`, so this
 * script is NOT required for deployment — it's a convenience for the team
 * to verify role values or to grant roles manually (e.g. from a multisig)
 * after handover.
 *
 *   pnpm compute:roles
 */
const roles = [
  "PAUSER_ROLE",
  "UPDATER_CDO_APR_ROLE",
  "UPDATER_FEED_ROLE",
  "UPDATER_STRAT_CONFIG_ROLE",
  "RESERVE_MANAGER_ROLE",
  "COOLDOWN_WORKER_ROLE",
  "PROPOSER_CONFIG_ROLE",
];

// DEFAULT_ADMIN_ROLE (OpenZeppelin) is bytes32(0).
console.log(`DEFAULT_ADMIN_ROLE: 0x${"0".repeat(64)}`);
for (const role of roles) {
  console.log(`${role}: ${keccak256(toBytes(role))}`);
}
