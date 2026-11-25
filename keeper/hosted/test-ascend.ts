// Read-only test of the bot's Ascend job against the REAL chain: it points the job at
// other people's real coins (as if their recipient were ours), lets it find them, and
// simulates (never sends) the settle / harvest / claim calls it would make.
//   npx tsx hosted/test-ascend.ts
import { Wallet, utils } from "ethers";
import { runAscend, ASCEND_CONFIG, AscendConfig, AscendReport } from "./ascend.js";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: AscendReport) => console.log(`       -> ${r.status}: ${r.reason}\n          ${r.coins.map((c) => `coin seat ${c.seat.slice(0, 10)} pair ${c.pair}: at Ascend ${c.atAscend}, released ${c.releasedToSeat}, claimable ${c.claimable}, last claim ${c.lastClaimDaysAgo} days ago, removable in ${c.daysUntilRemovable} days`).join("\n          ")}${r.actions.length ? "\n          " + r.actions.map((a) => `${a.what} [${a.note ?? (a.confirmed ? "confirmed" : "NOT confirmed")}]`).join("\n          ") : ""}${r.warnings.length ? "\n          warnings: " + r.warnings.join("; ") : ""}`);
const throwaway = Wallet.createRandom(); // empty wallet: only the "from" of simulations
const env: Record<string, string> = { KEEPER_PRIVATE_KEY: throwaway.privateKey, DRY_RUN: "1" };
const zero = Object.fromEntries(Object.entries(ASCEND_CONFIG.quotes).map(([k, v]) => [k, { ...v, minSettle: "0.000001", minClaim: "0.000001" }]));
const run = (cfg: AscendConfig, state: any = null) => runAscend({ ethers: { Wallet, utils }, fetch, env: (k) => env[k] }, state, cfg);

console.log("1. our own fee contract: the $liquid coin (launched 15 November 2026)");
let o = await run(ASCEND_CONFIG);
show(o.report);
check("finds our own coin, or reports that none has been launched", (o.report.status === "no-coin" ? o.state.seats.length === 0 : o.state.seats.length >= 1) && (o.state.scanBlock ?? 0) > ASCEND_CONFIG.scanFromBlock);

const cases: [string, string, number][] = [
  ["a real coin whose recipient claims for itself", "0xbd081f1b95d62c9a30efab2bb862eea6dcd7450a", 6_796_000],
  ["another real coin, with a buyback", "0xc744b54ed2cd7c5ead051a11c6ef88c1a4a3faa1", 6_763_000],
];
let simulated = 0, accepted = 0;
for (const [name, payee, fromBlock] of cases) {
  console.log(`2. ${name}: found by its recipient, then every step simulated`);
  o = await run({ ...ASCEND_CONFIG, payee, scanFromBlock: fromBlock, quotes: zero });
  show(o.report);
  check("found the coin from the launch event alone", o.state.seats.length >= 1 && o.report.coins.length >= 1);
  check("read its fees and its recipient's place", o.report.coins.every((c) => c.daysUntilRemovable > 0 && c.daysUntilRemovable <= 180));
  simulated += o.report.actions.length; accepted += o.report.actions.filter((a) => a.note === "dry run: would have been sent").length;
  const again = await run({ ...ASCEND_CONFIG, payee, scanFromBlock: fromBlock, quotes: zero }, o.state);
  check("remembers the coin without scanning again", again.state.seats.length === o.state.seats.length && (again.state.scanBlock ?? 0) >= (o.state.scanBlock ?? 0));
}
check("Ascend accepted the calls it would send (simulated only)", simulated === 0 || accepted === simulated, `${accepted} of ${simulated}`);
if (simulated === 0) console.log("  note: those coins had nothing waiting, so no call could be simulated");
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
