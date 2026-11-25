// Supabase Edge Function entry: "history-swaps". Called every 5 minutes by pg_cron, and by hand to fill in the past.
//
// Reads the pools' Swap events from the chain and stores the price each swap left behind (its tick) in
// pool_ticks: for every pool and every 5 minutes, the lowest, the highest and the last price, each at its real
// time. The "history-recorder" readings only sample the price every 5 minutes; this keeps the moves in between
// (a spike that comes and goes inside 5 minutes) and lets the history reach back to the day a pool was created.
//
//   no parameters                             every listed pool, the last ~8,000 blocks (about half an hour)
//   ?pool=<pool id>&from=<block>&to=<block>   one pool over a block range, with its creation price if it falls inside
//
// Only pools listed on the live site (deployment.json) are accepted. Public chain data only: it holds no keys
// and sends no transactions. Rows are inserted with "ignore duplicates", so running it twice changes nothing.
const RPC = "https://rpc.elysium.kinetiq.xyz";
const POOL_MANAGER = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const DEPLOYMENT = "https://liquidreserve.xyz/deployment.json";
const BUCKET = 300, RECENT_BLOCKS = 8_000, MAX_RANGE = 2_000_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPool = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);

async function rpc(url: string, method: string, params: unknown[], tries = 0): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) {
    if (/rate limit|too many requests/i.test(j.error.message ?? "") && tries < 5) { await sleep(1200); return rpc(url, method, params, tries + 1); }
    throw new Error(j.error.message ?? "RPC error");
  }
  return j.result;
}

/** int24 in the last 3 bytes of a 32-byte word */
const tickOf = (word: string) => { const v = parseInt(word.slice(-6), 16); return v >= 0x800000 ? v - 0x1000000 : v; };

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    if (!url || !key) throw new Error("no database access");
    const rpcUrl = Deno.env.get("ELYSIUM_RPC") || RPC;
    const q = new URL(req.url).searchParams;
    const dep: any = await (await fetch(DEPLOYMENT, { headers: { "cache-control": "no-cache" } })).json();
    const listed = [...new Set<string>([...(dep.vaults ?? []).map((v: any) => v.pool), dep.pools?.liquidHype].filter(isPool).map((p: string) => p.toLowerCase()))];
    if (!listed.length) throw new Error("no pools listed");

    const head = parseInt(await rpc(rpcUrl, "eth_blockNumber", []), 16);
    let pools = listed, from = Math.max(0, head - RECENT_BLOCKS), to = head, withCreation = false;
    if (q.get("pool")) {
      const pool = (q.get("pool") ?? "").toLowerCase();
      if (!listed.includes(pool)) return json({ ok: false, error: "not a listed pool" }, 400);
      from = Number(q.get("from")); to = Math.min(head, Number(q.get("to") ?? head));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > MAX_RANGE) return json({ ok: false, error: "bad block range" }, 400);
      pools = [pool]; withCreation = true;
    }
    const range = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };
    let logs: any[];
    try {
      logs = await rpc(rpcUrl, "eth_getLogs", [{ address: POOL_MANAGER, topics: [withCreation ? [SWAP, INITIALIZE] : SWAP, pools], ...range }]);
    } catch (e) {
      // too many events for one request: the caller asks again with a smaller range
      if (/limit exceeded|too many|query returned more/i.test(String((e as Error).message))) return json({ ok: false, tooMany: true, from, to });
      throw e;
    }

    // for each pool and each 5 minutes: the lowest, the highest and the last price, each at its real time
    type Pt = { pool: string; sec: number; order: number; us: number; tick: number };
    const buckets = new Map<string, { low: Pt; high: Pt; last: Pt }>();
    for (const l of logs) {
      if (!l.blockTimestamp) throw new Error("the RPC did not return block times");
      const d = l.data.slice(2), block = parseInt(l.blockNumber, 16), index = parseInt(l.logIndex, 16);
      // A swap that leaves the pool with no liquidity in range (or pins the price at the very end of the scale) says
      // nothing about the price: it happens when a pool is empty. Those are left out.
      if (l.topics[0] === SWAP && (/^0+$/.test(d.slice(64 * 3, 64 * 4)) || Math.abs(tickOf(d.slice(64 * 4, 64 * 5))) >= 887_000)) continue;
      // Swap: amount0, amount1, sqrtPriceX96, liquidity, tick, fee. Initialize: fee, tickSpacing, hooks, sqrtPriceX96, tick. The tick is the 5th word in both.
      const p: Pt = { pool: l.topics[1].toLowerCase(), sec: parseInt(l.blockTimestamp, 16), order: block * 100_000 + index, us: (block % 1000) * 1000 + Math.min(index, 999), tick: tickOf(d.slice(64 * 4, 64 * 5)) };
      const k = `${p.pool}|${Math.floor(p.sec / BUCKET)}`, b = buckets.get(k);
      if (!b) { buckets.set(k, { low: p, high: p, last: p }); continue; }
      if (p.tick < b.low.tick) b.low = p;
      if (p.tick > b.high.tick) b.high = p;
      if (p.order > b.last.order) b.last = p;
    }
    const rows = new Map<string, { pool: string; ts: string; tick: number }>();
    for (const b of buckets.values()) {
      for (const p of [b.low, b.high, b.last]) {
        const ts = `${new Date(p.sec * 1000).toISOString().slice(0, 19)}.${String(p.us).padStart(6, "0")}Z`;
        rows.set(`${p.pool}|${ts}`, { pool: p.pool, ts, tick: p.tick });
      }
    }
    const all = [...rows.values()];
    const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=minimal" };
    for (let i = 0; i < all.length; i += 2000) {
      const r = await fetch(`${url}/rest/v1/pool_ticks?on_conflict=pool,ts`, { method: "POST", headers, body: JSON.stringify(all.slice(i, i + 2000)) });
      if (!r.ok) throw new Error(`pool_ticks: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    return json({ ok: true, pools: pools.length, from, to, events: logs.length, rows: all.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
