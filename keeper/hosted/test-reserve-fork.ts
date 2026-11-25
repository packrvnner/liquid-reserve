// Runs the bot's reserve job against a LOCAL anvil fork of Elysium on which the
// reserve has been launched and connected (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   then launch through site/tools/reserve-launch.html?data=reserve-data.local.json&devwallet=1
//   npx tsx hosted/test-reserve-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runReserve, RESERVE_CONFIG, ReserveConfig, ReserveReport } from "./reserve.js";

const RPC = "http://127.0.0.1:8597";
// The daily yield step has its own test (test-yield-fork.ts); it is switched off here so this one only exercises the fee cycle.
const cfg: ReserveConfig = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12, minYieldHype: "1000" };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUNDER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil account #2
const LAUNCH_A = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F"; // the oracle's owner: launch contract A until 2026-11-20, the timelock since
const T = cfg.tokens;
const balOf = (token: string, who: string) => BigInt(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`).split(" ")[0]);
const warp = (secs: number) => { cast(`rpc evm_increaseTime ${secs}`); cast("rpc evm_mine"); };
const fund = (hype: string) => {
  sh(`cast send ${T.WHYPE} "deposit()" --value ${hype}ether --private-key ${FUNDER_KEY} --rpc-url ${RPC} > /dev/null`);
  sh(`cast send ${T.WHYPE} "transfer(address,uint256)" ${cfg.feeInbox} $(cast to-wei ${hype}) --private-key ${FUNDER_KEY} --rpc-url ${RPC} > /dev/null`);
};

// Hyperliquid stand-in so the test controls the "outside" price.
let hlHype = 0, hlKntq = 0;
const fakeFetch: typeof fetch = async (url: any, init?: any) => {
  if (String(url).includes("hyperliquid")) {
    const body = JSON.parse(init.body);
    const out = body.type === "spotMeta"
      ? { tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }, { name: "KNTQ", index: 124 }], universe: [{ name: "@107", tokens: [150, 0] }, { name: "@334", tokens: [124, 0] }] }
      : { "@107": String(hlHype), "@334": String(hlKntq) };
    return new Response(JSON.stringify(out));
  }
  return fetch(url, init);
};
const run = (env: Record<string, string> = { KEEPER_PRIVATE_KEY: KEEPER_KEY }) => runReserve({ ethers: { Wallet, utils }, fetch: fakeFetch, env: (k) => env[k] }, cfg);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: ReserveReport) => console.log(`       -> ${r.status}: ${r.reason}${r.actions.length ? "\n          " + r.actions.map((a) => `${a.what}${a.note ? ` [${a.note}]` : a.confirmed ? " [confirmed]" : " [NOT confirmed]"}`).join("\n          ") : ""}`);
const bridgeMin = 25n * 10n ** 18n;

const snap = cast("rpc evm_snapshot").replace(/"/g, "");
try {
  // the test wallet takes the bot's place as the oracle's keeper (the launch contract owns the oracle until the timelock accepts)
  cast(`rpc anvil_impersonateAccount ${LAUNCH_A}`); cast(`rpc anvil_setBalance ${LAUNCH_A} 0x56BC75E2D63100000`);
  sh(`cast send ${cfg.oracle} "setKeeper(address,bool)" ${KEEPER} true --from ${LAUNCH_A} --unlocked --rpc-url ${RPC} > /dev/null`);
  // ArbSys (0x64) does not exist on a plain EVM fork; a stand-in lets the bridge call go through.
  cast(`rpc anvil_setCode 0x0000000000000000000000000000000000000064 $(cd .. && forge inspect MockArbSys deployedBytecode)`);

  // The live fee inbox may hold real fees; move them out so the test controls what is waiting.
  cast(`rpc anvil_impersonateAccount ${cfg.feeInbox}`); cast(`rpc anvil_setBalance ${cfg.feeInbox} 0x56BC75E2D63100000`);
  for (const t of [T.WHYPE, T.USDC, T.KNTQ]) {
    const b = balOf(t, cfg.feeInbox);
    if (b > 0n) sh(`cast send ${t} "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD ${b} --from ${cfg.feeInbox} --unlocked --rpc-url ${RPC} > /dev/null`);
  }

  console.log("1. almost nothing waiting: the bot leaves it and takes no price readings");
  let r = await run(); show(r);
  hlHype = r.prices!.hypeUsd; hlKntq = r.prices!.kntqUsd;
  check("idle", r.status === "idle" && r.actions.length === 0, `$${r.waitingUsd!.toFixed(3)} waiting, $${r.neededUsd!.toFixed(2)} needed`);

  console.log("2. fees arrive: no wallet configured -> it only reports");
  fund("0.15");
  r = await run({}); show(r);
  check("watch-only does nothing", r.mode === "watch-only" && r.actions.length === 0 && r.status === "idle");

  console.log("3. with the wallet: starts taking price readings, moves nothing yet");
  warp(600);
  r = await run(); show(r);
  const early = r.status;
  check("took a price reading", r.actions.some((a) => a.what === "price reading" && a.confirmed === true));
  check("nothing forwarded before prices are ready", early === "warming" ? balOf(T.WHYPE, cfg.feeInbox) > 0n : true, early);
  for (let i = 0; i < 4 && r.status === "warming"; i++) { warp(600); r = await run(); show(r); }

  console.log("4. prices ready: forward, split, buy and lock");
  check("moved", r.status === "moving" && r.actions.filter((a) => a.confirmed === true).length >= 3);
  check("kHYPE locked in the reserve", balOf(T.KHYPE, cfg.reserve) > 0n, utils.formatEther(balOf(T.KHYPE, cfg.reserve).toString()));
  check("KNTQ at the bridge", balOf(T.KNTQ, cfg.bridgeOut) > 0n, utils.formatEther(balOf(T.KNTQ, cfg.bridgeOut).toString()));
  check("USDC parked for $liquid", balOf(T.USDC, cfg.liquidWait) > 0n, utils.formatUnits(balOf(T.USDC, cfg.liquidWait).toString(), 6));
  check("creator share waiting", balOf(T.WHYPE, cfg.creatorWait) > 0n, utils.formatEther(balOf(T.WHYPE, cfg.creatorWait).toString()));
  check("fee inbox emptied of WHYPE", balOf(T.WHYPE, cfg.feeInbox) === 0n && balOf(T.WHYPE, cfg.allocator) === 0n);
  if (process.env.STOP_AFTER_MOVE === "1") { console.log("stopping here; the fork is left with fees moved"); process.exit(failed ? 1 : 0); }
  warp(600);
  r = await run(); show(r);
  // KNTQ that was already at the bridge on the real network can make this purchase complete a batch, which is then sent
  check("then no more readings: idle, or only the KNTQ batch going to the bridge", r.actions.every((a) => /^bridge /.test(a.what)) && (r.status === "idle" || r.actions.length === 1));

  console.log("5. pool price disagrees with the outside market: refuses");
  fund("0.15"); warp(600);
  hlHype *= 1.05;
  r = await run(); show(r);
  check("waits when the pool prices HYPE 5% below Hyperliquid (it would be selling HYPE low)", r.status === "warming" && r.reason.includes("below Hyperliquid") && balOf(T.WHYPE, cfg.feeInbox) > 0n);
  hlHype /= 1.05;
  hlKntq /= 1.05; warp(600); // the pool now prices KNTQ about 5% ABOVE the outside market
  r = await run(); show(r);
  check("waits when the pool prices KNTQ 5% above Hyperliquid (it would overpay for KNTQ)", r.status === "warming" && r.reason.includes("above Hyperliquid") && balOf(T.WHYPE, cfg.feeInbox) > 0n);
  hlKntq *= 1.05 * 1.05; // and now about 5% BELOW it: buying KNTQ here is a good price, so that must not stop it

  console.log("6. dry run: decides, sends nothing");
  warp(600);
  r = await run({ KEEPER_PRIVATE_KEY: KEEPER_KEY, DRY_RUN: "1" }); show(r);
  check("dry run sends nothing, and KNTQ being cheap in the pool does not stop it", r.mode === "dry-run" && r.status === "moving" && r.actions.every((a) => !a.tx) && balOf(T.WHYPE, cfg.feeInbox) > 0n);
  hlKntq /= 1.05;

  console.log("7. the bot was off for 2 hours: fresh readings before anything moves");
  warp(7200);
  r = await run(); show(r);
  check("stale prices: reading taken, nothing moved", r.status === "warming" && balOf(T.WHYPE, cfg.feeInbox) > 0n);
  for (let i = 0; i < 5 && r.status === "warming"; i++) { warp(600); r = await run(); show(r); }
  check("moves once prices are fresh again", r.status === "moving");

  console.log("8. enough KNTQ at the bridge: sends the batch to HyperEVM");
  for (let i = 0; i < 5 && balOf(T.KNTQ, cfg.bridgeOut) < bridgeMin; i++) { fund("0.4"); warp(600); r = await run(); show(r); }
  const atBridge = balOf(T.KNTQ, cfg.bridgeOut);
  warp(600);
  r = await run(); show(r);
  check("bridged", atBridge >= bridgeMin && r.actions.some((a) => a.what.startsWith("bridge") && a.confirmed === true) && balOf(T.KNTQ, cfg.bridgeOut) === 0n, `${utils.formatEther(atBridge.toString())} KNTQ`);

  console.log("9. kill switch");
  r = await run({ KEEPER_PRIVATE_KEY: KEEPER_KEY, KEEPER_PAUSED: "1" });
  check("paused", r.status === "paused" && r.actions.length === 0);
} finally {
  cast(`rpc evm_revert ${snap}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
