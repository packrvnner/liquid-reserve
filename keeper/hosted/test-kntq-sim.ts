// The bot's KNTQ staking job (kntq.ts) carrying real batches through the real contracts, with both chains played
// by ONE local anvil and the bridge by the test's BridgeSim (test/KntqStaking.t.sol). Never a real network:
//   anvil --port 8599 --silent        (a plain local chain, no fork)
//   npx tsx hosted/test-kntq-sim.ts   (from keeper/)
// What a local chain cannot show: the real bridge's outbox claim (the job's step 3a, the same code as the live
// HyperEVM job uses for the reserve's KNTQ) and the bridge tickets running by themselves.
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runKntq, KNTQ_CONFIG, KntqConfig, KntqState } from "./kntq.js";

const RPC = "http://127.0.0.1:8599";
const ROOT = `${process.cwd()}/..`;
const K = {
  owner: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
  bot: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"],
  alice: ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"],
  bob: ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"],
} as const;
const CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${ROOT}; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const send = (who: keyof typeof K, c: string) => sh(`cast send ${c} --private-key ${K[who][1]} --rpc-url ${RPC} > /dev/null`);
const deploy = (path: string, args = "") => /Deployed to: (0x[0-9a-fA-F]{40})/.exec(sh(`forge create ${path} --private-key ${K.owner[1]} --rpc-url ${RPC} --broadcast ${args ? `--constructor-args ${args}` : ""} 2>&1`))![1];
const num = (c: string) => BigInt(cast(c).split(/\s+/)[0]);
const bal = (token: string, who: string) => num(`call ${token} "balanceOf(address)(uint256)" ${who}`);
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const E = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const f = (v: bigint) => utils.formatUnits(v.toString(), 18);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

// ---------- the whole system on one local chain
cast(`rpc anvil_setCode 0xcA11bde05977b3631167028862bE2a173976CA11 ${sh("cast code 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url https://rpc.elysium.kinetiq.xyz")}`);
const kntqL1 = deploy("test/mocks/MockERC20.sol:MockERC20", "Kinetiq KNTQ 18");
const skntq = deploy("test/mocks/MockBridge.sol:MockSkntq", kntqL1);
const bridge = deploy("test/KntqStaking.t.sol:BridgeSim");
// Arbitrum's ticket precompile, standing in at its real address: a ticket exists while the bridge still holds a transfer home
const RETRYABLE = "0x000000000000000000000000000000000000006E";
cast(`rpc anvil_setCode ${RETRYABLE} ${cast(`code ${deploy("test/mocks/MockBridge.sol:MockArbRetryableTx")}`)}`);
cast(`rpc anvil_setStorageAt ${RETRYABLE} 0x0 0x${"0".repeat(24)}${bridge.slice(2)}`);
const rate = deploy("src/adapters/ERC4626RateProvider.sol:ERC4626RateProvider", skntq);
const Z = "0x0000000000000000000000000000000000000000";
const reserve = deploy("src/LockedReserve.sol:LockedReserve", `"[${skntq},${Z},${Z}]" "[${rate},${Z},${Z}]" ${K.owner[0]}`);
const lock = deploy("src/staking/KntqStakingVault.sol:SkntqLock", `${skntq} ${reserve}`);
const splitter = deploy("src/FeeSplitter.sol:FeeSplitter", `${CREATOR} 2000 ${lock}`);
const vault = deploy("src/staking/KntqVault.sol:KntqVault", `${K.owner[0]} ${skntq} ${splitter} ${E(5_000_000)}`);
const factory = deploy("src/staking/KntqStakeBridge.sol:KntqAgentFactory", `${vault} ${bridge} 300000 500000000`);
const agentImpl = cast(`call ${factory} "agentImpl()(address)"`);
send("owner", `${kntqL1} "mint(address,uint256)" ${K.owner[0]} ${E(1_000_000)}`);
send("owner", `${kntqL1} "approve(address,uint256)" ${bridge} ${E(1_000_000)}`);
for (const who of ["alice", "bob"] as const) send("owner", `${bridge} "seed(address,address,uint256)" ${kntqL1} ${K[who][0]} ${E(10_000)}`);
const kntq = cast(`call ${bridge} "calculateL2TokenAddress(address)(address)" ${kntqL1}`);
const queue = deploy("src/staking/KntqStakeQueue.sol:KntqStakeQueue", `"(${K.owner[0]},${kntq},${kntqL1},${vault},${bridge},${factory},${agentImpl},${E(500)},${E(500)})"`);
const share = cast(`call ${queue} "share()(address)"`);
send("owner", `${queue} "setKeeper(address)" ${K.bot[0]}`);
for (const who of ["alice", "bob"] as const) send(who, `${kntq} "approve(address,uint256)" ${queue} ${E(10_000)}`);

