// One-time backfill of the vault chart history from chain events (read-only).
//   npx tsx hosted/backfill-history.ts <out-dir>
// Writes SQL files (insert ... on conflict do nothing) for pool_ticks and vault_states:
//   - pool prices: the last swap tick in each 5-minute bucket, from each pool's Swap events
//     (and the starting price from its Initialize event, for pools created after the start)
//   - vault ranges and holdings: at every Rebalanced and Snapshot event (range liquidity unknown
//     for these older points, so it is left empty)
// Block times are interpolated between sampled blocks, accurate to well under a bucket.
import { utils } from "ethers";
import fs from "node:fs";
import path from "node:path";

const RPC = "https://rpc.elysium.kinetiq.xyz";
const PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1";
const FROM = 6_213_000, CHUNK = 500_000, BUCKET = 300;
const outDir = process.argv[2] ?? ".";
const dep = JSON.parse(fs.readFileSync(new URL("../../site/deployment.json", import.meta.url), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  const wait = last + 220 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const j: any = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) { if (/rate/i.test(j.error.message)) { await sleep(1500); return rpc(method, params); } throw new Error(j.error.message); }
  return j.result;
}
const hex = (n: number) => "0x" + n.toString(16);
const head = parseInt(await rpc("eth_blockNumber", []), 16);

// block -> time, by interpolation between samples every 20,000 blocks
const anchors: [number, number][] = [];
for (let b = FROM; b < head; b += 20_000) anchors.push([b, parseInt((await rpc("eth_getBlockByNumber", [hex(b), false])).timestamp, 16)]);
anchors.push([head, parseInt((await rpc("eth_getBlockByNumber", [hex(head), false])).timestamp, 16)]);
function timeOf(block: number) {
  let i = anchors.findIndex(([b]) => b > block); if (i <= 0) i = i === 0 ? 1 : anchors.length - 1;
  const [b0, t0] = anchors[i - 1], [b1, t1] = anchors[i];
  return t0 + ((block - b0) * (t1 - t0)) / (b1 - b0);
}
async function logs(filter: any) {
  const all: any[] = [];
  for (let a = FROM; a <= head; a += CHUNK) all.push(...(await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(a), toBlock: hex(Math.min(head, a + CHUNK - 1)) }])));
  return all;
}
const I = new utils.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Rebalanced(int24 tick, int24 mainLower, int24 mainUpper, int24 altLower, int24 altUpper)",
  "event Snapshot(uint256 total0, uint256 total1, uint256 totalSupply, uint160 sqrtPriceX96)",
]);
const iso = (t: number) => new Date(Math.round(t) * 1000).toISOString();

const vaults = dep.vaults.filter((v: any) => /^0x[0-9a-fA-F]{40}$/.test(v.address ?? "") && /^0x[0-9a-fA-F]{64}$/.test(v.pool ?? ""));
const pools = [...new Set<string>([...vaults.map((v: any) => v.pool.toLowerCase()), dep.pools.liquidHype.toLowerCase()])];

const tickRows: string[] = [];
for (const pool of pools) {
  const buckets = new Map<number, [number, number]>(); // bucket -> [time, tick]
  const init = await logs({ address: PM, topics: [I.getEventTopic("Initialize"), pool] });
  for (const l of init) { const t = timeOf(parseInt(l.blockNumber, 16)); buckets.set(Math.floor(t / BUCKET), [t, Number(I.parseLog(l).args.tick)]); }
  const swaps = await logs({ address: PM, topics: [I.getEventTopic("Swap"), pool] });
  for (const l of swaps) { const t = timeOf(parseInt(l.blockNumber, 16)); const k = Math.floor(t / BUCKET); const prev = buckets.get(k); if (!prev || prev[0] <= t) buckets.set(k, [t, Number(I.parseLog(l).args.tick)]); }
  for (const [, [t, tick]] of [...buckets].sort((a, b) => a[0] - b[0])) tickRows.push(`('${pool}','${iso(t)}',${tick})`);
  console.log(`pool ${pool.slice(0, 10)}: ${init.length} initialize, ${swaps.length} swaps -> ${buckets.size} points`);
}

const stateRows: string[] = [];
for (const v of vaults) {
  const evs = (await logs({ address: v.address, topics: [[I.getEventTopic("Rebalanced"), I.getEventTopic("Snapshot")]] }))
    .sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
  let r: any = null, s: any = null; const seen = new Map<string, string>();
  for (const l of evs) {
    const e = I.parseLog(l);
    if (e.name === "Rebalanced") r = e.args; else s = e.args;
    if (!r) continue;
    const ts = iso(timeOf(parseInt(l.blockNumber, 16)));
    seen.set(ts, `('${v.address.toLowerCase()}','${ts}',${r.mainLower},${r.mainUpper},null,${r.altLower},${r.altUpper},null,${s ? `${s.total0},${s.total1},${s.totalSupply}` : "null,null,null"})`);
  }
  stateRows.push(...seen.values());
  console.log(`vault ${v.address.slice(0, 10)} (${v.id}): ${evs.length} events -> ${seen.size} points`);
}

fs.mkdirSync(outDir, { recursive: true });
const write = (name: string, table: string, cols: string, rows: string[]) => {
  for (let i = 0; i < rows.length; i += 400) {
    fs.writeFileSync(path.join(outDir, `${name}-${String(i / 400).padStart(2, "0")}.sql`), `insert into public.${table} (${cols}) values\n${rows.slice(i, i + 400).join(",\n")}\non conflict do nothing;\n`);
  }
};
write("ticks", "pool_ticks", "pool, ts, tick", tickRows);
write("states", "vault_states", "vault, ts, main_lower, main_upper, main_liq, alt_lower, alt_upper, alt_liq, total0, total1, supply", stateRows);
console.log(`wrote ${tickRows.length} price points and ${stateRows.length} vault points to ${outDir}`);
