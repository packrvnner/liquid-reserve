// The vault job's collection rule with its REAL settings (fees worth 10 times the network fee, at most hourly),
// against the live HYPE-USDC vault on a LOCAL anvil fork of Elysium (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597, then: cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   npx tsx hosted/test-harvest-gate-fork.ts          (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runKeeper, CONFIG, Report } from "./core.js";

const RPC = "http://127.0.0.1:8597";
const PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1", Z = "0x0000000000000000000000000000000000000000";
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const V = CONFIG.vaults.find((v) => v.name === "HYPE-USDC")!.address;
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const send = (c: string) => sh(`cast send ${c} --private-key ${TKEY} --rpc-url ${RPC} > /dev/null`);
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const bal = (token: string, who: string) => BigInt(first(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`))[0]);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
// the fork reports a higher network fee than Elysium really has (0.5 gwei); the job is told the real figure
const realGas: typeof fetch = async (url: any, init?: any) => {
  if (String(url) === RPC && init?.body && JSON.parse(init.body).method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  return fetch(url, init);
};
const run = (env: Record<string, string> = {}) => runKeeper({ ethers: { Wallet, utils }, fetch: realGas, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY, ...env } as Record<string, string>)[k] }, { ...CONFIG, rpc: RPC, rpcGapMs: 0 });
const row = (r: Report, name = "HYPE-USDC") => r.vaults.find((v) => v.name === name)!;
const times = (reason: string) => Number(/(\d+) times the network fee/.exec(reason)?.[1] ?? NaN);

for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc evm_mine");
const out = sh(`forge create src/adapters/UniswapV4Swapper.sol:UniswapV4Swapper --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${TRADER} ${PM} ${WHYPE} 2>&1`);
const SWAP = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)![1];
const ROUTE = "setRoute(address,address,(uint8,(address,address,uint24,int24,address),bool,address)[])", key = `(${Z},${USDC},3000,60,${Z})`;
send(`${WHYPE} "deposit()" --value 60ether`);
send(`${WHYPE} "approve(address,uint256)" ${SWAP} $(cast max-uint)`);
send(`${USDC} "approve(address,uint256)" ${SWAP} $(cast max-uint)`);
send(`${SWAP} "${ROUTE}" ${WHYPE} ${USDC} "[(0,${key},true,${Z})]"`);
send(`${SWAP} "${ROUTE}" ${USDC} ${WHYPE} "[(0,${key},false,${Z})]"`);
const swap = (a: string, b: string, amt: bigint) => send(`${SWAP} "swap(address,address,uint256,uint256,address)" ${a} ${b} ${amt} 0 ${TRADER}`);
// The vault holds well under 1% of this pool's liquidity, so it earns that share of the pool's fees: the test
// trades are big (10 HYPE each way) to stand in for days of other people's trading.
const roundTrip = () => {
  const had = bal(USDC, TRADER);
  swap(WHYPE, USDC, 10n * 10n ** 18n);
  swap(USDC, WHYPE, bal(USDC, TRADER) - had);
};

console.log("1. the job's list and its decision right now");
let r = await run({ DRY_RUN: "1" });
for (const v of r.vaults) console.log(`       ${v.name}: ${v.action}, ${v.reason}`);
check("the job looks after exactly the four vaults in use", r.vaults.map((v) => v.name).join(",") === "HYPE-USDC,HYPE-KNTQ,HYPE-$liquid,wANTx-USDC");
check("it states the new rule", r.vaults.every((v) => !/compounding at/.test(v.reason) || /compounding at 10 times/.test(v.reason)));
const start = times(row(r).reason);

console.log("2. trading until the fees waiting pass 10 times the network fee");
let n = 0;
while (!/would compound/.test(row(r).reason) && n < 150) { for (let k = 0; k < 5; k++) roundTrip(); n += 5; r = await run({ DRY_RUN: "1" }); }
console.log(`       after ${n} more trades each way: ${row(r).reason}`);
const at = times(row(r).reason);
check("the job waited while the fees were under 10 times the network fee, and is ready once they pass it", /would compound/.test(row(r).reason) && at >= 10 && (isNaN(start) || start < 10 || n === 0), `from ${isNaN(start) ? "none" : start} to ${at} times`);
check("it is ready well before the old rule (50 times) would have let it", at < 50);

console.log("3. the real run");
const before = bal(WHYPE, "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c");
r = await run();
console.log(`       ${row(r).action}, ${row(r).reason}`);
check("the job collected the fees", row(r).action === "harvest" && row(r).confirmed === true);
check("the 20% cut reached the reserve's fee inbox", bal(WHYPE, "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c") > before);
check("the other vaults were left alone", r.vaults.filter((v) => v.name !== "HYPE-USDC").every((v) => v.action === "none"));
roundTrip();
r = await run();
console.log(`       straight after, with new fees waiting: ${row(r).action}, ${row(r).reason}`);
check("it does not collect the same vault again within the hour", row(r).action === "none" && /within the last hour/.test(row(r).reason));
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
