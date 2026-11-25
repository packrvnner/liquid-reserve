// Supabase Edge Function entry for the hosted vault keeper.
// Called every 10 minutes by pg_cron. All the logic is in core.ts.
//
// Secrets (set in the Supabase dashboard, Edge Functions -> Secrets):
//   KEEPER_PRIVATE_KEY  the bot wallet's key. Without it the bot only watches.
//   KEEPER_PAUSED=1     stop doing anything (kill switch)
//   DRY_RUN=1           decide and simulate, but send nothing
//   ELYSIUM_RPC         optional: a private RPC URL instead of the public one
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runKeeper } from "./core.ts";

Deno.serve(async (_req: Request) => {
  let report: any;
  try {
    report = await runKeeper({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) });
  } catch (e) {
    report = { ok: false, mode: "error", time: new Date().toISOString(), keeper: null, vaults: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }

  // Keep a short history so it is easy to see the bot is alive and what it did.
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (url && key) {
      await fetch(`${url}/rest/v1/keeper_runs`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({
          ok: report.ok, mode: report.mode, keeper: report.keeper, block: report.block ?? null, gas_hype: report.gasHype ?? null,
          vaults: report.vaults, warnings: report.warnings, error: report.error ?? null,
        }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
