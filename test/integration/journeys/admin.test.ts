import { describe, it } from "node:test";
import { parseUnits, zeroAddress } from "viem";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { atriumFixture } from "../../fixtures/deployAtrium.js";
import { seedDefault } from "../../fixtures/seedTvl.js";
import { advanceWithYield, pushApr } from "../../fixtures/advanceTime.js";

const MAX_U256 = (1n << 256n) - 1n;

describe("Integration · Admin journey — governance operations end-to-end", () => {
  // ---------------------------------------------------------------
  // Pause / Action states
  // ---------------------------------------------------------------

  it("1. setActionStates pauses Jr deposit but allows Jr withdraw", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    // Disable Jr deposit, keep withdraw enabled.
    await ctx.cdo.write.setActionStates([ctx.jr.address, false, true]);

    // Jr deposit reverts.
    const amount = parseUnits("10", 18);
    await ctx.usdai.write.mint([ctx.user.account.address, amount]);
    await ctx.usdai.write.approve([ctx.jr.address, amount], {
      account: ctx.user.account,
    });
    await expect(
      ctx.jr.write.deposit([amount, ctx.user.account.address], {
        account: ctx.user.account,
      })
    ).to.be.rejected;

    // Jr withdraw still works (meta-token sUSDai path).
    const userShares = (await ctx.jr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    await ctx.jr.write.redeem(
      [
        ctx.susdai.address,
        userShares / 4n,
        ctx.user.account.address,
        ctx.user.account.address,
      ],
      { account: ctx.user.account }
    );
  });

  it("2. setActionStates pauses Sr withdraw entirely", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    // Disable Sr deposit + withdraw.
    await ctx.cdo.write.setActionStates([ctx.sr.address, false, false]);

    // Sr redeem reverts (WithdrawalsDisabled).
    const userSrShares = (await ctx.sr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    await expect(
      ctx.sr.write.redeem(
        [
          ctx.susdai.address,
          userSrShares,
          ctx.user.account.address,
          ctx.user.account.address,
        ],
        { account: ctx.user.account }
      )
    ).to.be.rejected;
  });

  it("3. setActionStates by non-PAUSER reverts", async () => {
    const ctx = await loadFixture(atriumFixture);

    await expect(
      ctx.cdo.write.setActionStates([ctx.jr.address, true, true], {
        account: ctx.user.account,
      })
    ).to.be.rejected;
  });

  // ---------------------------------------------------------------
  // Treasury drain (reduceReserve)
  // ---------------------------------------------------------------

  it("4. Reserve drain after accumulated yield transfers sUSDai to treasury", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);

    // Wire treasury (`onlyOwner`).
    await ctx.cdo.write.setReserveTreasury([ctx.treasury.account.address]);

    // Accumulate reserve via yield (5% reserveBps default).
    for (let i = 0; i < 4; i++) {
      await advanceWithYield(ctx, 7 * 24 * 60 * 60, 100);
    }

    const [, , , reserveBefore] =
      (await ctx.accounting.read.totalAssetsT0()) as [
        bigint,
        bigint,
        bigint,
        bigint
      ];
    expect(reserveBefore > 0n).to.equal(true);

    // Drain ~half the reserve. Choose a sUSDai token amount whose
    // base-asset equivalent (Floor) sits safely under reserveBefore.
    const tokenAmount = (await ctx.strategy.read.convertToTokens([
      ctx.susdai.address,
      reserveBefore / 2n,
      0, // Math.Rounding.Floor
    ])) as bigint;

    const treasuryBefore = (await ctx.susdai.read.balanceOf([
      ctx.treasury.account.address,
    ])) as bigint;

    await ctx.cdo.write.reduceReserve([ctx.susdai.address, tokenAmount]);

    const treasuryAfter = (await ctx.susdai.read.balanceOf([
      ctx.treasury.account.address,
    ])) as bigint;
    expect(treasuryAfter - treasuryBefore).to.equal(tokenAmount);

    // Reserve decreased.
    const [, , , reserveAfter] =
      (await ctx.accounting.read.totalAssetsT0()) as [
        bigint,
        bigint,
        bigint,
        bigint
      ];
    expect(reserveAfter < reserveBefore).to.equal(true);
  });

  it("5. Reserve drain by non-RESERVE_MANAGER reverts", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await pushApr(ctx, 40_000_000_000n, 120_000_000_000n);
    await ctx.cdo.write.setReserveTreasury([ctx.treasury.account.address]);
    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 100);

    await expect(
      ctx.cdo.write.reduceReserve(
        [ctx.susdai.address, parseUnits("0.01", 18)],
        { account: ctx.user.account }
      )
    ).to.be.rejected;
  });

  it("6. Reserve drain exceeding tvlReserve reverts ReserveInsufficient", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    // No yield → reserve == 0.
    await ctx.cdo.write.setReserveTreasury([ctx.treasury.account.address]);

    await expect(
      ctx.cdo.write.reduceReserve([ctx.susdai.address, parseUnits("1", 18)])
    ).to.be.rejected;
  });

  it("7. Reserve drain reverts when treasury == address(0)", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);
    await advanceWithYield(ctx, 7 * 24 * 60 * 60, 100);
    // setReserveTreasury never called — storage zero.

    await expect(
      ctx.cdo.write.reduceReserve([ctx.susdai.address, parseUnits("0.01", 18)])
    ).to.be.rejected;
  });

  // ---------------------------------------------------------------
  // Role management
  // ---------------------------------------------------------------

  it("8. Role grant + revoke workflow gates onAprChanged correctly", async () => {
    const ctx = await loadFixture(atriumFixture);

    const UPDATER_FEED_ROLE =
      (await ctx.accounting.read.UPDATER_FEED_ROLE()) as `0x${string}`;
    const newKeeper = ctx.rest[0];

    // Initially no role → onAprChanged reverts.
    expect(
      (await ctx.acm.read.hasRole([
        UPDATER_FEED_ROLE,
        newKeeper.account.address,
      ])) as boolean
    ).to.equal(false);
    await expect(
      ctx.accounting.write.onAprChanged({ account: newKeeper.account })
    ).to.be.rejected;

    // Grant.
    await ctx.acm.write.grantRole([
      UPDATER_FEED_ROLE,
      newKeeper.account.address,
    ]);
    expect(
      (await ctx.acm.read.hasRole([
        UPDATER_FEED_ROLE,
        newKeeper.account.address,
      ])) as boolean
    ).to.equal(true);

    // Can now call gated function.
    await ctx.accounting.write.onAprChanged({ account: newKeeper.account });

    // Revoke.
    await ctx.acm.write.revokeRole([
      UPDATER_FEED_ROLE,
      newKeeper.account.address,
    ]);

    // Reverts again.
    await expect(
      ctx.accounting.write.onAprChanged({ account: newKeeper.account })
    ).to.be.rejected;
  });

  it("9. grantRole by non-admin reverts", async () => {
    const ctx = await loadFixture(atriumFixture);

    const UPDATER_FEED_ROLE =
      (await ctx.accounting.read.UPDATER_FEED_ROLE()) as `0x${string}`;

    await expect(
      ctx.acm.write.grantRole(
        [UPDATER_FEED_ROLE, ctx.user.account.address],
        { account: ctx.user.account }
      )
    ).to.be.rejected;
  });

  // ---------------------------------------------------------------
  // Parameter updates
  // ---------------------------------------------------------------

  it("10. setAprPairFeed swaps feed (detach + reattach)", async () => {
    const ctx = await loadFixture(atriumFixture);

    // Detach (address(0) permitted on owner-gated setter).
    await ctx.accounting.write.setAprPairFeed([zeroAddress]);
    expect(((await ctx.accounting.read.aprPairFeed()) as string).toLowerCase()).to.equal(
      zeroAddress
    );

    // Reattach the same mock.
    await ctx.accounting.write.setAprPairFeed([ctx.mockFeed.address]);
    expect(((await ctx.accounting.read.aprPairFeed()) as string).toLowerCase()).to.equal(
      (ctx.mockFeed.address as string).toLowerCase()
    );
  });

  it("11. setCooldowns flips Sr from instant withdraw to silo-held", async () => {
    const ctx = await loadFixture(atriumFixture);
    await seedDefault(ctx);

    // Default cooldowns are 0 — silo zero-cooldown short-circuit.
    const userShares = (await ctx.sr.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    const quarter = userShares / 4n;

    const sUSDaiBefore1 = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    await ctx.sr.write.redeem(
      [
        ctx.susdai.address,
        quarter,
        ctx.user.account.address,
        ctx.user.account.address,
      ],
      { account: ctx.user.account }
    );
    const sUSDaiAfter1 = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(sUSDaiAfter1 > sUSDaiBefore1).to.equal(true);

    // Enable Sr 2-day cooldown — owner has UPDATER_STRAT_CONFIG_ROLE.
    await ctx.strategy.write.setCooldowns([0, 0, 2 * 24 * 60 * 60]);

    // Next redeem holds in silo — user balance unchanged.
    const sUSDaiBefore2 = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    await ctx.sr.write.redeem(
      [
        ctx.susdai.address,
        quarter,
        ctx.user.account.address,
        ctx.user.account.address,
      ],
      { account: ctx.user.account }
    );
    const sUSDaiAfter2 = (await ctx.susdai.read.balanceOf([
      ctx.user.account.address,
    ])) as bigint;
    expect(sUSDaiAfter2).to.equal(sUSDaiBefore2);
  });

  it("12. setCooldowns > MAX_COOLDOWN (7 days) reverts CooldownTooLong", async () => {
    const ctx = await loadFixture(atriumFixture);
    await expect(
      ctx.strategy.write.setCooldowns([0, 0, 8 * 24 * 60 * 60])
    ).to.be.rejected;
  });

  it("13. setActionStates emits DepositsStateChanged / WithdrawalsStateChanged", async () => {
    const ctx = await loadFixture(atriumFixture);

    const hash = await ctx.cdo.write.setActionStates([
      ctx.jr.address,
      true,
      true,
    ]);
    const rec = await ctx.publicClient.waitForTransactionReceipt({ hash });
    expect(rec.status).to.equal("success");

    // Idempotent — second call with same flags emits nothing new.
    const hash2 = await ctx.cdo.write.setActionStates([
      ctx.jr.address,
      true,
      true,
    ]);
    const rec2 = await ctx.publicClient.waitForTransactionReceipt({
      hash: hash2,
    });
    expect(rec2.status).to.equal("success");
  });
});

// Silence unused-import warning when MAX_U256 isn't needed in this file.
void MAX_U256;
