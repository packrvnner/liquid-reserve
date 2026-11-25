// Runs the bot's creator-cut job, and then the reserve job, against a LOCAL anvil fork
// of Elysium (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   npx tsx hosted/test-creator-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runCreator, CREATOR_CONFIG, CreatorReport } from "./creator.js";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";

const RPC = "http://127.0.0.1:8597";
const cfg = { ...CREATOR_CONFIG, rpc: RPC, rpcGapMs: 0 };
const rcfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0 };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUNDER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil account #2
const OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8", LAUNCH_A = "0xf6030669549B2C1403E184F93abEDf50A50Ab6f9";
const WHYPE = cfg.tokens[0].address, KHYPE = rcfg.tokens.KHYPE;
const balOf = (token: string, who: string) => BigInt(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`).split(" ")[0]);
const warp = (secs: number) => { cast(`rpc evm_increaseTime ${secs}`); cast("rpc evm_mine"); };
const impersonate = (a: string) => { cast(`rpc anvil_impersonateAccount ${a}`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); };
const fundCreatorWait = (hype: string) => {
  sh(`cast send ${WHYPE} "deposit()" --value ${hype}ether --private-key ${FUNDER_KEY} --rpc-url ${RPC} > /dev/null`);
  sh(`cast send ${WHYPE} "transfer(address,uint256)" ${cfg.creatorWait} $(cast to-wei ${hype}) --private-key ${FUNDER_KEY} --rpc-url ${RPC} > /dev/null`);
};
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: { status: string; reason: string; actions: any[] }) => console.log(`       -> ${r.status}: ${r.reason}${r.actions.length ? "\n          " + r.actions.map((a) => `${a.what}${a.note ? ` [${a.note}]` : a.confirmed ? " [confirmed]" : " [NOT confirmed]"}`).join("\n          ") : ""}`);
const env = (extra: Record<string, string> = {}) => (k: string) => ({ KEEPER_PRIVATE_KEY: KEY, ...extra })[k];
const run = async (extra: Record<string, string> = {}): Promise<CreatorReport> => { const r = await runCreator({ ethers: { Wallet, utils }, fetch, env: env(extra) }, cfg); show(r); return r; };

// Hyperliquid stand-in for the reserve job: the "outside" price equals the pool price.
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
const reserve = async () => { const r = await runReserve({ ethers: { Wallet, utils }, fetch: fakeFetch, env: env() }, rcfg); show(r); return r; };

console.log("1. the waiting contract points nowhere: the job leaves the creator cut alone");
fundCreatorWait("0.05");
let r = await run();
check("does nothing", r.status === "off" && r.actions.length === 0 && balOf(WHYPE, cfg.creatorWait) >= 5n * 10n ** 16n);

console.log("2. the owner points it at the reserve (the one-time step)");
impersonate(OWNER);
sh(`cast send ${cfg.creatorWait} "setTarget(address)" ${cfg.allocator} --from ${OWNER} --unlocked --rpc-url ${RPC} > /dev/null`);
const before = balOf(WHYPE, cfg.creatorWait), alloc0 = balOf(WHYPE, cfg.allocator);
r = await run({ DRY_RUN: "1" });
check("dry run sends nothing", r.actions.length === 1 && !r.actions[0].tx && balOf(WHYPE, cfg.creatorWait) === before);
r = await run();
check("creator cut passed on to the reserve's allocator", r.status === "acted" && balOf(WHYPE, cfg.creatorWait) === 0n && balOf(WHYPE, cfg.allocator) - alloc0 === before, `${utils.formatEther(before.toString())} WHYPE`);
r = await run();
check("then nothing more to do", r.status === "idle" && r.actions.length === 0);

console.log("3. the reserve job picks it up from the allocator, buys and locks");
impersonate(LAUNCH_A);
sh(`cast send ${rcfg.oracle} "setKeeper(address,bool)" ${KEEPER} true --from ${LAUNCH_A} --unlocked --rpc-url ${RPC} > /dev/null`);
const k0 = balOf(KHYPE, rcfg.reserve);
let rr = await reserve();
hlHype = rr.prices!.hypeUsd; hlKntq = rr.prices!.kntqUsd;
for (let i = 0; i < 6 && rr.status !== "moving"; i++) { warp(600); rr = await reserve(); }
check("bought and locked from the allocator", rr.status === "moving" && balOf(WHYPE, cfg.allocator) === 0n && balOf(KHYPE, rcfg.reserve) > k0, `${utils.formatEther((balOf(KHYPE, rcfg.reserve) - k0).toString())} kHYPE more locked`);

console.log("4. a small amount waits until it is worth moving; the kill switch stops the job");
r = await run(); // the split in step 3 put a fresh 20% in the waiting contract
check("the creator cut of that very cycle is passed on too", r.status === "acted" && balOf(WHYPE, cfg.creatorWait) === 0n);
fundCreatorWait("0.005");
r = await run();
check("0.005 HYPE is left to build up", r.status === "idle" && balOf(WHYPE, cfg.creatorWait) === 5n * 10n ** 15n);
r = await run({ CREATOR_PAUSED: "1" });
check("paused", r.status === "paused");
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
