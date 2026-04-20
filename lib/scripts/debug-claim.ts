/**
 * Debug script: diagnose + retry claimSharesWithdraw for a specific cooldownId.
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/debug-claim.ts --id 3
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/debug-claim.ts --id 3 --dry-run
 */

import { formatUnits, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag } from "./config";
import { TRANCHE_VAULT_ABI } from "../abis";

function fmt(v: bigint, decimals = 18): string {
  return Number(formatUnits(v, decimals)).toFixed(6);
}

const COOLDOWN_ABI = [
  { inputs: [{ name: "requestId", type: "uint256" }], name: "isClaimable", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "requestId", type: "uint256" }], name: "timeRemaining", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [{ name: "requestId", type: "uint256" }], name: "getRequest",
    outputs: [{ components: [
      { name: "beneficiary", type: "address" }, { name: "token", type: "address" },
      { name: "amount", type: "uint256" }, { name: "requestTime", type: "uint256" },
      { name: "unlockTime", type: "uint256" }, { name: "status", type: "uint8" },
    ], name: "", type: "tuple" }],
    stateMutability: "view", type: "function",
  },
  {
    inputs: [{ name: "requestId", type: "uint256" }], name: "s_requestCaller",
    outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function",
  },
] as const;

const CDO_ABI = [
  { inputs: [], name: "i_sharesCooldown", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "i_erc20Cooldown", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "i_strategy", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "i_outputToken", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_shortfallPaused", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "", type: "address" }], name: "s_vaultToTranche", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

const STRATEGY_ABI = [
  { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const ACCOUNTING_ABI = [
  { inputs: [], name: "s_seniorTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_mezzTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_juniorBaseTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_reserveTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "id", type: "uint8" }], name: "getTrancheTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const SUSDAI_ABI = [
  { inputs: [{ name: "shares", type: "uint256" }], name: "convertToAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "assets", type: "uint256" }], name: "convertToShares", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const TRANCHE_LABELS: Record<number, string> = { 0: "SENIOR", 1: "MEZZ", 2: "JUNIOR" };
const STATUS_LABELS: Record<number, string> = { 0: "PENDING", 1: "CLAIMED", 2: "CANCELLED" };

async function main() {
  const args = process.argv.slice(2);
  const cooldownId = BigInt(parseFlag(args, "--id") ?? "3");
  const dryRun = args.includes("--dry-run");

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();

  const cdoAddr = addresses.primeCDO as `0x${string}`;

  console.log(`\n  ═══ Debug claimSharesWithdraw(${cooldownId}) ═══\n`);

  // 1. Read CDO immutables
  const [scAddr, stratAddr, outputToken, paused] = await Promise.all([
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "i_sharesCooldown" }),
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "i_strategy" }),
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "i_outputToken" }),
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" }),
  ]);
  console.log(`  CDO:              ${cdoAddr}`);
  console.log(`  SharesCooldown:   ${scAddr}`);
  console.log(`  Strategy:         ${stratAddr}`);
  console.log(`  OutputToken:      ${outputToken}`);
  console.log(`  ShortfallPaused:  ${paused}`);

  // 2. Read SharesCooldown request
  const [req, isClaimable, timeLeft, requestCaller] = await Promise.all([
    publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "getRequest", args: [cooldownId] }),
    publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "isClaimable", args: [cooldownId] }),
    publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "timeRemaining", args: [cooldownId] }),
    publicClient.readContract({ address: scAddr as `0x${string}`, abi: COOLDOWN_ABI, functionName: "s_requestCaller", args: [cooldownId] }),
  ]) as [any, boolean, bigint, string];

  console.log(`\n  ─── SharesCooldown Request #${cooldownId} ───`);
  console.log(`  beneficiary:    ${req.beneficiary}`);
  console.log(`  token (vault):  ${req.token}`);
  console.log(`  amount (shares):${fmt(req.amount)}`);
  console.log(`  requestTime:    ${req.requestTime} (${new Date(Number(req.requestTime) * 1000).toISOString()})`);
  console.log(`  unlockTime:     ${req.unlockTime} (${new Date(Number(req.unlockTime) * 1000).toISOString()})`);
  console.log(`  status:         ${STATUS_LABELS[req.status] ?? req.status}`);
  console.log(`  isClaimable:    ${isClaimable}`);
  console.log(`  timeRemaining:  ${timeLeft}s`);
  console.log(`  requestCaller:  ${requestCaller}`);
  console.log(`  caller == CDO?  ${requestCaller.toLowerCase() === cdoAddr.toLowerCase()}`);

  if (req.status !== 0) {
    console.log(`\n  ❌ Request is not PENDING (status=${STATUS_LABELS[req.status]}). Cannot claim.`);
    return;
  }
  if (!isClaimable) {
    console.log(`\n  ❌ Not claimable yet. ${timeLeft}s remaining.`);
    return;
  }

  // 3. Read vault + tranche state
  const vaultAddr = req.token as `0x${string}`;
  const trancheId = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_vaultToTranche", args: [vaultAddr] }) as number;

  const [vaultTotalSupply, vaultSharesInSC, vaultSharesInCDO] = await Promise.all([
    publicClient.readContract({ address: vaultAddr, abi: ERC20_ABI, functionName: "totalSupply" }),
    publicClient.readContract({ address: vaultAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [scAddr as `0x${string}`] }),
    publicClient.readContract({ address: vaultAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [cdoAddr] }),
  ]) as [bigint, bigint, bigint];

  console.log(`\n  ─── Vault State (${TRANCHE_LABELS[trancheId]}) ───`);
  console.log(`  vault:          ${vaultAddr}`);
  console.log(`  trancheId:      ${TRANCHE_LABELS[trancheId]}`);
  console.log(`  totalSupply:    ${fmt(vaultTotalSupply)}`);
  console.log(`  SC holds:       ${fmt(vaultSharesInSC)} shares`);
  console.log(`  CDO holds:      ${fmt(vaultSharesInCDO)} shares`);

  // 4. Read accounting state
  const [srTVL, mzTVL, jrTVL, reserveTVL] = await Promise.all([
    publicClient.readContract({ address: addresses.accounting as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_seniorTVL" }),
    publicClient.readContract({ address: addresses.accounting as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_mezzTVL" }),
    publicClient.readContract({ address: addresses.accounting as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_juniorBaseTVL" }),
    publicClient.readContract({ address: addresses.accounting as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_reserveTVL" }),
  ]) as [bigint, bigint, bigint, bigint];

  const accountingTotal = srTVL + mzTVL + jrTVL + reserveTVL;
  const trancheTVL = trancheId === 0 ? srTVL : trancheId === 1 ? mzTVL : jrTVL;

  console.log(`\n  ─── Accounting ───`);
  console.log(`  Senior TVL:     ${fmt(srTVL)}`);
  console.log(`  Mezz TVL:       ${fmt(mzTVL)}`);
  console.log(`  Junior TVL:     ${fmt(jrTVL)}`);
  console.log(`  Reserve TVL:    ${fmt(reserveTVL)}`);
  console.log(`  Acct Total:     ${fmt(accountingTotal)}`);

  // 5. Read strategy state
  const strategyTVL = await publicClient.readContract({ address: stratAddr as `0x${string}`, abi: STRATEGY_ABI, functionName: "totalAssets" }) as bigint;
  const sUSDaiBal = await publicClient.readContract({ address: outputToken as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [stratAddr as `0x${string}`] }) as bigint;
  const sUSDaiAssets = await publicClient.readContract({ address: outputToken as `0x${string}`, abi: SUSDAI_ABI, functionName: "convertToAssets", args: [sUSDaiBal] }) as bigint;

  const delta = strategyTVL > accountingTotal ? strategyTVL - accountingTotal : accountingTotal - strategyTVL;

  console.log(`\n  ─── Strategy ───`);
  console.log(`  totalAssets:    ${fmt(strategyTVL)}`);
  console.log(`  sUSDai balance: ${fmt(sUSDaiBal)} shares`);
  console.log(`  sUSDai value:   ${fmt(sUSDaiAssets)}`);
  console.log(`  delta vs acct:  ${fmt(delta)} (${strategyTVL >= accountingTotal ? "gain" : "LOSS"})`);

  // 6. Simulate claim math
  const baseAmount = vaultTotalSupply > 0n ? (req.amount * trancheTVL) / vaultTotalSupply : 0n;
  const sUSDaiNeeded = await publicClient.readContract({ address: outputToken as `0x${string}`, abi: SUSDAI_ABI, functionName: "convertToShares", args: [baseAmount] }) as bigint;

  console.log(`\n  ─── Claim Simulation ───`);
  console.log(`  baseAmount:     ${fmt(baseAmount)} (shares=${fmt(req.amount)} × TVL=${fmt(trancheTVL)} / supply=${fmt(vaultTotalSupply)})`);
  console.log(`  sUSDai needed:  ${fmt(sUSDaiNeeded)} shares`);
  console.log(`  sUSDai avail:   ${fmt(sUSDaiBal)} shares`);
  console.log(`  sufficient?     ${sUSDaiBal >= sUSDaiNeeded ? "✓ YES" : "❌ NO — THIS IS THE BUG"}`);

  if (baseAmount === 0n) {
    console.log(`\n  ❌ baseAmount = 0 → strategy.withdraw will revert with PrimeVaults__ZeroAmount`);
    return;
  }

  // 7. Try eth_call simulation
  console.log(`\n  ─── eth_call simulation ───`);
  try {
    await publicClient.simulateContract({
      address: vaultAddr,
      abi: TRANCHE_VAULT_ABI,
      functionName: "claimSharesWithdraw",
      args: [cooldownId],
      account: account.address,
    });
    console.log(`  ✓ Simulation passed — claim should succeed`);
  } catch (err: any) {
    console.log(`  ❌ Simulation FAILED:`);
    console.log(`  ${err.shortMessage || err.message}`);
    if (err.cause?.data) console.log(`  Revert data: ${err.cause.data}`);
  }

  // 8. Execute if not dry-run
  if (dryRun) {
    console.log(`\n  (dry-run — skipping actual claim)\n`);
    return;
  }

  console.log(`\n  ─── Executing claim ───`);
  try {
    const hash = await walletClient.writeContract({
      address: vaultAddr,
      abi: TRANCHE_VAULT_ABI,
      functionName: "claimSharesWithdraw",
      args: [cooldownId],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, hash as Hash, "claimSharesWithdraw");
    console.log(`  ✓ Claim successful!\n`);
  } catch (err: any) {
    console.log(`  ❌ Claim failed: ${err.shortMessage || err.message}\n`);
  }
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
