import { parseUnits, getAddress } from "viem";
import { connect, loadAddresses, loadParams, pick } from "./lib/e2e.js";

/**
 * E2E: deposit USDai into the Junior tranche and confirm shares are minted.
 * Junior is used because subordinate deposits are unrestricted by the
 * coverage gate (Senior deposits are gated until coverage is established).
 *
 *   pnpm e2e:deposit
 *
 * Requires: a completed `pnpm deploy:mainnet`, the deployer funded with
 * USDai, and deposits enabled (the deployment's wiring step does this).
 */
async function main() {
  const conn = await connect();
  const publicClient = await conn.viem.getPublicClient();
  const [deployer] = await conn.viem.getWalletClients();
  const me = getAddress(deployer.account.address);

  const addrs = loadAddresses();
  const params = loadParams();
  const jrAddr = pick(addrs, "#JrProxy", "#Jr");
  const usdaiAddr = getAddress(params.USDai);

  const jr = await conn.viem.getContractAt("Tranche", jrAddr);
  const usdai = await conn.viem.getContractAt("IERC20", usdaiAddr);

  const amount = parseUnits(process.env.E2E_AMOUNT ?? "10", 18);

  const bal = await usdai.read.balanceOf([me]);
  console.log(`Deployer USDai balance: ${bal}`);
  if (bal < amount) {
    throw new Error(`Insufficient USDai (have ${bal}, need ${amount}). Fund the deployer first.`);
  }

  console.log(`Approving ${amount} USDai to Junior (${jrAddr})...`);
  let hash = await usdai.write.approve([jrAddr, amount]);
  await publicClient.waitForTransactionReceipt({ hash });

  const before = await jr.read.balanceOf([me]);
  // 3-arg meta-deposit deposit(token, amount, receiver); token == asset()
  // (USDai), so it routes through the standard ERC4626 deposit path.
  console.log(`Depositing ${amount} USDai into Junior...`);
  hash = await jr.write.deposit([usdaiAddr, amount, me]);
  await publicClient.waitForTransactionReceipt({ hash });

  const after = await jr.read.balanceOf([me]);
  console.log(`✓ Junior shares ${before} -> ${after} (+${after - before})`);
  console.log("\n✓ E2E deposit PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
