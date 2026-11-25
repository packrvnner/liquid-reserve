// Supabase Edge Function entry for the bot's KNTQ staking job ("kntq-keeper").
// To be called every 10 minutes by pg_cron. All the logic is in kntq.ts.
// Its small state (how far Elysium has been read, the batches in progress) lives in the table keeper_state
// under the key "kntq"; each run is recorded in kntq_runs.
//
// Secrets (Supabase dashboard, Edge Functions -> Secrets), shared with the other jobs:
//   KEEPER_PRIVATE_KEY  the bot wallet's key. Without it the bot only watches.
//   KEEPER_PAUSED=1     stop every job.   KNTQ_PAUSED=1     stop only this one.
//   DRY_RUN=1           every job decides but sends nothing.   KNTQ_DRY_RUN=1  only this one.
//   ELYSIUM_RPC, HYPEREVM_RPC   optional: private RPC URLs instead of the public ones
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runKntq } from "./kntq.ts";

Deno.serve(async (_req: Request) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
  let report: any, state: any = null, loaded = false;
  try {
    if (url && key) {
      const rows = await (await fetch(`${url}/rest/v1/keeper_state?key=eq.kntq&select=value`, { headers })).json();
      if (!Array.isArray(rows)) throw new Error("could not read the saved state");
      state = rows[0]?.value ?? null;
      loaded = true;
    }
    const out = await runKntq({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) }, state);
    report = out.report;
    if (loaded) {
      await fetch(`${url}/rest/v1/keeper_state`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "kntq", value: out.state, updated_at: new Date().toISOString() }),
      });
    }
  } catch (e) {
    report = { ok: false, mode: "error", status: "error", reason: "", time: new Date().toISOString(), keeper: null, batches: [], actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  try {
    if (url && key) {
      await fetch(`${url}/rest/v1/kntq_runs`, {
        method: "POST",
        headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify({
          ok: report.ok, mode: report.mode, status: report.status, reason: report.reason ?? null, keeper: report.keeper, gas_hype: report.gasHype ?? null,
          batches: report.batches ?? [], actions: report.actions ?? [], warnings: report.warnings ?? [], holdings: report.holdings ?? null, error: report.error ?? null,
        }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
