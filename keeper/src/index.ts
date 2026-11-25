// Liquid Reserve keeper: runs the flywheel on Elysium and HyperEVM.
//   npm start                  run forever
//   npm run once               run every task once, then exit (for cron)
//   npm start -- --task NAME   run one task once
//   DRY_RUN=1 ...              simulate everything, send nothing
import { loadConfig } from "./config.js";
import { connect } from "./chain.js";
import { buildCtx, Ctx } from "./context.js";
import { loadState, saveState } from "./state.js";
import { setDryRun } from "./tx.js";
import { registerElysium } from "./networks.js";
import { error, info, setAlertWebhook } from "./log.js";
import * as E from "./tasks/elysium.js";
import * as H from "./tasks/hyperevm.js";

interface Task {
  name: string;
  every: (c: Ctx) => number;
  run: (c: Ctx) => Promise<void>;
}

// Order matters within a cycle: fresh prices first, then money moves downstream.
const TASKS: Task[] = [
  { name: "pokeOracle", every: (c) => c.cfg.tuning.pokeEverySec, run: E.pokeOracle },
  { name: "collectFees", every: (c) => c.cfg.tuning.processEverySec, run: E.collectFees },
  { name: "processSwaps", every: (c) => c.cfg.tuning.processEverySec, run: E.processSwaps },
  { name: "sweepReserve", every: (c) => c.cfg.tuning.processEverySec, run: E.sweepReserve },
  { name: "pokeStaking", every: (c) => c.cfg.tuning.processEverySec, run: E.pokeStaking },
  { name: "bridgeOut", every: (c) => c.cfg.tuning.bridgeEverySec, run: E.bridgeOut },
  { name: "scanBridgeOut", every: (c) => c.cfg.tuning.bridgeEverySec, run: E.scanBridgeOut },
  { name: "harvestElysium", every: (c) => c.cfg.tuning.harvestEverySec, run: E.harvestElysium },
  { name: "harvestVaults", every: (c) => c.cfg.tuning.processEverySec, run: E.harvestVaults },
  { name: "claimWithdrawals", every: (c) => c.cfg.tuning.hyperevmEverySec, run: H.claimWithdrawals },
  { name: "stake", every: (c) => c.cfg.tuning.hyperevmEverySec, run: H.stake },
  { name: "harvestHyperEvm", every: (c) => c.cfg.tuning.harvestEverySec, run: H.harvestHyperEvm },
  { name: "unstakeAndBridge", every: (c) => c.cfg.tuning.hyperevmEverySec, run: H.unstakeAndBridge },
  { name: "scanYieldBridge", every: (c) => c.cfg.tuning.ticketsEverySec, run: H.scanYieldBridge },
  { name: "watchTickets", every: (c) => c.cfg.tuning.ticketsEverySec, run: H.watchTickets },
  { name: "checkGas", every: () => 3600, run: H.checkGas },
];

async function runTask(ctx: Ctx, t: Task) {
  try {
    await t.run(ctx);
  } catch (e: any) {
    error(`task ${t.name} crashed: ${e?.reason ?? e?.message ?? e}`);
  }
  ctx.state.lastRun[t.name] = Math.floor(Date.now() / 1000);
  saveState(ctx.cfg.stateFile, ctx.state);
}

async function main() {
  const argv = process.argv;
  const cfg = loadConfig(argv);
  setDryRun(cfg.dryRun);
  setAlertWebhook(cfg.alertWebhook);
  registerElysium();
  const { elysium, hyperevm, keeper } = await connect(cfg);
  const ctx = await buildCtx(cfg, elysium, hyperevm, keeper, loadState(cfg.stateFile));
  info(`keeper ${keeper} on Elysium${hyperevm ? " + HyperEVM" : ""}${cfg.dryRun ? " (DRY RUN: nothing is sent)" : ""}`);

  const only = argv.includes("--task") ? argv[argv.indexOf("--task") + 1] : undefined;
  if (only) {
    const t = TASKS.find((x) => x.name === only);
    if (!t) throw new Error(`unknown task ${only}; tasks: ${TASKS.map((x) => x.name).join(", ")}`);
    await runTask(ctx, t);
    return;
  }
  if (argv.includes("--once")) {
    for (const t of TASKS) await runTask(ctx, t);
    return;
  }

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    const now = Math.floor(Date.now() / 1000);
    for (const t of TASKS) {
      if (stopping) break;
      const last = ctx.state.lastRun[t.name] ?? 0;
      if (now - last >= t.every(ctx)) await runTask(ctx, t);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  info("stopped");
}

main().catch((e) => {
  error(e?.stack ?? String(e));
  process.exit(1);
});
