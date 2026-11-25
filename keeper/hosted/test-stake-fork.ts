// The HYPE staking vault's fee, from the vault to the creator's wallet and the reserve, moved by the bot's real jobs
// on a LOCAL anvil fork of Elysium (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597, then: cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   python3 script/stake-data.py --local      (and create the vault once, e.g. through site/tools/stake-launch.html
//                                              with ?data=stake-data.local.json&devwallet=1; this test creates it if missing)
//   npx tsx hosted/test-stake-fork.ts         (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runShare, SHARE_CONFIG } from "./share.js";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";
import { runCreator, CREATOR_CONFIG } from "./creator.js";

const RPC = "http://127.0.0.1:8597";
const D = JSON.parse(readFileSync(`${process.cwd()}/../site/tools/stake-data.local.json`, "utf8"));
const scfg = { ...SHARE_CONFIG, rpc: RPC, rpcGapMs: 0 };
const rcfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const ccfg = { ...CREATOR_CONFIG, rpc: RPC, rpcGapMs: 0 };
const V = D.vault as string, KH = rcfg.tokens.KHYPE, SPLIT = scfg.vaultFeeSplit, CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37";
const TL = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", STAKER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const as = (who: string, c: string) => sh(`cast send ${c} --from ${who} --unlocked --rpc-url ${RPC} > /dev/null`);
const send = (c: string) => sh(`cast send ${c} --private-key ${SKEY} --rpc-url ${RPC} > /dev/null`);
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const num = (c: string) => BigInt(first(cast(c))[0]);
const bal = (token: string, who: string) => num(`call ${token} "balanceOf(address)(uint256)" ${who}`);
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const realGas: typeof fetch = async (url: any, init?: any) => {
  if (String(url) === RPC && init?.body && JSON.parse(init.body).method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: realGas, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
const acts = (r: any) => r.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ") || "no actions";
const share = async () => { const r = await runShare(deps, scfg); console.log(`       share job -> ${r.status}: ${r.reason}\n          ${acts(r)}`); return r; };
const did = (r: any, re: RegExp) => r.actions.some((a: any) => re.test(a.what) && a.confirmed === true);
/** Stands in for staking rewards: moves the vault's high-water mark `bps` hundredths of a percent below the rate
 *  now, dated 90 days back (so the vault's 5%-a-year ceiling leaves room), so that much yield shows as new. (Fork only: writes the vault's storage.) */
function addYield(bps: number) {
  const rate = num(`call ${V} "currentRate()(uint256)"`), now = Number(first(cast("block latest --field timestamp"))[0]);
  const mark = (rate * BigInt(1_000_000 - bps * 100)) / 1_000_000n;
  const word = (BigInt(now - 90 * 86400) << 192n) | mark;
  cast(`rpc anvil_setStorageAt ${V} 0x8 0x${word.toString(16).padStart(64, "0")}`);
  cast("rpc evm_mine");
}

// ---------- setup (fork only)
for (const a of [BOT, STAKER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x3635C9ADC5DEA00000`); }
cast(`rpc anvil_impersonateAccount ${TL}`); cast(`rpc anvil_setBalance ${TL} 0x56BC75E2D63100000`);
cast("rpc evm_mine");
as(TL, `${rcfg.oracle} "setKeeper(address,bool)" ${BOT} true`); // the test key stands in for the bot as price reader
if (cast(`code ${V}`) === "0x") { send(`${D.to} ${D.data}`); console.log("  (created the staking vault from the launch data)"); }

console.log("1. the vault as launched");
check("its fee address is the 20/80 splitter, for good", cast(`call ${V} "feeRecipient()(address)"`).toLowerCase() === SPLIT.toLowerCase());
check("the splitter pays 20% to the creator's wallet", cast(`call ${SPLIT} "recipientA()(address)"`).toLowerCase() === CREATOR.toLowerCase());
check("the fee is 20% of yield", num(`call ${V} "FEE_BPS()(uint256)"`) === 2000n);
let r = await share();
check("with no fee waiting the bot leaves the vault alone", !r.actions.some((a: any) => /staking fee/.test(a.what)) && "staking fee kHYPE" in (r.holding ?? {}));

console.log("2. someone stakes 60 HYPE, and a small amount of yield comes in");
send(`${V} "depositHype(uint256,address)" 0 ${STAKER} --value 60ether --gas-limit 700000`);
const shares = bal(V, STAKER), held0 = bal(KH, V);
check("the staker holds liquidHYPE", shares > 0n, `${f(shares)} liquidHYPE for 60 HYPE`);
addYield(10); // 0.10% of yield
const fee1 = num(`call ${V} "pendingFees()(uint256)"`);
const expect1 = (((held0 * 1000n) / 1_000_000n) * 2000n) / 10000n;
check("the vault shows 20% of that yield as its fee", fee1 > (expect1 * 99n) / 100n && fee1 < (expect1 * 101n) / 100n, `${f(fee1)} kHYPE on ${f(held0)} kHYPE staked`);
check("it is a small fee: under the bot's collect-at-once level, over its minimum", fee1 < BigInt(utils.parseEther(scfg.staking!.token.min).toString()) && fee1 >= BigInt(utils.parseEther(scfg.staking!.token.dust).toString()));

console.log("3. the bot collects it and pays it out: 20% to the creator's wallet, 80% to the reserve's fee inbox");
let c0 = bal(KH, CREATOR), i0 = bal(KH, rcfg.feeInbox);
r = await share();
let toCreator = bal(KH, CREATOR) - c0, toInbox = bal(KH, rcfg.feeInbox) - i0;
check("the fee was collected from the vault", did(r, /^collect .* staking fee/) && num(`call ${V} "pendingFees()(uint256)"`) === 0n);
check("and paid out in the same run", did(r, /^pay out .* kHYPE of vault fees/) && bal(KH, SPLIT) === 0n);
check("the creator's wallet received 20% of it", toCreator === (fee1 * 2000n) / 10000n || toCreator === fee1 - (fee1 * 8000n) / 10000n, `+${f(toCreator)} kHYPE`);
check("the fee inbox received the other 80%", toCreator + toInbox === fee1, `+${f(toInbox)} kHYPE`);
check("the staker's liquidHYPE is untouched", bal(V, STAKER) === shares);

console.log("4. more small yield the same day waits; a day later it is collected");
addYield(4);
const fee2 = num(`call ${V} "pendingFees()(uint256)"`);
r = await share();
check("a second small fee within a day is left to build up", !r.actions.some((a: any) => /staking fee/.test(a.what)) && num(`call ${V} "pendingFees()(uint256)"`) === fee2, `${f(fee2)} kHYPE waiting`);
warp(86_400 + 60);
c0 = bal(KH, CREATOR);
r = await share();
check("after a day it is collected and paid out", did(r, /^collect .* staking fee/) && bal(KH, CREATOR) > c0 && bal(KH, SPLIT) === 0n, `creator +${f(bal(KH, CREATOR) - c0)} kHYPE`);

console.log("5. a larger fee is collected at once, without waiting for the day to pass");
addYield(40);
const fee3 = num(`call ${V} "pendingFees()(uint256)"`);
c0 = bal(KH, CREATOR);
r = await share();
check("collected and paid out straight away", fee3 >= BigInt(utils.parseEther(scfg.staking!.token.min).toString()) && did(r, /^collect .* staking fee/) && bal(KH, CREATOR) - c0 >= (fee3 * 1999n) / 10000n, `${f(fee3)} kHYPE fee, creator +${f(bal(KH, CREATOR) - c0)}`);

console.log("6. the reserve's 80%: the bot's reserve job locks part as kHYPE and buys KNTQ and USDC with the rest");
const inboxKh = bal(KH, rcfg.feeInbox);
const p0 = { khype: bal(KH, rcfg.reserve), kntq: bal(rcfg.tokens.KNTQ, rcfg.bridgeOut), usdc: bal(rcfg.tokens.USDC, rcfg.liquidWait), cw: bal(KH, rcfg.creatorWait) };
let rr = await runReserve(deps, rcfg);
const seen: any[] = [...rr.actions];
console.log(`       reserve job 1 -> ${rr.status}: ${rr.reason}`);
for (let k = 2; k <= 9 && !(rr.status === "moving" && bal(KH, rcfg.feeInbox) === 0n); k++) { warp(600); rr = await runReserve(deps, rcfg); seen.push(...rr.actions); console.log(`       reserve job ${k} -> ${rr.status}: ${rr.reason}`); }
console.log(`          ${acts(rr)}`);
// other fees that happened to be waiting on the real network when the copy was made would add to what gets locked
const others = seen.some((a: any) => /^buy and lock with [\d.]+ (WHYPE|USDC|KNTQ|\$liquid)/.test(a.what) && a.confirmed);
const p1 = { khype: bal(KH, rcfg.reserve), kntq: bal(rcfg.tokens.KNTQ, rcfg.bridgeOut), usdc: bal(rcfg.tokens.USDC, rcfg.liquidWait), cw: bal(KH, rcfg.creatorWait) };
check("the job counts kHYPE among the fees it moves", "KHYPE" in (rr.waiting ?? {}));
check("the fee inbox was emptied of kHYPE", bal(KH, rcfg.feeInbox) === 0n && bal(KH, rcfg.allocator) === 0n, `${f(inboxKh)} -> 0`);
const toAlloc = (inboxKh * 8000n) / 10000n;
check("40% of what reached the allocator was locked as kHYPE, as it is", p1.khype - p0.khype >= (toAlloc * 3990n) / 10000n && (others || p1.khype - p0.khype <= (toAlloc * 4010n) / 10000n), `+${f(p1.khype - p0.khype)} kHYPE locked of ${f(toAlloc)}${others ? "; other waiting fees moved in the same runs" : ""}`);
check("KNTQ was bought and sent on to be staked", p1.kntq > p0.kntq, `+${f(p1.kntq - p0.kntq)} KNTQ`);
check("USDC was parked", p1.usdc > p0.usdc, `+${f(p1.usdc - p0.usdc, 6)} USDC`);
const px = rr.prices!, khUsd = px.hypeUsd * Number(num(`call ${D.rateProvider} "getRate()(uint256)"`)) / 1e18;
const usdIn = (Number(toAlloc) / 1e18) * khUsd, usdOut = (Number(p1.khype - p0.khype) / 1e18) * khUsd + (Number(p1.kntq - p0.kntq) / 1e18) * px.kntqUsd + Number(p1.usdc - p0.usdc) / 1e6;
check("little is lost on the way (pool fees only)", others || (usdOut / usdIn > 0.985 && usdOut / usdIn < 1.01), `$${usdIn.toFixed(3)} in, $${usdOut.toFixed(3)} locked or sent on: ${((1 - usdOut / usdIn) * 100).toFixed(2)}% cost`);
check("the older splitter set 20% aside in the creator's waiting contract (it goes to the reserve too)", p1.cw - p0.cw === inboxKh - toAlloc, `${f(p1.cw - p0.cw)} kHYPE`);

console.log("7. that set-aside part is passed on and locked once enough has collected");
let cr = await runCreator(deps, ccfg);
console.log(`       creator job -> ${cr.status}: ${cr.reason}`);
check("the creator job knows kHYPE", "kHYPE" in (cr.waiting ?? {}));
// top the waiting contract up over the job's minimum with kHYPE taken from the staker's own unstake
send(`${V} "redeem(uint256,address,address)" ${utils.parseEther("1").toString()} ${rcfg.creatorWait} ${STAKER}`);
cr = await runCreator(deps, ccfg);
console.log(`       creator job -> ${cr.status}: ${cr.reason}`);
check("it passes the kHYPE on to the allocator", bal(KH, rcfg.creatorWait) === 0n && bal(KH, rcfg.allocator) > 0n, `${f(bal(KH, rcfg.allocator))} kHYPE at the allocator`);
const k0 = bal(KH, rcfg.reserve);
rr = await runReserve(deps, rcfg);
for (let k = 2; k <= 6 && bal(KH, rcfg.allocator) > 0n; k++) { warp(600); rr = await runReserve(deps, rcfg); }
console.log(`       reserve job -> ${rr.status}: ${rr.reason}`);
check("and the reserve job locks it", bal(KH, rcfg.allocator) === 0n && bal(KH, rcfg.reserve) > k0, `+${f(bal(KH, rcfg.reserve) - k0)} kHYPE locked`);

console.log("8. the staker leaves with everything that is theirs");
const left = bal(V, STAKER), kb = bal(KH, STAKER), owed = num(`call ${V} "previewRedeem(uint256)(uint256)" ${left}`);
send(`${V} "redeem(uint256,address,address)" ${left} ${STAKER} ${STAKER}`);
check("a full unstake to kHYPE pays out exactly what the vault quoted", bal(KH, STAKER) - kb === owed && bal(V, STAKER) === 0n, `${f(owed)} kHYPE for ${f(left)} liquidHYPE`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
