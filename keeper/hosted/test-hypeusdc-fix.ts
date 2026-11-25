// Rehearses the HYPE-USDC vault fix on a LOCAL anvil fork of Elysium (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   npx tsx hosted/test-hypeusdc-fix.ts
//
// The vault holds only HYPE, so its main range has nothing in it and it earns nothing; it cannot
// swap by itself. The fix: the vault's only shareholder sends one transaction that turns some HYPE
// into USDC and adds that USDC to the vault (it stays theirs), then the bot rebuilds the main range.
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runKeeper, CONFIG, Config, Report } from "./core.js";

const RPC = "http://127.0.0.1:8597";
const VAULT = "0xdaaac4cc69E28CD1a4A1A8F97db464375E52E298";
const SHAREHOLDER = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37";
const OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8";
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const SWAPPER = "0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4"; // the reserve's swap adapter: anyone may swap through it
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const cfg: Config = { ...CONFIG, rpc: RPC, rpcGapMs: 0, vaults: [CONFIG.vaults[0]] };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const state = () => {
  const [b0, b1] = first(cast(`call ${VAULT} "balances()(uint256,uint256)"`)).map(BigInt);
  const [, tick] = first(cast(`call ${VAULT} "price()(uint160,int24)"`)).map(Number);
  const main = first(cast(`call ${VAULT} "main()(int24,int24,uint128)"`));
  const alt = first(cast(`call ${VAULT} "alt()(int24,int24,uint128)"`));
  return { b0, b1, tick, main: { lo: +main[0], hi: +main[1], l: BigInt(main[2]) }, alt: { lo: +alt[0], hi: +alt[1], l: BigInt(alt[2]) } };
};
const sqrtToPrice = (sqrt: bigint) => (Number(sqrt) / 2 ** 96) ** 2 * 1e12; // USDC per HYPE

/** The one transaction the shareholder sends: wrap `amount` HYPE, swap it to USDC, the USDC goes into the vault. */
export function fixCalldata(amount: bigint, minOut: bigint) {
  const W = new utils.Interface(["function deposit() payable", "function approve(address,uint256) returns (bool)"]);
  const S = new utils.Interface(["function swap(address,address,uint256,uint256,address) returns (uint256)"]);
  const M = new utils.Interface(["function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])"]);
  return M.encodeFunctionData("aggregate3Value", [[
    { target: WHYPE, allowFailure: false, value: amount.toString(), callData: W.encodeFunctionData("deposit", []) },
    { target: WHYPE, allowFailure: false, value: 0, callData: W.encodeFunctionData("approve", [SWAPPER, amount.toString()]) },
    { target: SWAPPER, allowFailure: false, value: 0, callData: S.encodeFunctionData("swap", [WHYPE, USDC, amount.toString(), minOut.toString(), VAULT]) },
  ]]);
}

// Hyperliquid stand-in for the bot's outside-price check: the pool price itself.
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
const show = (r: Report) => console.log(`       -> ${r.vaults.map((v) => `${v.name}: ${v.action}, ${v.reason}${v.tx ? ` [${v.confirmed ? "confirmed" : "NOT confirmed"}]` : ""}`).join("; ")}`);

