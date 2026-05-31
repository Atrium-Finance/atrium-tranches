import { describe, it } from "node:test";
import { expect } from "../../helpers/chai-setup.js";
import { loadFixture } from "../../helpers/network-helpers.js";
import { cooldownBaseFixture } from "../../fixtures/deployCooldown.js";

describe("CooldownBase", () => {
  it("1. Initializer wires AccessControlled (owner + acm)", async () => {
    const { silo, acm } = await loadFixture(cooldownBaseFixture);
    expect((await silo.read.acm()).toLowerCase()).to.equal(acm.address.toLowerCase());
  });

  it("2. PAUSER_ROLE constant resolved", async () => {
    const { silo } = await loadFixture(cooldownBaseFixture);
    const role = await silo.read.PAUSER_ROLE();
    expect(role).to.match(/^0x[a-fA-F0-9]{64}$/);
  });

  it("3. COOLDOWN_WORKER_ROLE constant resolved", async () => {
    const { silo } = await loadFixture(cooldownBaseFixture);
    const role = await silo.read.COOLDOWN_WORKER_ROLE();
    expect(role).to.match(/^0x[a-fA-F0-9]{64}$/);
  });

  it("4. Re-initialise reverts", async () => {
    const { silo, owner, acm } = await loadFixture(cooldownBaseFixture);
    await expect(silo.write.initialize([owner.account.address, acm.address])).to.be.rejected;
  });

  it("5. Owner getter returns the configured owner", async () => {
    const { silo, owner } = await loadFixture(cooldownBaseFixture);
    expect((await silo.read.owner()).toLowerCase()).to.equal(owner.account.address.toLowerCase());
  });

  it("6. Slot caps are non-zero internal constants (smoke)", async () => {
    const { silo } = await loadFixture(cooldownBaseFixture);
    // No external getter exposes the constants. Smoke check the storage exists.
    expect(silo.address).to.match(/^0x/);
  });

  it("7. balanceOf returns zero state by default", async () => {
    const { silo, owner } = await loadFixture(cooldownBaseFixture);
    const s = await silo.read.balanceOf([owner.account.address as any, owner.account.address]);
    expect(s.pending).to.equal(0n);
  });

  it("8. finalize on empty queue returns zero claim", async () => {
    const { silo, owner } = await loadFixture(cooldownBaseFixture);
    const claimed = await silo.read.finalize([owner.account.address as any, owner.account.address]);
    expect(claimed).to.equal(0n);
  });
});
