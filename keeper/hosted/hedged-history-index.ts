// Supabase Edge Function entry: "hedged-history". Serves the hedged vault's page what it cannot read from the chain
// itself: the share price over time, when fees were collected, and one wallet's deposits and withdrawals.
//   GET ?vault=<address>&window=1D|1W|1M|ALL[&account=<address>][&points=0]
// Returns {
//   now, window,
//   first:  [unix, one share in USDC, HYPE in dollars] | null     the oldest reading there is
//   points: [[unix, one share in USDC, HYPE in dollars, the vault's worth in USDC]...]   about 300 at most
//           (left empty with points=0)
//   fees:   [[unix, HYPE collected, USDC collected, both in dollars at that moment]...]   each collection, oldest first
//   ranges: [[unix, lower tick, upper tick]...]   the vault's range over time: one entry each time it changed
//   flows:  { deposited, paid, owed, assetUsd, deposits, withdrawals } | null   everyone's deposits and withdrawals, in dollars
//   account: { events: [[unix, "deposit"|"withdraw"|"claimed", a, b, c, d, HYPE in dollars, transaction]...] }   with `account`:
//           deposit a = USDC in, b = shares; withdraw a = shares, b = USDC paid, c = wrapped HYPE sent, d = USDC owed;
//           claimed a = USDC. Amounts in the tokens' smallest units.
// }
// fees, flows and account come from hedged_events, which "hedged-recorder" copies from the vault's own events.
// The readings are what the keeper bot read from HyperEVM on its runs: the vault's worth at Hyperliquid's price, its
// shares in issue, and that price. One an hour and one whenever the bot acted, copied from its run log (hedge_runs,
// which is cleared after 30 days) into hedged_states (which is kept) by a trigger. Public data only: all of it can
// be read from the chain. Read-only.
const WINDOWS: Record<string, number> = { "1D": 86_400, "1W": 604_800, "1M": 2_592_000, ALL: 31_536_000 * 10 };
const hex = (s: string | null, len: number) => (s && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(s) ? s.toLowerCase() : null);
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "GET, OPTIONS" };
const json = (body: unknown, status = 200, cache = "public, max-age=300") => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": cache } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const q = new URL(req.url).searchParams;
  const win = q.get("window") ?? "ALL", span = WINDOWS[win], vault = hex(q.get("vault"), 40);
  if (!span) return json({ error: "window must be 1D, 1W, 1M or ALL" }, 400, "no-store");
  if (!vault) return json({ error: "vault must be an address" }, 400, "no-store");
  const account = q.get("account") === null ? null : hex(q.get("account"), 40), wantPoints = q.get("points") !== "0";
  if (q.get("account") !== null && !account) return json({ error: "account must be an address" }, 400, "no-store");
  // a wallet's own record changes the moment it deposits or withdraws: keep an answer about one for half a minute only
  const keep = account ? "private, max-age=30" : "public, max-age=300";
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    const now = Date.now() / 1000;
    const sec = (ts: string) => Math.round(Date.parse(ts) / 1000);
    const point = (r: any) => [sec(r.ts), Number(r.value) / Number(r.supply), Number(r.hype_px), Number(r.value) / 1e6];
    const get = async (path: string) => {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers });
      if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status}`);
      return r.json();
    };
    const call = async (fn: string, body: unknown) => {
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${fn}: ${r.status}`);
      return r.json();
    };
    // What comes from the vault's events. If that record cannot be read, the share price is still served.
    const events = async () => {
      try {
        const [fees, flows, mine, filled] = await Promise.all([
          get(`hedged_events?vault=eq.${vault}&kind=eq.fees&select=ts,a,b,px&order=ts.desc&limit=400`),
          call("hedged_flows", { p_vault: vault }),
          account ? get(`hedged_events?vault=eq.${vault}&account=eq.${account}&kind=in.(deposit,withdraw,claimed)&select=ts,kind,a,b,c,d,px,tx&order=ts.asc&limit=1000`) : Promise.resolve(null),
          get(`hedged_events?vault=eq.${vault}&kind=eq.filled&select=ts,b,c&order=ts.asc&limit=1000`),
        ]);
        const f = flows?.[0];
        // the vault fills its range whenever money is put to work; only a fill at other edges is a change of range
        const ranges: number[][] = [];
        for (const x of filled) { const r = [sec(x.ts), Number(x.b), Number(x.c)], last = ranges.at(-1); if (!last || last[1] !== r[1] || last[2] !== r[2]) ranges.push(r); }
        return {
          ranges,
          fees: fees.reverse().map((x: any) => { const h = Number(x.a) / 1e18, u = Number(x.b) / 1e6; return [sec(x.ts), h, u, u + h * Number(x.px ?? 0)]; }),
          flows: f ? { deposited: Number(f.deposited), paid: Number(f.paid), owed: Number(f.owed), assetUsd: Number(f.asset_usd), deposits: Number(f.deposits), withdrawals: Number(f.withdrawals) } : null,
          ...(mine ? { account: { events: mine.map((x: any) => [sec(x.ts), x.kind, Number(x.a), Number(x.b), Number(x.c), Number(x.d), x.px === null ? null : Number(x.px), x.tx]) } } : {}),
        };
      } catch (_) {
        return { fees: [], flows: null, ranges: [], ...(account ? { account: null } : {}) };
      }
    };
    const [oldest, extra] = await Promise.all([get(`hedged_states?vault=eq.${vault}&select=ts,value,supply,hype_px&order=ts.asc&limit=1`), events()]);
    if (!Array.isArray(oldest)) throw new Error("could not read the history");
    if (!oldest.length) return json({ now: Math.round(now), window: win, first: null, points: [], ...extra }, 200, keep);
    let rows: any[] = [];
    if (wantPoints) {
      // the points are spread over what there really is to show, never over empty time before the first reading
      const bucket = Math.max(300, Math.ceil(Math.min(span, Math.max(300, now - sec(oldest[0].ts))) / 300));
      rows = await call("hedged_series", { p_vault: vault, p_from: new Date((now - span) * 1000).toISOString(), p_bucket: bucket });
    }
    return json({ now: Math.round(now), window: win, first: point(oldest[0]).slice(0, 3), points: rows.map(point), ...extra }, 200, keep);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 200) }, 500, "no-store");
  }
});
