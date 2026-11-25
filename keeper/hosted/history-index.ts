// Supabase Edge Function entry: "history-recorder". Called every 5 minutes by pg_cron.
// Reads one point of price and range history (history.ts) and stores it in pool_ticks,
// vault_states and stake_states, plus Kinetiq's kHYPE rate in khype_rate (one row an hour).
// Read back by "vault-history" for the vault pages' charts and by "stake-history" for the Stake page.
import { utils } from "npm:ethers@5.8.0";
import { readHistoryPoint, readKhypeRate } from "./history.ts";

Deno.serve(async (_req: Request) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=minimal" };
  try {
    if (!url || !key) throw new Error("no database access");
    const p = await readHistoryPoint({ utils }, fetch, undefined, Deno.env.get("ELYSIUM_RPC") || undefined);
    for (const [table, rows] of [["pool_ticks", p.ticks], ["vault_states", p.states], ["stake_states", p.stakes]] as const) {
      if (!rows.length) continue;
      const r = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers, body: JSON.stringify(rows) });
      if (!r.ok) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    // Kinetiq's kHYPE rate lives on another chain: if that read fails, the rest of the run still counts.
    let khype: string | null = null;
    try {
      const k = await readKhypeRate({ utils }, fetch, undefined, Deno.env.get("HYPEREVM_RPC") || undefined);
      const r = await fetch(`${url}/rest/v1/khype_rate`, { method: "POST", headers, body: JSON.stringify([k]) });
      if (!r.ok) throw new Error(`khype_rate: ${r.status}`);
      khype = k.rate;
    } catch (e) {
      khype = `failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
    }
    return new Response(JSON.stringify({ ok: true, ts: p.ts, pools: p.ticks.length, vaults: p.states.length, staking: p.stakes.length, khype }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
