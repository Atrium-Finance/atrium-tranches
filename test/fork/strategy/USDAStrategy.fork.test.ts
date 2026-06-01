import { describe, it } from "node:test";
import { parseUnits, getAddress } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { forkLoadFixture } from "../helpers/forkClients.js";
import { forkAtriumFixture } from "../fixtures/deployForkAtrium.js";
import { isConfigured } from "../helpers/addresses.js";
import { addr } from "../helpers/addr.js";
import { shouldSkipFork } from "../helpers/forkConfig.js";
import { fundFromWhale } from "../helpers/whaleFunding.js";

const SKIP = shouldSkipFork() || !isConfigured("sUSDai", "whaleSUSDai");

const suite: typeof describe = SKIP ? (describe.skip as any) : describe;

suite("Fork · USDAStrategy — real sUSDai", () => {
  it("1. Deploys + initializes against real sUSDai", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    const strategySUSDai = (await ctx.strategy.read.sUSDai()) as `0x${string}`;
    expect(getAddress(strategySUSDai)).to.equal(addr("sUSDai"));

    const strategyUSDai = (await ctx.strategy.read.USDai()) as `0x${string}`;
    const sUSDaiAsset = (await ctx.sUSDai.read.asset()) as `0x${string}`;
    expect(getAddress(strategyUSDai)).to.equal(getAddress(sUSDaiAsset));
  });

  it("2. Deposit USDai → auto-stake into sUSDai", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    // Enable Jr deposits.
    await ctx.cdo.write.setActionStates([ctx.jr.address, true, true]);

    const amount = parseUnits("100", 18);
    await fundFromWhale(addr("whaleUSDai"), ctx.user.account.address, ctx.USDai, amount);

    await ctx.USDai.write.approve([ctx.jr.address, amount], {
      account: ctx.user.account,
    });

    const sUSDaiInStrategyBefore = (await ctx.sUSDai.read.balanceOf([ctx.strategy.address])) as bigint;

    await ctx.jr.write.deposit([amount, ctx.user.account.address], {
      account: ctx.user.account,
    });

    const sUSDaiInStrategyAfter = (await ctx.sUSDai.read.balanceOf([ctx.strategy.address])) as bigint;
    expect(sUSDaiInStrategyAfter > sUSDaiInStrategyBefore).to.equal(true);

    // No residual USDai in Strategy — all auto-staked.
    const usdaiResidual = (await ctx.USDai.read.balanceOf([ctx.strategy.address])) as bigint;
    expect(usdaiResidual).to.equal(0n);
  });

  it("3. totalAssets matches sUSDai.convertToAssets of strategy holdings", async () => {
    const ctx = await forkLoadFixture(forkAtriumFixture);

    await ctx.cdo.write.setActionStates([ctx.jr.address, true, true]);

    const amount = parseUnits("100", 18);
    await fundFromWhale(addr("whaleUSDai"), ctx.user.account.address, ctx.USDai, amount);
    await ctx.USDai.write.approve([ctx.jr.address, amount], {
      account: ctx.user.account,
    });
    await ctx.jr.write.deposit([amount, ctx.user.account.address], {
      account: ctx.user.account,
    });

    const strategyShares = (await ctx.sUSDai.read.balanceOf([ctx.strategy.address])) as bigint;
    // sUSDai is ERC-7540 — previewRedeem reverts per spec; use the
    // conservative-NAV `convertToAssets` hint instead.
    const previewed = (await ctx.sUSDai.read.convertToAssets([strategyShares])) as bigint;
    const totalAssets = (await ctx.strategy.read.totalAssets()) as bigint;

    expect(totalAssets).to.equal(previewed);
  });
});
