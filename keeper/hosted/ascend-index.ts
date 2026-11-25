// Supabase Edge Function entry for the bot's Ascend job.
// Called every 10 minutes by pg_cron (minutes 8, 18, ...), clear of the other
// Elysium jobs, which share the wallet. All the logic is in ascend.ts. Its state
// (how far the chain has been scanned, the coin's seat once found) lives in the
// table keeper_state under the key "ascend".
//
// Secrets: KEEPER_PRIVATE_KEY; KEEPER_PAUSED=1 or ASCEND_PAUSED=1 to stop;
// DRY_RUN=1 or ASCEND_DRY_RUN=1 to decide without sending; ELYSIUM_RPC optional.
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runAscend } from "./ascend.ts";

Deno.serve(async (_req: Request) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
  let report: any;
  try {
    if (!url || !key) throw new Error("the function has no database access");
    const rows = await (await fetch(`${url}/rest/v1/keeper_state?key=eq.ascend&select=value`, { headers })).json();
    if (!Array.isArray(rows)) throw new Error("could not read the saved state");
    const out = await runAscend({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) }, rows[0]?.value ?? null);
    report = out.report;
    await fetch(`${url}/rest/v1/keeper_state`, {
      method: "POST", headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: "ascend", value: out.state, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    report = { ok: false, mode: "error", status: "error", reason: "", time: new Date().toISOString(), keeper: null, coins: [], actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  try {
    if (url && key) {
      await fetch(`${url}/rest/v1/ascend_runs`, {
        method: "POST", headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify({ ok: report.ok, mode: report.mode, status: report.status, reason: report.reason ?? null, keeper: report.keeper, coins: report.coins ?? [], actions: report.actions ?? [], warnings: report.warnings ?? [], error: report.error ?? null }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
