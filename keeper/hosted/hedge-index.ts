// Supabase Edge Function entry for the bot's hedged-vault job.
// Called every minute by pg_cron. All the logic is in hedge.ts.
// Its small state (since when the price has been outside the range, when fees were last collected, since when
// money has been owed) lives in the table keeper_state under the key "hedge".
//
// Secrets (Supabase dashboard, Edge Functions -> Secrets), shared with the other jobs:
//   KEEPER_PRIVATE_KEY  the bot wallet's key. Without it the bot only watches.
//   KEEPER_PAUSED=1     stop every job.   HEDGE_PAUSED=1     stop only this one.
//   DRY_RUN=1           every job decides but sends nothing.   HEDGE_DRY_RUN=1  only this one.
//   HYPEREVM_RPC, ELYSIUM_RPC   optional: private RPC URLs instead of the public ones
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runHedge, HEDGE_CONFIG } from "./hedge.ts";

Deno.serve(async (_req: Request) => {
  // ?hash=1 answers with a fingerprint of the settings this deploy runs with instead of running, so a deploy can be
  // checked against the files it was made from (every address and threshold). It reads nothing and changes nothing.
  if (new URL(_req.url).searchParams.get("hash") === "1") {
    const sha = async (v: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return new Response(JSON.stringify({ hedge: await sha(HEDGE_CONFIG) }), { headers: { "content-type": "application/json" } });
  }
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
  let report: any, loaded = false;
  try {
    let state: any = null;
    if (url && key) {
      const rows = await (await fetch(`${url}/rest/v1/keeper_state?key=eq.hedge&select=value`, { headers })).json();
      if (!Array.isArray(rows)) throw new Error("could not read the saved state");
      state = rows[0]?.value ?? null;
      loaded = true;
    }
    const out = await runHedge({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) }, state);
    report = out.report;
    if (loaded) {
      await fetch(`${url}/rest/v1/keeper_state`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "hedge", value: out.state, updated_at: new Date().toISOString() }),
      });
    }
  } catch (e) {
    report = { ok: false, mode: "error", status: "error", reason: "", time: new Date().toISOString(), keeper: null, actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  // One row per run that did or noticed something, and one an hour otherwise: a job that runs every minute would
  // bury its own history under "nothing to do".
  try {
    const quiet = report.ok && !report.error && (report.actions ?? []).length === 0 && (report.warnings ?? []).length === 0;
    if (url && key && (!quiet || new Date().getUTCMinutes() === 0)) {
      await fetch(`${url}/rest/v1/hedge_runs`, {
        method: "POST",
        headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify({
          ok: report.ok, mode: report.mode, status: report.status, reason: report.reason ?? null, keeper: report.keeper, gas_hype: report.gasHype ?? null,
          vault: report.vault ?? null, actions: report.actions ?? [], warnings: report.warnings ?? [], error: report.error ?? null,
        }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