const snap = cast("rpc evm_snapshot").replace(/"/g, "");
try {
  console.log("0. today: all HYPE, nothing in the main range");
  let s = state();
  console.log(`       HYPE ${utils.formatEther(s.b0.toString())}, USDC ${utils.formatUnits(s.b1.toString(), 6)}, tick ${s.tick}, main [${s.main.lo}, ${s.main.hi}] liquidity ${s.main.l}, alt [${s.alt.lo}, ${s.alt.hi}]`);
  check("starts one-sided and idle", s.b1 === 0n && s.main.l === 0n && s.alt.lo > s.tick);

  console.log("1. the shareholder sends the fix: as much HYPE as the vault holds becomes USDC inside the vault");
  const sqrt = BigInt(first(cast(`call ${VAULT} "price()(uint160,int24)"`))[0]);
  hl = sqrtToPrice(sqrt);
  const amount = s.b0;
  const expected = BigInt(Math.floor(Number(amount) / 1e18 * hl * 0.997 * 1e6));
  const minOut = expected * 97n / 100n;
  cast(`rpc anvil_impersonateAccount ${SHAREHOLDER}`); cast(`rpc anvil_setBalance ${SHAREHOLDER} 0x56BC75E2D63100000`);
  sh(`cast send ${MULTICALL} ${fixCalldata(amount, minOut)} --value ${amount} --from ${SHAREHOLDER} --unlocked --rpc-url ${RPC} > /dev/null`);
  s = state();
  check("USDC is now in the vault, and nothing was left behind in the multicall", s.b1 >= minOut && BigInt(first(cast(`call ${WHYPE} "balanceOf(address)(uint256)" ${MULTICALL}`))[0]) === 0n && BigInt(first(cast(`call ${USDC} "balanceOf(address)(uint256)" ${MULTICALL}`))[0]) === 0n, `${utils.formatUnits(s.b1.toString(), 6)} USDC, minimum ${utils.formatUnits(minOut.toString(), 6)}`);
  check("the money still belongs to the shareholder (owns all but 1,000 of the shares)", BigInt(first(cast(`call ${VAULT} "balanceOf(address)(uint256)" ${SHAREHOLDER}`))[0]) + 1000n === BigInt(first(cast(`call ${VAULT} "totalSupply()(uint256)"`))[0]));

  console.log("2. the bot's next run rebuilds the main range around the price");
  cast(`rpc anvil_impersonateAccount ${OWNER}`); cast(`rpc anvil_setBalance ${OWNER} 0x56BC75E2D63100000`);
  sh(`cast send ${VAULT} "setKeeper(address)" ${KEEPER} --from ${OWNER} --unlocked --rpc-url ${RPC} > /dev/null`); // test key stands in for the bot
  cast("rpc evm_mine");
  const r = await runKeeper({ ethers: { Wallet, utils }, fetch: fakeFetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEEPER_KEY })[k as "KEEPER_PRIVATE_KEY"] }, cfg);
  show(r);
  s = state();
  const inMain = s.tick >= s.main.lo && s.tick < s.main.hi;
  check("rebuilt: liquidity at the current price", r.vaults[0].action === "rebalance" && r.vaults[0].confirmed === true && s.main.l > 0n && inMain, `main [${s.main.lo}, ${s.main.hi}] around tick ${s.tick}, liquidity ${s.main.l}`);
  const mainShare = Number(first(cast(`call ${VAULT} "positionAmounts()(uint256,uint256)"`))[1]);
  console.log(`       after: HYPE ${utils.formatEther(s.b0.toString())}, USDC ${utils.formatUnits(s.b1.toString(), 6)}; alt [${s.alt.lo}, ${s.alt.hi}] liquidity ${s.alt.l}`);

  console.log("3. the bot then leaves it alone, and the shareholder can still take everything out");
  const r2 = await runKeeper({ ethers: { Wallet, utils }, fetch: fakeFetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEEPER_KEY })[k as "KEEPER_PRIVATE_KEY"] }, cfg);
  show(r2);
  check("no second move", r2.vaults[0].action !== "rebalance");
  const shares = first(cast(`call ${VAULT} "balanceOf(address)(uint256)" ${SHAREHOLDER}`))[0];
  const u0 = BigInt(first(cast(`call ${USDC} "balanceOf(address)(uint256)" ${SHAREHOLDER}`))[0]);
  sh(`cast send ${VAULT} "withdraw(uint256,uint256,uint256,address,bool)" ${shares} 0 0 ${SHAREHOLDER} true --from ${SHAREHOLDER} --unlocked --rpc-url ${RPC} > /dev/null`);
  const gotUsdc = BigInt(first(cast(`call ${USDC} "balanceOf(address)(uint256)" ${SHAREHOLDER}`))[0]) - u0;
  check("withdrawal returns both tokens", gotUsdc > 0n, `${utils.formatUnits(gotUsdc.toString(), 6)} USDC back, main held ${mainShare} USDC units`);
} finally {
  cast(`rpc evm_revert ${snap}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
