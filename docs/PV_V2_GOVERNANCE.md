# PrimeVaults V2 — Governance Architecture

## Overview

PrimeVaults V2 uses a **progressive decentralization** model: governance power transfers
from the deployer EOA → Operations Multisig → PrimeLock (timelock) + Emergency Guardian.
Token-based DAO voting (Governor + ERC20Votes) is planned for a later stage and is
**not implemented in the current phase**.

All critical parameters can be tuned; governance changes pass through a 24-hour timelock
delay. An emergency Guardian multisig retains bypass rights only for pause/unpause
actions.

---

## Architecture (Stage 3 End State)

```
                            ┌───────────────────────────┐
                            │ Operations Multisig (Safe)│  3/5 team
                            └─────────────┬─────────────┘
                                          │ propose + execute (after delay)
                                          ▼
                            ┌───────────────────────────┐
                            │        PrimeLock          │  24-hour delay
                            │  (wraps OZ Timelock)      │
                            └─────────────┬─────────────┘
                                          │ owner of all governance contracts
                                          ▼
          ┌─────────────┬─────────────┬───┴──────┬──────────────┬──────────────┐
          ▼             ▼             ▼          ▼              ▼              ▼
     PrimeCDO      RiskParams   RedemptionPol  Cooldowns   BaseStrategy   AprPairFeed
                                                                          (ADMIN_ROLE)

                            ┌───────────────────────────┐
                            │ Guardian Multisig (Safe)  │  3/5 security council
                            └─────────────┬─────────────┘
                                          │ instant emergency, no delay
                                          ▼
            ┌────────────────────┬────────┴──────────┬──────────────────┐
            ▼                    ▼                   ▼                  ▼
     PrimeCDO.unpause      PrimeCDO.triggerPause  Strategy.pause   PrimeLock.cancel
```

---

## Roles

| Role | Implementation | Powers |
|------|----------------|--------|
| **Owner** (Ownable2Step / DEFAULT_ADMIN_ROLE) | PrimeLock at Stage 3 | All parameter changes, upgrades, ownership transfers. Subject to 24-hour delay. |
| **Operations Multisig** | Safe 3/5, PrimeLock `PROPOSER_ROLE` + `EXECUTOR_ROLE` | Schedule and execute proposals on PrimeLock |
| **Emergency Guardian** | Safe 3/5 (separate signers), PrimeLock `CANCELLER_ROLE` + contract `s_guardian` | Instant pause/unpause. Cancel malicious proposals. **Cannot** change parameters. |
| **Keeper** | EOA bot + PrimeCDO (`KEEPER_ROLE` on AprPairFeed) | Push APR updates. Low trust — cannot extract value. |

---

## Guardian Powers (Bypass Timelock)

The Guardian multisig has **narrow emergency powers** that bypass the 24-hour timelock delay:

| Contract | Function | Purpose |
|----------|----------|---------|
| `PrimeCDO` | `triggerShortfallPause()` | Manual emergency pause |
| `PrimeCDO` | `unpauseShortfall()` | Recover from shortfall pause |
| `BaseStrategy` | `pause()` / `unpause()` | Stop strategy deposits/withdrawals |
| `PrimeLock` | `cancel(id)` | Veto a queued malicious proposal |

Guardian **cannot**:
- Change any parameters (`setMinCoverage`, risk params, cooldown fees, etc.)
- Register new tranches
- Transfer ownership
- Claim reserves
- Upgrade contracts

This limits the blast radius if the Guardian multisig is compromised.

---

## Rollout Stages

### Stage 1 — Launch (Deployer EOA)

- **Owner:** Deployer EOA
- **Purpose:** Initial setup, integration testing, bug fixes
- **Duration:** Immediately after deploy
- **Risk:** High centralization — only suitable during launch window

### Stage 2 — Operations Multisig

- **Owner:** Operations Safe (3/5 team)
- **Transition:** Deployer calls `transferOwnership(OPS_MULTISIG)` on all Ownable2Step
  contracts, then Ops Multisig calls `acceptOwnership()`. Renounce `DEFAULT_ADMIN_ROLE`
  from deployer on AprPairFeed, grant to Ops.
- **Purpose:** Consensus-based day-to-day operations, no single point of failure
- **Duration:** 1-2 weeks post-launch, until protocol is stable
- **Risk:** Medium — 3-of-5 multisig still has instant execution

### Stage 3 — PrimeLock + Guardian (Current Target)

- **Owner:** PrimeLock (24-hour delay)
- **Proposer:** Operations Multisig
- **Canceller:** Guardian Multisig
- **Guardian:** separate 3/5 Safe with narrow emergency powers
- **Transition:**
  1. Run `deploy/06_deploy_primelock.ts` — deploy PrimeLock
  2. Run `deploy/07_transfer_governance.ts` — transfer ownership to PrimeLock, set Guardian
  3. Ops Multisig submits proposal from `deploy/08_accept_governance.ts` — PrimeLock
     schedules `acceptOwnership()` batch, waits 24 hours, executes
  4. Ops Multisig schedules `grantRole(CANCELLER_ROLE, Guardian)` as first proposal
- **Purpose:** Decentralized governance with exit window for users
- **Duration:** Long-term until Stage 4 activates

### Stage 4 — Full DAO (Future, Out of Current Scope)

