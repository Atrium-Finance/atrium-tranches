import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";

describe("Integration · Deposit flow", () => {
  it("1. ERC20 → Tranche → CDO → Strategy: USDai auto-stakes into sUSDai", async () => {
    const ctx = await loadFixture(atriumFixture);
    const { cdo, jr, strategy, usdai, susdai, user } = ctx;

    // Enable Jr deposits.
    await cdo.write.setActionStates([jr.address, true, true]);

    const amount = parseUnits("100", 18);

    await usdai.write.mint([user.account.address, amount]);
    await usdai.write.approve([jr.address, amount], { account: user.account });

    const userUsdaiBefore = (await usdai.read.balanceOf([
      user.account.address,
    ])) as bigint;
    const strategySusdaiBefore = (await susdai.read.balanceOf([
      strategy.address,
    ])) as bigint;

    await jr.write.deposit([amount, user.account.address], {
      account: user.account,
    });

    const userUsdaiAfter = (await usdai.read.balanceOf([
      user.account.address,
    ])) as bigint;
    const strategySusdaiAfter = (await susdai.read.balanceOf([
      strategy.address,
    ])) as bigint;

    // User paid full USDai amount.
    expect(userUsdaiBefore - userUsdaiAfter).to.equal(amount);

    // Strategy now holds sUSDai (auto-staked via USDai.forceApprove).
    expect(strategySusdaiAfter > strategySusdaiBefore).to.equal(true);

    // User minted Jr shares 1:1 on first deposit (no fees, no priors).
    const userShares = (await jr.read.balanceOf([
      user.account.address,
    ])) as bigint;
    expect(userShares).to.equal(amount);
  });

  it("2. Senior deposit blocked when subordinate buffer insufficient (coverage gate)", async () => {
    const ctx = await loadFixture(atriumFixture);
    const { cdo, sr, usdai, user } = ctx;

    // Enable Sr deposits only — no Jr / Mz subordinate buffer exists.
    await cdo.write.setActionStates([sr.address, true, true]);

    const amount = parseUnits("100", 18);
    await usdai.write.mint([user.account.address, amount]);
    await usdai.write.approve([sr.address, amount], { account: user.account });

    // Sr deposit without Jr/Mz buffer violates MIN_COVERAGE = 1.05× ⇒
    // CDO reverts CoverageBelowMinimum.
    await expect(
      sr.write.deposit([amount, user.account.address], {
        account: user.account,
      })
    ).to.be.rejected;
  });
});
