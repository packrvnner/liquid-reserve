// Supabase Edge Function entry: "vault-history". Serves the vault pages' chart data.
//   GET ?vault=<address>&pool=<pool id>[&ref=<pool id>]&window=1D|1W|1M|ALL
// Returns { pool: [[unix, tick]...], ref: [[unix, tick]...], ranges: [[unix, mainLower, mainUpper,
// mainLiquidity, altLower, altUpper, altLiquidity]...], share: [[unix, total0, total1, supply]...] },
// under a thousand points each. Public data only (all of it is on-chain); read-only.
const WINDOWS: Record<string, number> = { "1D": 86_400, "1W": 604_800, "1M": 2_592_000, ALL: 31_536_000 * 5 };
const hex = (s: string | null, len: number) => (s && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(s) ? s.toLowerCase() : null);
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "GET, OPTIONS" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const q = new URL(req.url).searchParams;
  const vault = hex(q.get("vault"), 40), pool = hex(q.get("pool"), 64), ref = hex(q.get("ref"), 64);
  const span = WINDOWS[q.get("window") ?? "1W"];
  if (!vault || !pool || !span) return new Response(JSON.stringify({ error: "vault, pool and window are required" }), { status: 400, headers: { ...cors, "content-type": "application/json" } });
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rpc = async (fn: string, body: unknown) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${fn}: ${r.status}`);
    return r.json();
  };
  try {
    const now = Date.now() / 1000;
    const sec = (ts: string) => Math.round(Date.parse(ts) / 1000);
    // "ALL" covers only as far back as there is data, so its points are spread over the real history.
    // For a $liquid vault that includes Ascend's pool, which is older than the vault's own.
    let seen = span;
    if (q.get("window") === "ALL") {
      const firstOf = async (p: string) => {
        const r = await fetch(`${url}/rest/v1/pool_ticks?pool=eq.${p}&select=ts&order=ts.asc&limit=1`, { headers: { apikey: key ?? "", authorization: `Bearer ${key}` } });
        const ts = r.ok ? (await r.json())[0]?.ts : null;
        return ts ? sec(ts) : null;
      };
      const firsts = (await Promise.all([firstOf(pool), ref ? firstOf(ref) : null])).filter((t): t is number => t !== null);
      if (firsts.length) seen = Math.min(span, Math.max(3_600, now - Math.min(...firsts) + 60));
    }
    const from = new Date((now - span) * 1000).toISOString();
    // pool_series returns up to three points per bucket (the low, the high and the last price), and the database
    // hands back at most 1,000 rows: 300 buckets keeps every series whole.
    const bucket = Math.max(60, Math.ceil(seen / 300));
    const [p, r, s, x] = await Promise.all([
      rpc("pool_series", { p_pool: pool, p_from: from, p_bucket: bucket }),
      rpc("range_series", { p_vault: vault, p_from: from }),
      rpc("share_series", { p_vault: vault, p_from: from, p_bucket: bucket }),
      ref ? rpc("pool_series", { p_pool: ref, p_from: from, p_bucket: bucket }) : Promise.resolve([]),
    ]);
    const body = {
      now: Math.round(now), window: q.get("window") ?? "1W",
      pool: p.map((row: any) => [sec(row.ts), row.tick]),
      ref: x.map((row: any) => [sec(row.ts), row.tick]),
      ranges: r.map((row: any) => [sec(row.ts), row.main_lower, row.main_upper, row.main_liq, row.alt_lower, row.alt_upper, row.alt_liq]),
      share: s.map((row: any) => [sec(row.ts), row.total0, row.total1, row.supply]),
    };
    return new Response(JSON.stringify(body), { headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=120" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e).slice(0, 200) }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});
