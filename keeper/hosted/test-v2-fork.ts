// Runs the bot's vault job against the self-balancing HYPE-USDC vault on a LOCAL anvil fork of
// Elysium (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   npx tsx hosted/test-v2-fork.ts
// Opens the vault with the exact launch transaction, makes a HYPE-only first deposit, pushes the
// price out of its range, and checks the bot moves it back with a swap so it earns again.
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runKeeper, CONFIG, Config, Report } from "./core.js";

const RPC = "http://127.0.0.1:8597";
const D = JSON.parse(readFileSync(new URL("../../site/tools/vault-v2-data.json", import.meta.url), "utf8"));
const VAULT = D.vault, OWNER = D.owner;
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const SWAPPER = "0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TRADER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const cfg: Config = { ...CONFIG, rpc: RPC, rpcGapMs: 0, vaults: [CONFIG.vaults.find((v) => v.swaps)!] };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const state = () => {
  const [b0, b1] = first(cast(`call ${VAULT} "balances()(uint256,uint256)"`)).map(BigInt);
  const [sqrt, tick] = first(cast(`call ${VAULT} "price()(uint160,int24)"`));
  const m = first(cast(`call ${VAULT} "main()(int24,int24,uint128)"`));
  return { b0, b1, sqrt: BigInt(sqrt), tick: +tick, lo: +m[0], hi: +m[1], l: BigInt(m[2]) };
};
const earning = (s: ReturnType<typeof state>) => s.l > 0n && s.tick >= s.lo && s.tick < s.hi;
let hl = 0;
const fakeFetch: typeof fetch = async (url: any, init?: any) => {
  if (String(url).includes("hyperliquid")) {
    const body = JSON.parse(init.body);
    const out = body.type === "spotMeta"
      ? { tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }, { name: "KNTQ", index: 124 }], universe: [{ name: "@107", tokens: [150, 0] }, { name: "@334", tokens: [124, 0] }] }
      : { "@107": String(hl), "@334": "0.24" };
    return new Response(JSON.stringify(out));
  }
  return fetch(url, init);
};
const run = () => runKeeper({ ethers: { Wallet, utils }, fetch: fakeFetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY })[k as "KEEPER_PRIVATE_KEY"] }, cfg);
const show = (r: Report) => console.log(`       -> ${r.vaults.map((v) => `${v.name}: ${v.action}, ${v.reason}${v.tx ? ` [${v.confirmed ? "confirmed" : "NOT confirmed"}]` : ""}`).join("; ")}`);

const snap = cast("rpc evm_snapshot").replace(/"/g, "");
try {
  console.log("1. open the vault with the launch transaction, first deposit in HYPE only");
  cast("rpc evm_mine");
  sh(`cast send ${D.to} ${D.data} --private-key ${TRADER_KEY} --rpc-url ${RPC} --gas-limit 8000000 > /dev/null`);
  sh(`cast send ${VAULT} "deposit(uint256,uint256,uint256,address)" 1 100000000000000000 0 ${KEEPER} --value 0.1ether --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
  let s = state();
  check("it balanced itself and earns straight away", earning(s) && s.b1 > 0n, `HYPE ${utils.formatEther(s.b0.toString())}, USDC ${utils.formatUnits(s.b1.toString(), 6)}`);
  // the test key stands in for the bot as keeper
  cast(`rpc anvil_impersonateAccount ${OWNER}`); cast(`rpc anvil_setBalance ${OWNER} 0x56BC75E2D63100000`);
  sh(`cast send ${VAULT} "setKeeper(address)" ${KEEPER} --from ${OWNER} --unlocked --rpc-url ${RPC} > /dev/null`);
  hl = (Number(s.sqrt) / 2 ** 96) ** 2 * 1e12;
  let r = await run(); show(r);
  check("the bot leaves a healthy vault alone", r.vaults[0].action !== "rebalance");

  console.log("2. HYPE's price falls through the whole range: the vault ends up holding only HYPE");
  sh(`cast send ${WHYPE} "deposit()" --value 200ether --private-key ${TRADER_KEY} --rpc-url ${RPC} > /dev/null`);
  sh(`cast send ${WHYPE} "approve(address,uint256)" ${SWAPPER} $(cast max-uint) --private-key ${TRADER_KEY} --rpc-url ${RPC} > /dev/null`);
  for (let i = 0; i < 150 && earning(state()); i++) sh(`cast send ${SWAPPER} "swap(address,address,uint256,uint256,address)" ${WHYPE} ${USDC} 1000000000000000000 0 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --private-key ${TRADER_KEY} --rpc-url ${RPC} > /dev/null`);
  s = state();
  check("out of range, all HYPE", !earning(s) && s.tick < s.lo, `tick ${s.tick}, range [${s.lo}, ${s.hi}]`);
  // the new price holds for ten minutes, and the outside market agrees with it
  for (let i = 0; i < 6; i++) { cast("rpc evm_increaseTime 130"); cast("rpc evm_mine"); }
  hl = (Number(state().sqrt) / 2 ** 96) ** 2 * 1e12;

  console.log("3. the bot moves the range; the vault swaps half itself; it earns again");
  r = await run(); show(r);
  s = state();
  check("moved and earning", r.vaults[0].action === "rebalance" && r.vaults[0].confirmed === true && earning(s) && s.b1 > 0n, `HYPE ${utils.formatEther(s.b0.toString())}, USDC ${utils.formatUnits(s.b1.toString(), 6)}, range [${s.lo}, ${s.hi}] around ${s.tick}`);
  r = await run(); show(r);
  check("then left alone", r.vaults[0].action !== "rebalance");
} finally {
  cast(`rpc evm_revert ${snap}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
