// Supabase Edge Function entry: "stake-history". Serves the Stake page's chart and its APY.
//   GET ?window=1W|1M|3M|1Y|ALL[&vault=<address>]
// Returns {
//   now, window,
//   rate:  [[unix, rate]...]     Kinetiq's kHYPE rate (HYPE per kHYPE) over the window, about 300 points at most
//   marks: { latest, first, d1, d7, d30, d90, d365 }   each [unix, rate] or null: the newest reading, the oldest one,
//                                and the readings 1, 7, 30, 90 and 365 days before the newest (the page works the
//                                APY out from these, with the real time between them)
//   vault: [[unix, kHYPE held, liquidHYPE in issue, the vault's rate, fee waiting]...]   when `vault` is given
// }
// The rate is StakingAccountant.kHYPEToHYPE on HyperEVM, recorded hourly by "history-recorder" and filled in back
// to kHYPE's first day by script/khype-rate-backfill.py. Public data only (all of it is on-chain); read-only.
const WINDOWS: Record<string, number> = { "1W": 604_800, "1M": 2_592_000, "3M": 7_776_000, "1Y": 31_536_000, ALL: 31_536_000 * 10 };
const hex = (s: string | null, len: number) => (s && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(s) ? s.toLowerCase() : null);
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "GET, OPTIONS" };
const json = (body: unknown, status = 200, cache = "public, max-age=300") => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": cache } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const q = new URL(req.url).searchParams;
  const win = q.get("window") ?? "ALL", span = WINDOWS[win], vault = hex(q.get("vault"), 40);
  if (!span) return json({ error: "window must be 1W, 1M, 3M, 1Y or ALL" }, 400, "no-store");
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
  const rpc = async (fn: string, body: unknown) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${fn}: ${r.status}`);
    return r.json();
  };
  const get = async (path: string) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers });
    if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status}`);
    return r.json();
  };
  try {
    const now = Date.now() / 1000;
    const sec = (ts: string) => Math.round(Date.parse(ts) / 1000);
    const iso = (unix: number) => encodeURIComponent(new Date(unix * 1000).toISOString());
    const E18 = 1e18;
    const point = (rows: any[]) => (rows?.[0] ? [sec(rows[0].ts), Number(rows[0].rate) / E18] : null);
    const [newest, oldest, firstState] = await Promise.all([
      get("khype_rate?select=ts,rate&order=ts.desc&limit=1"),
      get("khype_rate?select=ts,rate&order=ts.asc&limit=1"),
      vault ? get(`stake_states?vault=eq.${vault}&select=ts&order=ts.asc&limit=1`) : Promise.resolve([]),
    ]);
    if (!newest.length) return json({ now: Math.round(now), window: win, rate: [], marks: null, vault: [] });
    const latest = sec(newest[0].ts), first = sec(oldest[0].ts);
    const from = now - span;
    // the points are spread over what there really is to show, never over empty time before the first reading
    const bucketFor = (start: number, least: number) => Math.max(least, Math.ceil(Math.min(span, Math.max(least, now - start)) / 300));
    const before = (days: number) => get(`khype_rate?select=ts,rate&ts=lte.${iso(latest - days * 86_400)}&order=ts.desc&limit=1`);
    const [series, d1, d7, d30, d90, d365, states] = await Promise.all([
      rpc("khype_rate_series", { p_from: new Date(from * 1000).toISOString(), p_bucket: bucketFor(first, 3_600) }),
      before(1), before(7), before(30), before(90), before(365),
      vault && firstState.length ? rpc("stake_series", { p_vault: vault, p_from: new Date(from * 1000).toISOString(), p_bucket: bucketFor(sec(firstState[0].ts), 300) }) : Promise.resolve([]),
    ]);
    return json({
      now: Math.round(now), window: win,
      rate: series.map((r: any) => [sec(r.ts), Number(r.rate) / E18]),
      marks: { latest: point(newest), first: point(oldest), d1: point(d1), d7: point(d7), d30: point(d30), d90: point(d90), d365: point(d365) },
      vault: states.map((s: any) => [sec(s.ts), Number(s.assets) / E18, Number(s.supply) / E18, Number(s.rate) / E18, Number(s.fees) / E18]),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 200) }, 500, "no-store");
  }
});
