// Rehearsal of the creator-share setup (script/creator-share-data.py) on a LOCAL anvil fork of Elysium
// mainnet as it is now (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597   then   cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   python3 script/creator-share-data.py --local
//   npx tsx hosted/test-creator-share-fork.ts
import { execSync } from "node:child_process";
import fs from "node:fs";

const RPC = "http://127.0.0.1:8597";
const D = JSON.parse(fs.readFileSync(new URL("../../site/tools/creator-share-data.local.json", import.meta.url), "utf8"));
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const tryCast = (c: string) => { try { cast(c); return true; } catch { return false; } };
const first = (s: string) => s.split(/\s+/)[0];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const balOf = (token: string, who: string) => BigInt(first(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`)));
const code = (a: string) => cast(`code ${a}`);
const warp = (secs: number) => { cast(`rpc evm_increaseTime ${secs}`); cast("rpc evm_mine"); };
const ACCT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1, a stranger
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0", KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0";
const LIVE_SPLITTER = "0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e", LIVE_INBOX = "0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
/** Puts `amount` of a token at `who` on the fork by writing its balance slot. */
function give(token: string, who: string, amount: bigint) {
  for (const s of ["0", "1", "2", "3", "51", "101", "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"]) {
    const key = sh(`cast index address ${who} ${s}`);
    const before = cast(`storage ${token} ${key}`);
    cast(`rpc anvil_setStorageAt ${token} ${key} 0x${amount.toString(16).padStart(64, "0")}`);
    if (balOf(token, who) === amount) return;
    cast(`rpc anvil_setStorageAt ${token} ${key} ${before}`);
  }
  throw new Error(`could not hand out ${token} on the fork`);
}
const asOwner = (to: string, data: string) => sh(`cast send ${to} ${data} --from ${D.owner} --unlocked --rpc-url ${RPC} > /dev/null`);
cast(`rpc anvil_impersonateAccount ${D.owner}`); cast(`rpc anvil_setBalance ${D.owner} 0x56BC75E2D63100000`);

console.log("1. before anything is sent");
check("the three addresses are empty", [D.yieldRest, D.yieldSplit, D.vaultFeeSplit].every((a) => code(a) === "0x"));
check("the yield contract points nowhere yet", /^0x0{40}$/.test(first(cast(`call ${D.yieldWait} "target()(address)"`))));
check("the owner cannot point the yield contract directly (only the timelock can)", !tryCast(`call ${D.yieldWait} "setTarget(address)" ${D.yieldSplit} --from ${D.owner}`));
check("the timelock step cannot be run before it is scheduled", !tryCast(`call ${D.timelock} ${D.execute} --from ${D.owner}`));

console.log("2. create the three contracts (one transaction, from any wallet)");
sh(`cast send ${D.multicall} ${D.deploy} --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
check("all three exist at the addresses worked out in advance", [D.yieldRest, D.yieldSplit, D.vaultFeeSplit].every((a) => code(a).length > 2));
const tail = (c: string) => c.slice(-106); // the compiler's fingerprint of the source
check("same code as the splitter already live", tail(code(D.yieldSplit)) === tail(code(LIVE_SPLITTER)) && code(D.yieldSplit).length === code(LIVE_SPLITTER).length);
check("same code as the holding contracts already live", tail(code(D.yieldRest)) === tail(code(LIVE_INBOX)) && code(D.yieldRest).length === code(LIVE_INBOX).length);
const view = (a: string, f: string, t = "address") => first(cast(`call ${a} "${f}()(${t})"`));
check("YieldSplit: 20% to your wallet, the rest to YieldRest, fixed", same(view(D.yieldSplit, "recipientA"), D.creator) && view(D.yieldSplit, "bpsA", "uint16") === "2000" && same(view(D.yieldSplit, "recipientB"), D.yieldRest));
check("VaultFeeSplit: 20% to your wallet, the rest to the reserve's fee inbox, fixed", same(view(D.vaultFeeSplit, "recipientA"), D.creator) && view(D.vaultFeeSplit, "bpsA", "uint16") === "2000" && same(view(D.vaultFeeSplit, "recipientB"), D.vaultFeeInbox));
check("YieldRest: only the timelock can point it, and it points nowhere yet", same(view(D.yieldRest, "setter"), D.timelock) && /^0x0{40}$/.test(view(D.yieldRest, "target")));
check("sending it twice fails instead of doing anything", !tryCast(`call ${D.multicall} ${D.deploy} --from ${ACCT}`));

console.log("3. vault fees through VaultFeeSplit");
sh(`cast send ${WHYPE} "deposit()" --value 1ether --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
sh(`cast send ${WHYPE} "transfer(address,uint256)" ${D.vaultFeeSplit} 1000000000000000000 --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
let c0 = balOf(WHYPE, D.creator), i0 = balOf(WHYPE, D.vaultFeeInbox);
sh(`cast send ${D.vaultFeeSplit} "distribute(address)" ${WHYPE} --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
check("of 1 HYPE of vault fees: 0.2 to your wallet", balOf(WHYPE, D.creator) - c0 === 2n * 10n ** 17n);
check("and 0.8 to the reserve's fee inbox", balOf(WHYPE, D.vaultFeeInbox) - i0 === 8n * 10n ** 17n && balOf(WHYPE, D.vaultFeeSplit) === 0n);

console.log("4. the timelock: schedule, wait 48 hours, execute");
check("a stranger cannot schedule it", !tryCast(`call ${D.timelock} ${D.schedule} --from ${ACCT}`));
asOwner(D.timelock, D.schedule);
const readyAt = BigInt(first(cast(`call ${D.timelock} "getTimestamp(bytes32)(uint256)" ${D.id}`)));
const now = BigInt(first(cast("block latest --field timestamp")));
check("scheduled, ready in 48 hours", readyAt - now > 172_000n && readyAt - now <= 172_800n, `${readyAt - now} s`);
check("cannot be executed early", !tryCast(`call ${D.timelock} ${D.execute} --from ${D.owner}`));
warp(47 * 3600);
check("still not after 47 hours", !tryCast(`call ${D.timelock} ${D.execute} --from ${D.owner}`));
warp(3600 + 60);
asOwner(D.timelock, D.execute);
check("the yield contract now points at YieldSplit", same(first(cast(`call ${D.yieldWait} "target()(address)"`)), D.yieldSplit));
check("and can never be pointed anywhere else", !tryCast(`call ${D.yieldWait} "setTarget(address)" ${D.vaultFeeSplit} --from ${D.timelock}`));

console.log("5. reserve yield through YieldSplit (kHYPE from Elysium, KNTQ arriving from HyperEVM)");
for (const [sym, token] of [["kHYPE", KHYPE], ["KNTQ", KNTQ]] as const) {
  give(token, D.yieldWait, 10n ** 18n);
  c0 = balOf(token, D.creator);
  const r0 = balOf(token, D.yieldRest);
  sh(`cast send ${D.yieldWait} "forward(address)" ${token} --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
  sh(`cast send ${D.yieldSplit} "distribute(address)" ${token} --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
  check(`of 1 ${sym} of yield: 0.2 to your wallet, 0.8 held for the rest of the yield plan`, balOf(token, D.creator) - c0 === 2n * 10n ** 17n && balOf(token, D.yieldRest) - r0 === 8n * 10n ** 17n && balOf(token, D.yieldWait) === 0n && balOf(token, D.yieldSplit) === 0n);
}
check("the held 80% cannot be moved until the timelock points it somewhere", !tryCast(`call ${D.yieldRest} "forward(address)" ${KHYPE} --from ${ACCT}`) && !tryCast(`call ${D.yieldRest} "setTarget(address)" ${D.creator} --from ${D.owner}`));
check("the locked reserve itself was not touched", balOf(KHYPE, "0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61") > 0n);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