- Deploy `PRIME` ERC20Votes token
- Deploy OpenZeppelin `Governor` contract
- Governor becomes `PROPOSER_ROLE` on PrimeLock (alongside or replacing Ops Multisig)
- Token holders propose and vote via Governor
- Snapshot voting power by block (flash-loan resistant)

---

## PrimeLock Configuration

```
minDelay:  86,400 seconds (24 hours) — hardcoded in PrimeLock.sol
proposers: [OPS_MULTISIG]
executors: [OPS_MULTISIG, address(0)]   // anyone can execute after delay
admin:     address(0)                   // no admin → roles immutable
```

**Rationale for `address(0)` admin:** Once deployed, proposers and executors cannot be
changed. To replace the Operations Multisig, a new PrimeLock must be deployed and
ownership migrated. This prevents any future admin compromise from rotating governance.

**Rationale for `address(0)` in executors list:** After the 24-hour delay elapses, anyone
can execute the queued proposal. This ensures liveness even if the Ops Multisig becomes
inactive.

---

## Parameter Change Workflow (Stage 3)

Example: changing `s_minCoverageForDeposit` from 105% to 110%.

1. **Discussion** — off-chain via forum / Snapshot signal (optional)
2. **Schedule** — Ops Multisig calls:
   ```
   PrimeLock.schedule(
       target:      PrimeCDO,
       value:       0,
       data:        PrimeCDO.setMinCoverageForDeposit(1.10e18) calldata,
       predecessor: 0x0,
       salt:        keccak256("set-min-coverage-v1"),
       delay:       86400  // 24 hours
   )
   ```
3. **Wait 24 hours** — users see the pending proposal on-chain, have time to exit if they
   disagree
4. **Guardian review** — Guardian Multisig can call `PrimeLock.cancel(id)` if the
   proposal is deemed malicious
5. **Execute** — after delay, anyone (or Ops Multisig) calls:
   ```
   PrimeLock.execute(target, value, data, predecessor, salt)
   ```
6. Parameter is updated on PrimeCDO

---

## Emergency Procedures

### Scenario 1: Strategy exploit detected

1. Guardian calls `BaseStrategy.pause()` — instant, no delay
2. Guardian calls `PrimeCDO.triggerShortfallPause()` — blocks deposits/withdrawals
3. Ops Multisig schedules recovery proposal via PrimeLock (24-hour delay)
4. After delay, recovery executes; Guardian calls `unpause()` to resume

### Scenario 2: Malicious proposal detected

1. Ops Multisig schedules proposal
2. Community flags the proposal
3. Guardian calls `PrimeLock.cancel(proposalId)` — veto, instant
4. If Ops Multisig is compromised, Guardian can deploy replacement PrimeLock and new Ops

### Scenario 3: Junior share price drops below 90%

1. **Automatic** — `_checkJuniorShortfall()` triggers `s_shortfallPaused = true`
   on any deposit/withdraw
2. Ops Multisig investigates, proposes recovery via PrimeLock
3. Guardian or Ops calls `unpauseShortfall()` after recovery

---

## Audit Checklist

Before activating Stage 3:

- [ ] PrimeLock deployed with correct delay (24 hours)
- [ ] Proposers = Ops Multisig; Executors include `address(0)` for liveness
- [ ] Admin role set to `address(0)`
- [ ] Guardian Multisig deployed with 3/5 threshold, signers distinct from Ops
- [ ] All `Ownable2Step` contracts: ownership transferred + accepted by PrimeLock
- [ ] AprPairFeed: `DEFAULT_ADMIN_ROLE` granted to PrimeLock, renounced from deployer
- [ ] PrimeCDO.s_guardian and BaseStrategy.s_guardian set to Guardian Multisig address
- [ ] PrimeLock.CANCELLER_ROLE granted to Guardian Multisig (via first proposal)
- [ ] All critical functions verified to require either PrimeLock (parameters) or Guardian
      (emergency)
- [ ] Documentation published for community
- [ ] Emergency runbook written for Guardian signers

---

## Contract Map

| Contract | Access Control | Stage 3 Owner | Guardian Access |
|----------|---------------|---------------|-----------------|
| `PrimeCDO` | Ownable2Step | PrimeLock | unpauseShortfall, triggerShortfallPause |
| `RiskParams` | Ownable2Step | PrimeLock | — |
| `RedemptionPolicy` | Ownable2Step | PrimeLock | — |
| `ERC20Cooldown` | Ownable2Step | PrimeLock | — |
| `SharesCooldown` | Ownable2Step | PrimeLock | — |
| `BaseStrategy` (SUSDaiStrategy) | Ownable2Step | PrimeLock | pause, unpause |
| `AprPairFeed` | AccessControl | PrimeLock (DEFAULT_ADMIN_ROLE) | — |
| `TrancheVault` | (no admin — logic delegated to PrimeCDO) | n/a | n/a |
| `Accounting` | onlyCDO modifier | n/a | n/a |
| `PrimeLens` | no state, pure reads | n/a | n/a |

---

## References

- PrimeLock contract: `contracts/governance/PrimeLock.sol`
- OpenZeppelin `TimelockController` (inherited by PrimeLock):
  `@openzeppelin/contracts/governance/TimelockController.sol`
- OpenZeppelin Governance docs: https://docs.openzeppelin.com/contracts/5.x/governance
- Safe multisig: https://safe.global
- Deploy scripts: `deploy/06_deploy_primelock.ts`, `deploy/07_transfer_governance.ts`,
  `deploy/08_accept_governance.ts`
- Unit tests: `test/unit/Governance.test.ts`