const cfg: KntqConfig = {
  ...KNTQ_CONFIG, skipOutbox: true, skipTicketReceipt: true,
  elysium: { ...KNTQ_CONFIG.elysium, rpc: RPC, chainId: 31337, queue, scanFromBlock: 0, rpcGapMs: 0 },
  hyperevm: { ...KNTQ_CONFIG.hyperevm, rpc: RPC, chainId: 31337, inbox: bridge, bridge, kntq: kntqL1, skntq, vault, agentFactory: factory, splitter, lock, rpcGapMs: 0 },
};
let state: KntqState | null = null;
const run = async (env: Record<string, string> = {}) => {
  const out = await runKntq({ ethers: { Wallet, utils }, fetch, env: (k) => ({ KEEPER_PRIVATE_KEY: K.bot[1], ...env } as Record<string, string>)[k], sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) }, state, cfg);
  state = out.state;
  const r = out.report;
  console.log(`       -> ${r.status}: ${r.reason}`);
  for (const a of r.actions) console.log(`          [${a.chain}] ${a.what.slice(0, 110)}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`);
  for (const b of r.batches) console.log(`          ${b.batch}: ${b.total}, ${b.state}`);
  return r;
};
const did = (r: any, re: RegExp) => r.actions.some((a: any) => re.test(a.what) && a.confirmed === true);

console.log("1. nothing deposited: the job has nothing to do");
let r = await run();
check("idle", r.status === "idle" && r.actions.length === 0);

console.log("2. a small deposit waits; a big enough batch is sent at once");
send("alice", `${queue} "deposit(uint256,address)" ${E(200)} ${K.alice[0]}`);
r = await run();
check("200 KNTQ is under the 500 minimum and has not waited: left to collect", r.actions.length === 0 && /collecting/.test(r.batches[0]?.state ?? ""));
send("bob", `${queue} "deposit(uint256,address)" ${E(800)} ${K.bob[0]}`);
r = await run();
check("1,000 KNTQ is sent over the bridge", did(r, /^send deposit batch 0/) && bal(kntq, queue) === 0n);

console.log("3. it arrives on HyperEVM: staked, and the liquidKNTQ is sent home");
r = await run();
check("until it lands on HyperEVM the job waits", !r.actions.length && r.status === "waiting", r.batches[0]?.state);
send("owner", `${bridge} "arriveOnHyperEvm()"`);
r = await run();
check("the batch's agent is opened and stakes", did(r, /^open the agent of deposit 0/) && did(r, /^stake 1000\.0 KNTQ of deposit 0/));
check("the vault holds the sKNTQ", bal(skntq, vault) === BigInt(E(1000)));

console.log("4. the liquidKNTQ arrives on Elysium and is paid to each depositor");
send("owner", `${bridge} "arriveOnElysium()"`);
r = await run();
check("both depositors are paid by the bot", did(r, /^pay 0x3c44cd/) && did(r, /^pay 0x90f79b/));
check("alice has 200 liquidKNTQ, bob 800", bal(share, K.alice[0]) === BigInt(E(200)) && bal(share, K.bob[0]) === BigInt(E(800)), `${f(bal(share, K.alice[0]))} / ${f(bal(share, K.bob[0]))}`);
r = await run();
r = await run();
check("then the batch is finished and the job is idle again", r.status === "idle" && r.actions.length === 0 && state!.batches["1:0"].done === true);
check("its bridge ticket home was seen to have run by itself", state!.batches["1:0"].homeTxs?.length === 1 && state!.batches["1:0"].homeSettled?.length === 1);

console.log("5. a small batch that has waited long enough is sent by the bot as the queue's keeper");
send("alice", `${queue} "deposit(uint256,address)" ${E(100)} ${K.alice[0]}`);
r = await run();
check("not yet", r.actions.length === 0);
warp(6 * 3600 + 60);
r = await run();
check("after six hours it goes", did(r, /^send deposit batch 1/));
send("owner", `${bridge} "arriveOnHyperEvm()"`);
r = await run();
send("owner", `${bridge} "arriveOnElysium()"`);
r = await run();
// (the vault's first deposit locked 1,000 wei of shares for good, so later deposits get a hair more per sKNTQ)
check("and alice is paid", bal(share, K.alice[0]) - BigInt(E(300)) < 1000n && bal(share, K.alice[0]) >= BigInt(E(300)), `${f(bal(share, K.alice[0]))} liquidKNTQ`);

