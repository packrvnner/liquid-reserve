// Runs the bot's treasury job against LOCAL anvil forks (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   anvil --fork-url https://rpc.hyperliquid.xyz/evm --port 8598
//   npx tsx hosted/test-treasury-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runTreasury, TREASURY_CONFIG, TreasuryConfig, TreasuryReport } from "./treasury.js";

const ER = "http://127.0.0.1:8597", HR = "http://127.0.0.1:8598";
const cfg: TreasuryConfig = { ...TREASURY_CONFIG, elysium: { ...TREASURY_CONFIG.elysium, rpc: ER, rpcGapMs: 0 }, hyperevm: { ...TREASURY_CONFIG.hyperevm, rpc: HR, rpcGapMs: 0 } };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
const BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const POOL_MANAGER = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1"; // holds KNTQ on Elysium
const GATEWAY = "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c"; // holds KNTQ on HyperEVM
const [WHYPE, , KNTQ] = cfg.elysium.tokens.map((t) => t.address);
const balOf = (rpc: string, token: string, who: string) => BigInt(sh(`cast call ${token} "balanceOf(address)(uint256)" ${who} --rpc-url ${rpc}`).split(" ")[0]);
const fuel = (rpc: string) => BigInt(sh(`cast balance ${BOT} --rpc-url ${rpc}`));
const setFuel = (rpc: string, hype: string) => sh(`cast rpc anvil_setBalance ${BOT} $(cast to-hex $(cast to-wei ${hype})) --rpc-url ${rpc}`);
const give = (rpc: string, token: string, from: string, amount: string) => {
  sh(`cast rpc anvil_impersonateAccount ${from} --rpc-url ${rpc}`); sh(`cast rpc anvil_setBalance ${from} 0x56BC75E2D63100000 --rpc-url ${rpc}`);
  sh(`cast send ${token} "transfer(address,uint256)" ${BOT} $(cast to-wei ${amount}) --from ${from} --unlocked --rpc-url ${rpc} > /dev/null`);
};
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: TreasuryReport) => console.log(`       -> ${r.status}: ${r.reason}${r.actions.length ? "\n          " + r.actions.map((a) => `${a.what}${a.note ? ` [${a.note}]` : a.confirmed ? " [confirmed]" : " [NOT confirmed]"}`).join("\n          ") : ""}${r.warnings.length ? "\n          warnings: " + r.warnings.join("; ") : ""}`);
const run = async (env: Record<string, string> = {}, inFlight = false) => { const o = await runTreasury({ ethers: { Wallet, utils }, fetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY, ...env })[k] }, inFlight, cfg); show(o.report); return o; };
const near = (a: bigint, b: bigint, tol = 10n ** 15n) => (a > b ? a - b : b - a) <= tol;
const E18 = 10n ** 18n;

setFuel(ER, "0.5"); setFuel(HR, "0.5");
// ArbSys (0x64) does not exist on a plain EVM fork; a stand-in lets the withdrawal call go through.
sh(`cast rpc anvil_setCode 0x0000000000000000000000000000000000000064 $(cd .. && forge inspect MockArbSys deployedBytecode) --rpc-url ${ER}`);

console.log("1. nothing in the wallet but fuel");
let o = await run();
check("idle, nothing sent", o.report.status === "idle" && o.report.actions.length === 0);

console.log("2. tokens sent to the bot wallet on Elysium go into the fee contract");
sh(`cast send ${WHYPE} "deposit()" --value 0.05ether --private-key ${KEY} --rpc-url ${ER} > /dev/null`);
give(ER, KNTQ, POOL_MANAGER, "40");
const inbox0 = [balOf(ER, WHYPE, cfg.elysium.feeInbox), balOf(ER, KNTQ, cfg.elysium.feeInbox)];
o = await run();
check("WHYPE and KNTQ moved into the fee contract", balOf(ER, WHYPE, cfg.elysium.feeInbox) - inbox0[0] === E18 / 20n && balOf(ER, KNTQ, cfg.elysium.feeInbox) - inbox0[1] === 40n * E18 && balOf(ER, KNTQ, BOT) === 0n);
check("plain HYPE fuel was left alone", fuel(ER) > 4n * E18 / 10n);

console.log("3. KNTQ sent to the bot wallet on HyperEVM is sent to be staked and locked");
give(HR, cfg.hyperevm.kntq, GATEWAY, "30");
const sl0 = balOf(HR, cfg.hyperevm.kntq, cfg.hyperevm.stakeAndLock);
o = await run();
check("KNTQ moved to StakeAndLock", balOf(HR, cfg.hyperevm.kntq, cfg.hyperevm.stakeAndLock) - sl0 === 30n * E18 && balOf(HR, cfg.hyperevm.kntq, BOT) === 0n);

console.log("4. only when the owner sets a fuel level: HYPE above it goes into the reserve");
setFuel(ER, "1");
const w0 = balOf(ER, WHYPE, cfg.elysium.feeInbox);
o = await run({ FUEL_KEEP_HYPE: "nonsense" });
check("a bad setting is ignored with a warning", o.report.actions.length === 0 && o.report.warnings.length === 1 && near(fuel(ER), E18));
o = await run({ FUEL_KEEP_HYPE: "0.2" });
check("0.8 HYPE went into the fee contract, 0.2 stayed as fuel", near(balOf(ER, WHYPE, cfg.elysium.feeInbox) - w0, 8n * E18 / 10n) && near(fuel(ER), 2n * E18 / 10n, 5n * 10n ** 15n), `${utils.formatEther(fuel(ER).toString())} HYPE left`);

console.log("5. Elysium runs low: fuel comes over from HyperEVM");
setFuel(ER, "0.01");
const h0 = fuel(HR);
o = await run();
check("0.02 HYPE deposited through the bridge inbox", o.report.actions.some((a) => a.what.includes("HyperEVM to Elysium") && a.confirmed === true) && near(h0 - fuel(HR), E18 / 50n));
setFuel(HR, "0.012");
o = await run();
check("not when HyperEVM has too little to spare: it warns instead", o.report.actions.length === 0 && o.report.warnings.length === 1);

console.log("6. HyperEVM runs low: fuel leaves Elysium through the bridge");
setFuel(ER, "0.5"); setFuel(HR, "0.001");
const e0 = fuel(ER);
o = await run();
check("0.02 HYPE withdrawn; the transaction is handed to the HyperEVM job to claim", !!o.fuelWithdrawal && near(e0 - fuel(ER), E18 / 50n));
o = await run({}, true);
check("not sent again while one is on its way", !o.fuelWithdrawal && o.report.actions.length === 1 && !o.report.actions[0].tx);

console.log("7. dry run and kill switch");
give(ER, KNTQ, POOL_MANAGER, "5");
o = await run({ DRY_RUN: "1" }, true);
check("dry run sends nothing", o.report.mode === "dry-run" && balOf(ER, KNTQ, BOT) === 5n * E18);
o = await run({ TREASURY_PAUSED: "1" });
check("paused", o.report.status === "paused");
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
