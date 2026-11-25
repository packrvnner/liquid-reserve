// With the lowered threshold, does the fee really waiting on mainnet (about $0.70) get moved into the reserve?
// Runs the reserve job on a LOCAL anvil fork (port 8597) until the cycle completes.
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";

const RPC = "http://127.0.0.1:8597";
const cfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T = cfg.tokens;
const bal = (token: string, who: string) => BigInt(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`).split(/\s+/)[0]);
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
// the test wallet stands in for the bot as the oracle's keeper
const owner = cast(`call ${cfg.oracle} "owner()(address)"`);
cast(`rpc anvil_impersonateAccount ${owner}`); cast(`rpc anvil_setBalance ${owner} 0x56BC75E2D63100000`);
sh(`cast send ${cfg.oracle} "setKeeper(address,bool)" ${ME} true --from ${owner} --unlocked --rpc-url ${RPC} > /dev/null`);
// Hyperliquid's real prices are used for the outside check, as on mainnet
// The fork reports a higher network fee than Elysium really has (0.5 gwei), which would move the threshold; the
// bot is told the real figure.
const realGas: typeof fetch = async (url: any, init?: any) => {
  if (String(url) === RPC && init?.body && JSON.parse(init.body).method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  return fetch(url, init);
};
const run = () => runReserve({ ethers: { Wallet, utils }, fetch: realGas, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] }, cfg);
const before = { inbox: bal(T.WHYPE, cfg.feeInbox), khype: bal(T.KHYPE, cfg.reserve), kntq: bal(T.KNTQ, cfg.bridgeOut), usdc: bal(T.USDC, cfg.liquidWait), cw: bal(T.WHYPE, cfg.creatorWait) };
console.log(`oracle owner ${owner} | waiting in the fee inbox: ${utils.formatEther(before.inbox.toString())} WHYPE`);
let r = await run();
console.log(`run 1 -> ${r.status}: ${r.reason} (needs $${r.neededUsd?.toFixed(2)}, waiting $${r.waitingUsd?.toFixed(2)})`);
for (let i = 2; i <= 8 && r.status !== "moving"; i++) {
  warp(600);
  r = await run();
  console.log(`run ${i} -> ${r.status}: ${r.reason} | ${r.actions.map((a) => `${a.what.slice(0, 60)}${a.confirmed ? " [ok]" : a.note ? ` [${a.note.slice(0, 60)}]` : ""}`).join("; ")}`);
}
const after = { inbox: bal(T.WHYPE, cfg.feeInbox), khype: bal(T.KHYPE, cfg.reserve), kntq: bal(T.KNTQ, cfg.bridgeOut), usdc: bal(T.USDC, cfg.liquidWait), cw: bal(T.WHYPE, cfg.creatorWait) };
const ok = r.status === "moving" && after.inbox === 0n && after.khype > before.khype && after.kntq > before.kntq && after.usdc > before.usdc;
console.log(`moved: fee inbox ${utils.formatEther(before.inbox.toString())} -> ${utils.formatEther(after.inbox.toString())} WHYPE | kHYPE locked +${utils.formatEther((after.khype - before.khype).toString())} | KNTQ at bridge +${utils.formatEther((after.kntq - before.kntq).toString())} | USDC parked +${utils.formatUnits((after.usdc - before.usdc).toString(), 6)} | creator share waiting +${utils.formatEther((after.cw - before.cw).toString())} WHYPE`);
console.log(ok ? "\nPASS: the waiting fees were bought and locked" : "\nFAIL");
process.exit(ok ? 0 : 1);
