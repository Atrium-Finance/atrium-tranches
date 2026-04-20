/**
 * Debug: diagnose why deposit reverts.
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/debug-deposit.ts --tranche JUNIOR --amount 0.1
 */

import { parseUnits, formatUnits, type Hash } from "viem";
import { createSDK, createWallet, parseFlag, USDAI, SUSDAI } from "./config";
import { TRANCHE_VAULT_ABI, ERC20_ABI } from "../abis";
import { TrancheId } from "../types";

function fmt(v: bigint): string { return Number(formatUnits(v, 18)).toFixed(6); }

const TRANCHE_MAP: Record<string, TrancheId> = { SENIOR: TrancheId.SENIOR, MEZZ: TrancheId.MEZZ, JUNIOR: TrancheId.JUNIOR };

const CDO_ABI = [
  { inputs: [], name: "s_shortfallPaused", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "i_strategy", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "i_accounting", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "id", type: "uint8" }], name: "s_tranches", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

const STRATEGY_ABI = [
  { inputs: [], name: "totalAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "isActive", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "i_baseAsset", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

const ACCOUNTING_ABI = [
  { inputs: [], name: "s_seniorTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_mezzTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_juniorBaseTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_reserveTVL", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_primeCDO", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_lastUpdateTimestamp", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const SUSDAI_VIEW_ABI = [
  { inputs: [{ name: "shares", type: "uint256" }], name: "convertToAssets", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const args = process.argv.slice(2);
  const trancheName = (parseFlag(args, "--tranche") ?? "JUNIOR").toUpperCase();
  const amountStr = parseFlag(args, "--amount") ?? "0.1";
  const amount = parseUnits(amountStr, 18);
  const trancheId = TRANCHE_MAP[trancheName];

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;
  const cdoAddr = addresses.primeCDO as `0x${string}`;
  const vaultAddr = (trancheId === TrancheId.SENIOR ? addresses.seniorVault
    : trancheId === TrancheId.MEZZ ? addresses.mezzVault
    : addresses.juniorVault) as `0x${string}`;

  console.log(`\n  ═══ Debug Deposit ${trancheName} ${amountStr} USD.AI ═══\n`);

  // 1. CDO state
  const [paused, stratAddr, acctAddr, registeredVault] = await Promise.all([
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" }),
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "i_strategy" }),
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "i_accounting" }),
    publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_tranches", args: [trancheId] }),
  ]);
  console.log(`  CDO:               ${cdoAddr}`);
  console.log(`  shortfallPaused:   ${paused}`);
  console.log(`  vault (expected):  ${vaultAddr}`);
  console.log(`  vault (registered):${registeredVault}`);
  console.log(`  match?             ${(registeredVault as string).toLowerCase() === vaultAddr.toLowerCase() ? "✓" : "❌ MISMATCH — vault not registered for this tranche!"}`);

  // 2. Strategy state
  const [stratActive, stratTVL, stratBaseAsset] = await Promise.all([
    publicClient.readContract({ address: stratAddr as `0x${string}`, abi: STRATEGY_ABI, functionName: "isActive" }),
    publicClient.readContract({ address: stratAddr as `0x${string}`, abi: STRATEGY_ABI, functionName: "totalAssets" }),
    publicClient.readContract({ address: stratAddr as `0x${string}`, abi: STRATEGY_ABI, functionName: "i_baseAsset" }),
  ]);
  console.log(`\n  Strategy:          ${stratAddr}`);
  console.log(`  isActive (not paused): ${stratActive}`);
  console.log(`  totalAssets:       ${fmt(stratTVL as bigint)}`);
  console.log(`  baseAsset:         ${stratBaseAsset}`);
  console.log(`  baseAsset==USDAI?  ${(stratBaseAsset as string).toLowerCase() === USDAI.toLowerCase() ? "✓" : "❌"}`);

  // 3. Accounting state
  const [srTVL, mzTVL, jrTVL, reserveTVL, acctCDO, lastUpdate] = await Promise.all([
    publicClient.readContract({ address: acctAddr as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_seniorTVL" }),
    publicClient.readContract({ address: acctAddr as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_mezzTVL" }),
    publicClient.readContract({ address: acctAddr as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_juniorBaseTVL" }),
    publicClient.readContract({ address: acctAddr as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_reserveTVL" }),
    publicClient.readContract({ address: acctAddr as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_primeCDO" }),
    publicClient.readContract({ address: acctAddr as `0x${string}`, abi: ACCOUNTING_ABI, functionName: "s_lastUpdateTimestamp" }),
  ]);
  const acctTotal = (srTVL as bigint) + (mzTVL as bigint) + (jrTVL as bigint) + (reserveTVL as bigint);
  const delta = (stratTVL as bigint) > acctTotal ? (stratTVL as bigint) - acctTotal : acctTotal - (stratTVL as bigint);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deltaT = now - (lastUpdate as bigint);

  console.log(`\n  Accounting:        ${acctAddr}`);
  console.log(`  acct.s_primeCDO:   ${acctCDO}`);
  console.log(`  acct CDO == CDO?   ${(acctCDO as string).toLowerCase() === cdoAddr.toLowerCase() ? "✓" : "❌ MISMATCH — accounting points to different CDO!"}`);
  console.log(`  Sr=${fmt(srTVL as bigint)} Mz=${fmt(mzTVL as bigint)} Jr=${fmt(jrTVL as bigint)} Res=${fmt(reserveTVL as bigint)}`);
  console.log(`  acctTotal:         ${fmt(acctTotal)}`);
  console.log(`  strategy TVL:      ${fmt(stratTVL as bigint)}`);
  console.log(`  delta:             ${fmt(delta)} (${(stratTVL as bigint) >= acctTotal ? "gain" : "LOSS"})`);
  console.log(`  lastUpdate:        ${lastUpdate} (${deltaT}s ago)`);

  // 4. User balances & approvals
  const [userBal, userAllowance] = await Promise.all([
    publicClient.readContract({ address: USDAI as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [user as `0x${string}`] }),
    publicClient.readContract({ address: USDAI as `0x${string}`, abi: ERC20_ABI, functionName: "allowance", args: [user as `0x${string}`, vaultAddr] }),
  ]);
  console.log(`\n  User:              ${user}`);
  console.log(`  USDai balance:     ${fmt(userBal as bigint)}`);
  console.log(`  USDai allowance:   ${fmt(userAllowance as bigint)} (to vault)`);
  console.log(`  balance >= amount? ${(userBal as bigint) >= amount ? "✓" : "❌ INSUFFICIENT BALANCE"}`);
  console.log(`  allowance >= amt?  ${(userAllowance as bigint) >= amount ? "✓" : "needs approve"}`);

  // 5. sUSDai check
  const sUSDaiBal = await publicClient.readContract({
    address: SUSDAI as `0x${string}`, abi: ERC20_ABI,
    functionName: "balanceOf", args: [stratAddr as `0x${string}`],
  }) as bigint;
  const sUSDaiValue = sUSDaiBal > 0n ? await publicClient.readContract({
    address: SUSDAI as `0x${string}`, abi: SUSDAI_VIEW_ABI,
    functionName: "convertToAssets", args: [sUSDaiBal],
  }) as bigint : 0n;
  console.log(`\n  sUSDai in strategy: ${fmt(sUSDaiBal)} shares (= ${fmt(sUSDaiValue)} base)`);

  // 6. Simulate deposit via eth_call
  console.log(`\n  ─── eth_call simulation ───`);

  // First approve if needed
  if ((userAllowance as bigint) < amount) {
    console.log(`  Approving first...`);
    const aHash = await walletClient.writeContract({
      address: USDAI as `0x${string}`, abi: ERC20_ABI,
      functionName: "approve", args: [vaultAddr, amount],
      chain: walletClient.chain, account,
    });
    console.log(`  Approve tx: ${aHash}`);
    await publicClient.waitForTransactionReceipt({ hash: aHash as Hash });
    console.log(`  Approved ✓`);
  }

  try {
    const result = await publicClient.simulateContract({
      address: vaultAddr,
      abi: TRANCHE_VAULT_ABI,
      functionName: "deposit",
      args: [amount, user as `0x${string}`],
      account: user as `0x${string}`,
    });
    console.log(`  ✓ Simulation passed! shares=${fmt(result.result as bigint)}`);
  } catch (err: any) {
    console.log(`  ❌ Simulation FAILED:`);
    console.log(`  ${err.shortMessage || err.message}`);
    if (err.cause?.reason) console.log(`  Reason: ${err.cause.reason}`);
    if (err.cause?.data) console.log(`  Revert data: ${err.cause.data}`);

    // Try to narrow down: simulate just the CDO deposit
    console.log(`\n  ─── Narrowing down: CDO.deposit simulation ───`);
    try {
      // Check if strategy.depositToken would work
      const stratDepositAbi = [{ inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], name: "depositToken", outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable", type: "function" }] as const;
      // Can't easily simulate internal calls, but let's check strategy.totalAssets
      console.log(`  Strategy.totalAssets(): ${fmt(stratTVL as bigint)}`);
      console.log(`  Strategy.isActive():    ${stratActive}`);
      if (!stratActive) console.log(`  ❌ STRATEGY IS PAUSED — this is why deposit reverts!`);
    } catch {}
  }

  console.log(`\n  Done.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
