// One real reading of price and range history from the chain (read-only).
//   npx tsx hosted/test-history.ts
import { utils } from "ethers";
import { readHistoryPoint, readKhypeRate } from "./history.js";
const p = await readHistoryPoint({ utils }, fetch);
console.log("chain time", p.ts);
console.log("pools:", p.ticks.map((t) => `${t.pool.slice(0, 10)} tick ${t.tick}`).join(" | "));
for (const s of p.states) console.log(s.vault.slice(0, 10), "main", s.main_lower, s.main_upper, "liq", s.main_liq.slice(0, 10), "| alt", s.alt_lower, s.alt_upper, "liq", s.alt_liq.slice(0, 10), "| supply", s.supply.slice(0, 12));
for (const k of p.stakes) console.log("staking vault", k.vault.slice(0, 10), "kHYPE held", k.assets, "| liquidHYPE", k.supply, "| rate", k.rate, "| fee waiting", k.fees);
const k = await readKhypeRate({ utils }, fetch);
console.log("Kinetiq kHYPE rate", Number(k.rate) / 1e18, "at HyperEVM block", k.block, "stored under", k.ts);