console.log("6. yield comes in: the fee is collected, split, and the reserve's part locked");
warp(200 * 86400); // long enough that all of a 10% rise counts under the vault's 25%-a-year ceiling
send("owner", `${kntqL1} "mint(address,uint256)" ${skntq} ${E(110)}`); // sKNTQ gains 10%: 110 KNTQ of yield on 1,100
r = await run();
const feeToCreator = bal(skntq, CREATOR), locked = bal(skntq, reserve);
check("fee collected, split and locked", did(r, /^collect .* sKNTQ of staking fee/) && did(r, /^split the fee/) && did(r, /^lock the reserve's part/));
const rateNow = Number(num(`call ${skntq} "convertToAssets(uint256)(uint256)" 1000000000000000000`)) / 1e18;
check("the fee is 20% of the 110 KNTQ of yield", Math.abs((Number(feeToCreator + locked) / 1e18) * rateNow - 22) < 0.01, `${((Number(feeToCreator + locked) / 1e18) * rateNow).toFixed(4)} KNTQ worth`);
check("20% of it to the creator's wallet, 80% locked in the reserve", feeToCreator * 4n === locked || (feeToCreator * 4n - locked < 5n && locked - feeToCreator * 4n < 5n), `${f(feeToCreator)} / ${f(locked)} sKNTQ`);

console.log("7. bob leaves: his liquidKNTQ goes back, Kinetiq's 7 days pass, his KNTQ comes home");
send("bob", `${share} "approve(address,uint256)" ${queue} ${E(800)}`);
send("bob", `${queue} "requestExit(uint256,address)" ${E(800)} ${K.bob[0]}`);
r = await run();
check("the exit batch is sent", did(r, /^send exit batch 0/) && bal(share, K.bob[0]) === 0n);
send("owner", `${bridge} "arriveOnHyperEvm()"`);
r = await run();
check("its agent starts the 7-day withdrawal", did(r, /^start unstaking exit 0/));
r = await run();
check("during the 7 days the job waits and says so", !r.actions.length && /unstaking at Kinetiq/.test(r.batches.find((b: any) => b.batch === "exit 0")?.state ?? ""), r.batches.find((b: any) => b.batch === "exit 0")?.state);
warp(7 * 86400 + 60);
const before = bal(kntq, K.bob[0]);
r = await run();
check("after 7 days it collects the KNTQ and sends it home", did(r, /^collect exit 0's KNTQ/));
send("owner", `${bridge} "arriveOnElysium()"`);
r = await run();
const got = bal(kntq, K.bob[0]) - before;
check("bob is paid his KNTQ: his 800 and 80% of his share of the yield", did(r, /^pay 0x90f79b/) && got > BigInt(E(863)) && got < BigInt(E(865)), `${f(got)} KNTQ`);
r = await run();
r = await run();
check("everything finished; nothing left in the queue for anyone", r.status === "idle" && Object.values(state!.batches).every((b) => b.done), `queue holds ${f(bal(kntq, queue))} KNTQ, ${f(bal(share, queue))} liquidKNTQ`);

console.log("8. without a wallet, or in a dry run, the job only reports");
send("alice", `${queue} "deposit(uint256,address)" ${E(600)} ${K.alice[0]}`);
const q0 = bal(kntq, queue);
state = { ...state!, batches: { ...state!.batches } };
const saved = JSON.stringify(state);
r = await run({ KEEPER_PRIVATE_KEY: "" });
check("no wallet: it says what is ready and sends nothing", r.mode === "watch-only" && r.actions.some((a: any) => /no keeper wallet/.test(a.note ?? "")) && bal(kntq, queue) === q0);
state = JSON.parse(saved);
r = await run({ DRY_RUN: "1" });
check("dry run: the same", r.mode === "dry-run" && r.actions.some((a: any) => /dry run/.test(a.note ?? "")) && bal(kntq, queue) === q0);
state = JSON.parse(saved);
r = await run({ KNTQ_PAUSED: "1" });
check("paused: nothing at all", r.status === "paused" && r.actions.length === 0);

console.log("9. a bridge ticket home that does not run by itself is run by the bot");
state = JSON.parse(saved);
r = await run();
check("the 600 KNTQ batch is sent", did(r, /^send deposit batch 2/));
send("owner", `${bridge} "arriveOnHyperEvm()"`);
r = await run();
check("staked, and the liquidKNTQ is sent home", did(r, /^stake 600\.0 KNTQ of deposit 2/) && state!.batches["1:2"].homeTxs?.length === 1);
const aliceBefore = bal(share, K.alice[0]);
r = await run(); // the ticket has not run (nobody delivered it), but it is only seconds old
check("a fresh ticket is left alone", r.actions.length === 0 && /on its way home/.test(r.batches.find((b: any) => b.batch === "deposit 2")?.state ?? "") && !r.warnings.length, r.batches.find((b: any) => b.batch === "deposit 2")?.state);
check("nothing has reached alice yet", bal(share, K.alice[0]) === aliceBefore && num(`call ${bridge} "pendingToElysium()(uint256)"`) === 1n);
warp(21 * 60);
r = await run();
check("after 20 minutes the bot runs the ticket itself", did(r, /^run the bridge ticket that carries deposit 2 home/) && r.warnings.some((w: string) => /did not run by itself/.test(w)), r.warnings[0]);
check("and pays alice in the same run", did(r, /^pay 0x3c44cd/) && bal(share, K.alice[0]) > aliceBefore, `+${f(bal(share, K.alice[0]) - aliceBefore)} liquidKNTQ`);
r = await run();
r = await run();
check("then that batch is finished too, with its ticket settled", state!.batches["1:2"].done === true && state!.batches["1:2"].homeSettled?.length === 1 && r.actions.length === 0 && !r.warnings.length);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
