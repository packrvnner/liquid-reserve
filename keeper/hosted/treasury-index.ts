// Supabase Edge Function entry for the bot's treasury job.
// Called every 30 minutes by pg_cron (minutes 3 and 33, clear of the other jobs,
// which share the wallet). All the logic is in treasury.ts.
//
// Secrets (Supabase dashboard, Edge Functions -> Secrets):
//   KEEPER_PRIVATE_KEY   the bot wallet's key
//   KEEPER_PAUSED=1      stop every job.   TREASURY_PAUSED=1    stop only this one.
//   DRY_RUN=1            every job decides but sends nothing.   TREASURY_DRY_RUN=1  only this one.
//   FUEL_KEEP_HYPE=0.2   optional: keep this much HYPE on Elysium as fuel and send anything
//                        above it into the reserve. Unset, plain HYPE is never locked.
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runTreasury } from "./treasury.ts";

Deno.serve(async (_req: Request) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
  const load = async (k: string) => {
    const rows = await (await fetch(`${url}/rest/v1/keeper_state?key=eq.${k}&select=value`, { headers })).json();
    if (!Array.isArray(rows)) throw new Error("could not read the saved state");
    return rows[0]?.value ?? null;
  };
  const save = (k: string, value: unknown) => fetch(`${url}/rest/v1/keeper_state`, {
    method: "POST", headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }),
  });
  let report: any;
  try {
    if (!url || !key) throw new Error("the function has no database access");
    // A fuel withdrawal sent earlier is "in flight" until the HyperEVM job has claimed it.
    const mine = (await load("treasury")) ?? {}, hyper = (await load("hyperevm")) ?? { withdrawals: {} };
    const inFlight = !!mine.fuelTx && hyper.withdrawals?.[mine.fuelTx] !== "EXECUTED";
    const out = await runTreasury({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) }, inFlight);
    report = out.report;
    if (out.fuelWithdrawal) {
      // Hand the withdrawal to the HyperEVM job, which claims it once the bridge confirms it.
      const latest = (await load("hyperevm")) ?? { withdrawals: {} };
      latest.withdrawals = { ...(latest.withdrawals ?? {}), [out.fuelWithdrawal]: "PENDING" };
      await save("hyperevm", latest);
      await save("treasury", { fuelTx: out.fuelWithdrawal });
    }
  } catch (e) {
    report = { ok: false, mode: "error", status: "error", reason: "", time: new Date().toISOString(), keeper: null, actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  try {
    if (url && key) {
      await fetch(`${url}/rest/v1/treasury_runs`, {
        method: "POST", headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify({ ok: report.ok, mode: report.mode, status: report.status, reason: report.reason ?? null, keeper: report.keeper, fuel: report.fuel ?? null, actions: report.actions ?? [], warnings: report.warnings ?? [], error: report.error ?? null }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
