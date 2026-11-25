// Runs the bot's vault job against a self-balancing $liquid vault (LiquidityVaultV3) on a LOCAL anvil
// fork of Elysium (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   npx tsx hosted/test-v3-fork.ts
// $liquid has no outside market, so before moving a range the bot compares the vault's pool with
// Ascend's pool. The test vault has narrow ranges (±4%) so a small trade pushes it out of range.
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runKeeper, CONFIG, Config, Report } from "./core.js";

const RPC = "http://127.0.0.1:8597";
const PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1", WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
const LIQUID = "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6", LAUNCHPAD = "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC";
const OWN_POOL = "0x688b3a50572b1f0f738f15586acadfd9c3954379f0d6e49d5093d8d4f5382bc9";
const ASCEND_POOL = "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c";
const Z = "0x0000000000000000000000000000000000000000";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const send = (c: string, key = TKEY) => sh(`cast send ${c} --private-key ${key} --rpc-url ${RPC} > /dev/null`);
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const deploy = (contract: string, args: string) => {
  const out = sh(`forge create ${contract} --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${args} 2>&1`);
  return /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)![1];
};
const snap = cast("rpc evm_snapshot").replace(/"/g, "");
try {
  cast("rpc evm_mine");
  console.log("1. a narrow self-balancing vault on the 2% $liquid pool, swapping in Ascend's pool");
  const V = deploy("src/vaults/LiquidityVaultV3.sol:LiquidityVaultV3",
    `"((${Z},${LIQUID},20000,200,${Z}),${PM},${TRADER},${WHYPE},${TRADER},${KEEPER},test,test,2,2,0,(${LIQUID},${WHYPE},8388608,200,${LAUNCHPAD}),20000)"`);
  send(`${V} "deposit(uint256,uint256,uint256,address)" 1 100000000000000000 0 ${TRADER} --value 0.1ether`);
  const state = () => {
    const [, tick] = first(cast(`call ${V} "price()(uint160,int24)"`));
    const m = first(cast(`call ${V} "main()(int24,int24,uint128)"`));
    const [, at] = first(cast(`call 0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE "getSlot0(bytes32)(uint160,int24,uint24,uint24)" ${ASCEND_POOL}`));
    return { tick: +tick, lo: +m[0], hi: +m[1], l: BigInt(m[2]), ascendAsOurs: -Number(at) };
  };
  let s = state();
  check("opened balanced and earning", s.l > 0n && s.tick >= s.lo && s.tick < s.hi, `range [${s.lo}, ${s.hi}] around ${s.tick}; Ascend at ${s.ascendAsOurs}`);

  // a trader's swappers for the two pools
  const swapper = (key: string, zeroForOne: boolean) => {
    const a = deploy("src/adapters/UniswapV4Swapper.sol:UniswapV4Swapper", `${TRADER} ${PM} ${WHYPE}`);
    send(`${a} "setRoute(address,address,(uint8,(address,address,uint24,int24,address),bool,address)[])" ${WHYPE} ${LIQUID} "[(0,${key},${zeroForOne},${Z})]"`);
    send(`${WHYPE} "approve(address,uint256)" ${a} $(cast max-uint)`);
    return a;
  };
  send(`${WHYPE} "deposit()" --value 50ether`);
  const own = swapper(`(${Z},${LIQUID},20000,200,${Z})`, true);
  const asc = swapper(`(${LIQUID},${WHYPE},8388608,200,${LAUNCHPAD})`, false);
  const buy = (sw: string, wei: string) => send(`${sw} "swap(address,address,uint256,uint256,address)" ${WHYPE} ${LIQUID} ${wei} 0 ${TRADER}`);
  const settle = () => { for (let i = 0; i < 6; i++) { cast("rpc evm_increaseTime 130"); cast("rpc evm_mine"); } };
  const cfg: Config = { ...CONFIG, rpc: RPC, rpcGapMs: 0, vaults: [{ name: "test HYPE-$liquid", address: V, pool: OWN_POOL, dec0: 18, dec1: 18, swaps: true,
    refPool: { name: "Ascend's pool", pool: ASCEND_POOL, invert: true, bandPct: 5 } }] };
  const run = () => runKeeper({ ethers: { Wallet, utils }, fetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY })[k as "KEEPER_PRIVATE_KEY"] }, cfg);
  const show = (r: Report) => console.log(`       -> ${r.vaults.map((v) => `${v.action}, ${v.reason}${v.tx ? ` [${v.confirmed ? "confirmed" : "NOT confirmed"}]` : ""}`).join("; ")}`);

  console.log("2. someone buys $liquid in the vault's own pool only: it leaves the range, Ascend's price does not move");
  for (let i = 0; i < 60 && s.tick >= s.lo; i++) { buy(own, "5000000000000000"); s = state(); }
  check("out of range", s.tick < s.lo, `tick ${s.tick}, range [${s.lo}, ${s.hi}], Ascend ${s.ascendAsOurs}`);
  settle();
  let r = await run(); show(r);
  check("the bot refuses: the pool disagrees with Ascend's", r.vaults[0].action === "skip" && r.vaults[0].reason.includes("Ascend's pool"));

  console.log("3. the market follows in Ascend's pool too: the bot moves the range and the vault swaps in Ascend's pool");
  for (let i = 0; i < 60 && Math.abs(s.tick - s.ascendAsOurs) > 150; i++) { buy(asc, "200000000000000000"); s = state(); }
  check("prices agree again", Math.abs(s.tick - s.ascendAsOurs) <= 300, `ours ${s.tick}, Ascend ${s.ascendAsOurs}`);
  settle();
  r = await run(); show(r);
  s = state();
  check("moved and earning again", r.vaults[0].action === "rebalance" && r.vaults[0].confirmed === true && s.l > 0n && s.tick >= s.lo && s.tick < s.hi, `range [${s.lo}, ${s.hi}] around ${s.tick}`);
} finally {
  cast(`rpc evm_revert ${snap}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
