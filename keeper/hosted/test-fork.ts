// Runs the hosted keeper against the LOCAL anvil fork of Elysium (never a real
// network) and walks it through every decision. Uses anvil's public test keys.
//   npx tsx hosted/test-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runKeeper, CONFIG, Config, Report } from "./core.js";

const RPC = "http://127.0.0.1:8545";
const local = JSON.parse(readFileSync(new URL("../../site/deployment.local.json", import.meta.url), "utf8"));
const vaultAddr = (id: string) => local.vaults.find((v: any) => v.id === id).address;
const cfg: Config = { ...CONFIG, rpc: RPC, rpcGapMs: 0, vaults: [{ ...CONFIG.vaults[0], address: vaultAddr("hype-usdc") }, { ...CONFIG.vaults[1], address: vaultAddr("hype-kntq") }] };

const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
const TRADER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil account #2
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account #0
const TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const SWAPPER = sh(`cast call $(cast call ${local.elysium.contracts.yieldRouter} "swapConfig()(address)" --rpc-url ${RPC}) "swapper()(address)" --rpc-url ${RPC}`);
const swap = (a: string, b: string, amount: string) => sh(`cast send ${SWAPPER} "swap(address,address,uint256,uint256,address)" ${a} ${b} ${amount} 0 ${TRADER} --private-key ${TRADER_KEY} --rpc-url ${RPC} > /dev/null`);
const usdcOf = (who: string) => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${who}`).split(" ")[0]);
/** Sell 2 HYPE, then buy back with exactly the USDC received: fees accrue, the price ends where it began. */
const churn = () => { const before = usdcOf(TRADER); swap(WHYPE, USDC, "2000000000000000000"); swap(USDC, WHYPE, (usdcOf(TRADER) - before).toString()); };
const warp = (secs: number, blocks = 1) => { for (let i = 0; i < blocks; i++) { cast(`rpc evm_increaseTime ${Math.round(secs / blocks)}`); cast("rpc evm_mine"); } };

// Hyperliquid stand-in so the test controls the "outside" price.
let hlHypeUsd = 0, hlKntqUsd = 0.28;
const fakeFetch: typeof fetch = async (url: any, init?: any) => {
  if (String(url).includes("hyperliquid")) {
    const body = JSON.parse(init.body);
    const out = body.type === "spotMeta"
      ? { tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }, { name: "KNTQ", index: 124 }], universe: [{ name: "@107", tokens: [150, 0] }, { name: "@334", tokens: [124, 0] }] }
      : { "@107": String(hlHypeUsd), "@334": String(hlKntqUsd) };
    return new Response(JSON.stringify(out));
  }
  return fetch(url, init);
};
const run = (env: Record<string, string>) => runKeeper({ ethers: { Wallet, utils }, fetch: fakeFetch, env: (k) => env[k] }, cfg);
const usdcVault = (r: Report) => r.vaults[0];
let failed = 0;
const check = (name: string, ok: boolean, r?: Report) => { console.log(`${ok ? "  PASS" : "  FAIL"} ${name}${r ? `  ->  ${usdcVault(r).action}: ${usdcVault(r).reason}` : ""}`); if (!ok) failed++; };
const poolPrice = () => 1.0001 ** Number(cast(`call ${cfg.vaults[0].address} "price()(uint160,int24)"`).split("\n")[1].split(" ")[0]) * 1e12;

async function main() {
  const snapshot = cast("rpc evm_snapshot").replace(/"/g, ""); // the fork is put back as it was found
  try { await scenario(); } finally { cast(`rpc evm_revert ${snapshot}`); }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll hosted-keeper checks passed.");
  process.exit(failed ? 1 : 0);
}

async function scenario() {
  const V = cfg.vaults[0].address, keeper = new Wallet(KEEPER_KEY).address, PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1";
  sh(`cast send ${V} "setKeeper(address)" ${keeper} --private-key ${OWNER_KEY} --rpc-url ${RPC} > /dev/null`);
  sh(`cast rpc anvil_setBalance ${keeper} 0x8AC7230489E80000 --rpc-url ${RPC} > /dev/null`);
  // Earlier local simulations left the forked PoolManager short of native HYPE; top it up, and fund the trader.
  sh(`cast rpc anvil_setBalance ${PM} 0xD3C21BCECCEDA1000000 --rpc-url ${RPC} > /dev/null`);
  sh(`cast rpc anvil_setBalance ${TRADER} 0xD3C21BCECCEDA1000000 --rpc-url ${RPC} > /dev/null`);
  sh(`cast send ${WHYPE} "deposit()" --value 60000ether --private-key ${TRADER_KEY} --rpc-url ${RPC} > /dev/null`);
  warp(7 * 3600); // clear the cooldown and the 6-hour spacing left by earlier tests
  const live = { KEEPER_PRIVATE_KEY: KEEPER_KEY };
  const mainLiquidity = () => BigInt(cast(`call ${V} "main()(int24,int24,uint128)"`).split("\n")[2].split(" ")[0]);
  let r: Report;

  // The local vault starts however earlier tests left it. Bring it to the state a
  // vault is in right after its price ran out of range: one token only, main range empty.
  console.log("0. set-up: push the price out of range and let the keeper move the range");
  for (let i = 0; i < 400 && usdcVault(await run({})).inRange; i++) swap(WHYPE, USDC, "3000000000000000000"); // 3 HYPE at a time: this pool is thin
  warp(660, 11);
  hlHypeUsd = poolPrice();
  r = await run(live);
  check("moves the range once the price has been steady outside it", usdcVault(r).action === "rebalance" && usdcVault(r).confirmed === true, r);
  r = await run(live);
  check("then holds one token, nothing active, and says so", usdcVault(r).action === "none" && usdcVault(r).active === false && (usdcVault(r).mainShare ?? 1) < 0.05, r);

  console.log("1. no key configured");
  r = await run({});
  check("watch-only mode, nothing sent", r.mode === "watch-only" && r.keeper === null && r.vaults.every((v) => !v.tx), r);

  console.log("2. a malformed key is rejected without being echoed");
  r = await run({ KEEPER_PRIVATE_KEY: "not-a-key-SECRETVALUE" });
  check("warning does not contain the value", r.mode === "watch-only" && !JSON.stringify(r).includes("SECRETVALUE") && r.warnings.length === 1);

  console.log("3. paused");
  r = await run({ ...live, KEEPER_PAUSED: "1" });
  check("does nothing when paused", r.mode === "paused" && r.vaults.length === 0);

  console.log("4. the price trades back into the vault's one-sided range, so it holds both tokens again");
  // The trader buys HYPE back (with the USDC it got in step 0) until the vault's smaller side is about a third of its value.
  const lesserSide = () => {
    const [t0, t1] = cast(`call ${V} "balances()(uint256,uint256)"`).split("\n").map((l) => Number(l.split(" ")[0]));
    const v0 = t0 * (poolPrice() / 1e12);
    return Math.min(v0, t1) / (v0 + t1);
  };
  for (let i = 0; i < 400 && lesserSide() < 0.3 && usdcVault(await run({})).inRange; i++) swap(USDC, WHYPE, "40000000"); // $40 at a time
  hlHypeUsd = poolPrice();
  r = await run(live);
  check("waits: the ranges were moved less than 6 hours ago", usdcVault(r).inRange === true && usdcVault(r).action !== "rebalance" && !usdcVault(r).tx, r);
  warp(7 * 3600, 14);
  r = await run({ ...live, DRY_RUN: "1" });
  check("dry run reports it would rebuild the main range, sends nothing", usdcVault(r).action === "rebalance" && /dry run/.test(usdcVault(r).reason) && !usdcVault(r).tx, r);
  r = await run(live);
  check("rebuilds the main range", usdcVault(r).action === "rebalance" && /rebuilt/.test(usdcVault(r).reason) && usdcVault(r).confirmed === true && mainLiquidity() > 0n, r);
  r = await run(live);
  check("main range now holds a real share and is active", usdcVault(r).active === true && (usdcVault(r).mainShare ?? 0) >= 0.3, r);

  console.log("5. in range, with fees waiting");
  churn();
  warp(7 * 3600);
  r = await run(live);
  check("waits while the fees are small next to the network fee", usdcVault(r).action === "none" && /times the network fee/.test(usdcVault(r).reason) && !usdcVault(r).tx, r);
  for (let i = 0; i < 40; i++) churn();
  r = await run({ ...live, DRY_RUN: "1" });
  check("dry run reports it would compound, sends nothing", usdcVault(r).action === "harvest" && !usdcVault(r).tx, r);
  r = await run(live);
  check("compounds fees", usdcVault(r).action === "harvest" && usdcVault(r).confirmed === true, r);
  r = await run(live);
  check("then leaves it alone", usdcVault(r).action === "none", r);

  console.log("6. price pushed out of range just now (a manipulation looks like this)");
  for (let i = 0; i < 400 && usdcVault(await run({})).inRange; i++) swap(WHYPE, USDC, "3000000000000000000"); // 3 HYPE at a time: this pool is thin
  hlHypeUsd = poolPrice();
  r = await run(live);
  check("does NOT move the range: price was inside minutes ago", usdcVault(r).action === "skip" && /waiting/.test(usdcVault(r).reason) && !usdcVault(r).tx, r);

  console.log("7. still out of range 11 minutes later, but the outside market disagrees");
  warp(660, 11);
  hlHypeUsd = poolPrice() * 0.9;
  r = await run(live);
  check("does NOT move the range: pool is far from Hyperliquid", usdcVault(r).action === "skip" && /Hyperliquid/.test(usdcVault(r).reason) && !usdcVault(r).tx, r);

  console.log("8. outside market unreachable");
  hlHypeUsd = NaN;
  r = await run(live);
  check("does NOT move the range without an outside price", usdcVault(r).action === "skip" && !usdcVault(r).tx, r);

  console.log("9. steady and the outside market agrees, but the wallet is not the keeper");
  hlHypeUsd = poolPrice();
  r = await run({ KEEPER_PRIVATE_KEY: TRADER_KEY });
  check("a non-keeper wallet does nothing", usdcVault(r).action === "skip" && /not the vault's keeper/.test(usdcVault(r).reason), r);

  console.log("10. everything lines up");
  r = await run(live);
  check("moves the range", usdcVault(r).action === "rebalance" && usdcVault(r).confirmed === true, r);
}
main().catch((e) => { console.error(e); process.exit(1); });
