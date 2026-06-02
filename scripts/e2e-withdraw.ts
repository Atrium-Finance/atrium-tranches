import { getAddress } from "viem";
import { connect, loadAddresses, loadParams, pick } from "./lib/e2e.js";

/**
 * E2E: redeem half the deployer's Junior shares and confirm sUSDai is
 * received.
 *
 * NOTE: the Strategy only releases sUSDai (USDai withdrawals revert), so we
 * must use the 4-arg meta-redeem `redeem(token = sUSDai, shares, receiver,
 * owner)`. The standard 3-arg `redeem(shares, receiver, owner)` routes a
 * USDai-denominated withdrawal and would revert in the Strategy.
 *
 *   pnpm e2e:withdraw   (run after pnpm e2e:deposit)
 */
async function main() {
  const conn = await connect();
  const publicClient = await conn.viem.getPublicClient();
  const [deployer] = await conn.viem.getWalletClients();
  const me = getAddress(deployer.account.address);

  const addrs = loadAddresses();
  const params = loadParams();
  const jrAddr = pick(addrs, "#JrProxy", "#Jr");
  const susdaiAddr = getAddress(params.sUSDai);

  const jr = await conn.viem.getContractAt("Tranche", jrAddr);
  const susdai = await conn.viem.getContractAt("IERC20", susdaiAddr);

  const shares = await jr.read.balanceOf([me]);
  if (shares === 0n) {
    throw new Error("No Junior shares. Run `pnpm e2e:deposit` first.");
  }
  const half = shares / 2n;
  const before = await susdai.read.balanceOf([me]);

  // 4-arg meta-redeem requesting the sUSDai-denominated path.
  console.log(`Redeeming ${half} Junior shares for sUSDai...`);
  const hash = await jr.write.redeem([susdaiAddr, half, me, me]);
  await publicClient.waitForTransactionReceipt({ hash });

  const after = await susdai.read.balanceOf([me]);
  const received = after - before;
  if (received === 0n) {
    throw new Error("✗ No sUSDai received (withdrawals may be cooling down or disabled).");
  }
  console.log(`✓ sUSDai received: ${received}`);
  console.log("\n✓ E2E withdraw PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
