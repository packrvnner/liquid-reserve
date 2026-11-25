# Liquid Reserve keeper

Runs the flywheel on Elysium and HyperEVM. Every contract function it calls is
public, so the keeper holds no special power over funds. Its one privileged role
is poking the price oracle. If it stops, nothing is lost: money just waits until
it (or anyone) runs again. The one exception is bridge tickets (see "What needs a
human").

## What it does

| Task | Chain | Every | What |
|---|---|---|---|
| `pokeOracle` | Elysium | 60 s | Records prices for the 30-minute TWAP |
| `collectFees` | Elysium | 10 min | Ascend escrow `settle` + `claim` → FeeInbox `forward` → FeeRouter `distribute` |
| `processSwaps` | Elysium | 10 min | `allocatePartial` / `payoutPartial` / `routePartial`, one adaptively sized piece per token |
| `sweepReserve` | Elysium | 10 min | Moves stray tokens (e.g. holder rewards) from the reserve to the waterfall |
| `pokeStaking` | Elysium | 10 min | Starts the next $liquid staking reward period |
| `bridgeOut` / `scanBridgeOut` | Elysium | 1 h | Sends the KNTQ bucket to HyperEVM; tracks every withdrawal |
| `harvestElysium` | Elysium | 1 day | `harvestAll` when there's yield |
| `claimWithdrawals` | HyperEVM | 1 h | Claims confirmed withdrawals from the outbox (proofs built in [src/outbox.ts](src/outbox.ts)) |
| `stake` | HyperEVM | 1 h | KNTQ → sKNTQ → HyperEVM reserve |
| `harvestHyperEvm` | HyperEVM | 1 day | Harvests sKNTQ yield above `minYieldToHarvest` |
| `unstakeAndBridge` | HyperEVM | 1 h | Requests unstake; confirms after 7 days; bridges KNTQ to the Elysium YieldRouter |
| `scanYieldBridge` / `watchTickets` | both | 15 min | Redeems any HyperEVM → Elysium ticket that didn't auto-execute |
| `checkGas` | both | 1 h | Alerts when the keeper's HYPE runs low |

**Adaptive pieces.** Thin pools can't take a big batch within the 1% slippage band:
- The keeper halves a piece until its simulation passes, sends one piece per token
  per tick, then doubles the size again.
- Spacing the pieces lets the 30-minute price average keep up, so $liquid is bought
  steadily instead of all at once.

Every call is simulated first. "Nothing to do" reverts are silent; price reverts
shrink the piece; anything else is logged.

## Setup

```bash
export PATH="$HOME/.nodejs/bin:$PATH"
cd keeper
cp .env.example .env                                   # add KEEPER_PRIVATE_KEY
cp keeper.config.example.json keeper.config.json       # fill in deployed addresses
```

- **Keeper wallet:** use a fresh hot wallet that only holds gas, with ~0.5 HYPE on
  each chain. Bridge fees are about 0.001 HYPE each. Never reuse a wallet that holds
  funds or the payout address.
- **Oracle keeper role:** the wallet must be the oracle keeper. Pass it as `KEEPER`
  to `DeploySystem`. Changing keepers later needs a timelock operation.
- **Ascend escrow:** `ascendEscrow` is $liquid's CreatorEscrow, the second indexed
  address in Ascend's `EscrowLaunched` event for the $liquid launch.
- **Deploy blocks:** set `deployBlock` to each chain's deployment block.

## Run

```bash
npm run status                 # read-only snapshot of both reserves and pending work
DRY_RUN=1 npm run once         # simulate every task, send nothing
npm start                      # run forever
npm start -- --task stake      # run one task
```

Keep it running somewhere that doesn't sleep (a small VPS with `pm2` or
`systemd`). Set `ALERT_WEBHOOK_URL` to a Discord/Slack webhook to get alerts.

## What needs a human

- **ALERT: ticket did not auto-execute.** The keeper redeems these itself. A ticket
  left unredeemed for 7 days is lost.
- **ALERT: keeper is not an oracle keeper, or gas is low.**
- **Withdrawals take time.** Elysium → HyperEVM needs the rollup to confirm
  (≥ 1 day by config; about 6 days observed in November 2026). Claims can also be
  done in Kinetiq's bridge UI.

## Tests

```bash
npm test                       # unit tests (chunk sizing, revert decoding)
npm run typecheck
bash test/e2e-anvil.sh         # deploys on local forks of both mainnets and runs the keeper
```

Read-only checks against mainnet: `scripts/check-withdrawals.ts` (simulates claiming a
real confirmed withdrawal with our proofs) and `scripts/check-deposit.ts`.

## Dependencies

`ethers` v5 and `@arbitrum/sdk` 4.1.0 (pinned). `npm audit` reports 15 low-severity
advisories, all in `elliptic` under ethers v5, with no fix in v5. `ws` is pinned to a
patched 8.22.0; the keeper only uses HTTP RPC anyway.

## Hosted vault keeper

The two live vaults are looked after by a much smaller bot in [hosted/](hosted/),
running as a Supabase Edge Function every 10 minutes. It only compounds vault
fees and re-centers vault ranges, with price checks before any move. See
[hosted/README.md](hosted/README.md). The full keeper in `src/` is for the
reserve and flywheel, which are not deployed yet.
