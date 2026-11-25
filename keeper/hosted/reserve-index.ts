// Supabase Edge Function entry for the bot's reserve job.
// Called every 10 minutes by pg_cron, 5 minutes apart from the vault keeper
// (they share one wallet). All the logic is in reserve.ts. The drop job (drop.ts) runs right after it, with the
// same wallet: it feeds the $liquid drop from the USDC the reserve sets aside, and does nothing until the owner
// has set that up. The yield job (yield.ts) runs last: it passes the reserve's yield to the yield director and has
// it split, and likewise does nothing until that is set up. Their results are stored in the same reserve_runs row.
//
// Secrets (Supabase dashboard, Edge Functions -> Secrets), shared with the vault keeper:
//   KEEPER_PRIVATE_KEY  the bot wallet's key. Without it the bot only watches.
//   KEEPER_PAUSED=1     stop both jobs.   RESERVE_PAUSED=1      stop only this one.
//   DRY_RUN=1           both jobs decide but send nothing.   RESERVE_DRY_RUN=1  only this one.
//   ELYSIUM_RPC         optional: a private RPC URL instead of the public one
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runReserve, RESERVE_CONFIG } from "./reserve.ts";
import { runDrop, DROP_CONFIG } from "./drop.ts";
import { runYield, YIELD_CONFIG } from "./yield.ts";

Deno.serve(async (_req: Request) => {
  // ?hash=1 answers with a fingerprint of the settings this deploy runs with instead of running, so a deploy can be
  // checked against the files it was made from (every address and threshold). It reads nothing and changes nothing.
  if (new URL(_req.url).searchParams.get("hash") === "1") {
    const sha = async (v: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return new Response(JSON.stringify({ reserve: await sha(RESERVE_CONFIG), drop: await sha(DROP_CONFIG), yield: await sha(YIELD_CONFIG) }), { headers: { "content-type": "application/json" } });
  }
  let report: any;
  try {
    report = await runReserve({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) });
  } catch (e) {
    report = { ok: false, mode: "error", status: "error", reason: "", time: new Date().toISOString(), keeper: null, actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  // The drop job, after the reserve job so the two never send from the wallet at the same time.
  let drop: any;
  try {
    drop = await runDrop({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) });
  } catch (e) {
    drop = { ok: false, status: "error", reason: "", actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  // The yield job, last.
  let yld: any;
  try {
    yld = await runYield({ ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) });
  } catch (e) {
    yld = { ok: false, status: "error", reason: "", actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  const on = (j: any) => j.status !== "off" && j.status !== "paused"; // until a job is set up it adds nothing to the row
  const row = {
    ok: report.ok && drop.ok && yld.ok,
    reason: [report.reason, on(drop) && drop.reason ? `drop: ${drop.reason}` : "", on(yld) && yld.reason ? `yield: ${yld.reason}` : ""].filter(Boolean).join(" | "),
    actions: [...(report.actions ?? []), ...(drop.actions ?? []), ...(yld.actions ?? [])],
    warnings: [...new Set([...(report.warnings ?? []), ...(drop.warnings ?? []), ...(yld.warnings ?? [])])],
    holdings: report.holdings || drop.drop || yld.shares ? { ...(report.holdings ?? {}), ...(drop.drop ? { drop: drop.drop } : {}), ...(yld.shares ? { yieldShares: yld.shares } : {}) } : null,
    error: report.error ?? drop.error ?? yld.error ?? null,
  };
  // Keep a short history so it is easy to see the bot is alive and what it did.
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (url && key) {
      await fetch(`${url}/rest/v1/reserve_runs`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({
          ok: row.ok, mode: report.mode, status: report.status, reason: row.reason || null, keeper: report.keeper, block: report.block ?? null,
          gas_hype: report.gasHype ?? null, waiting_usd: report.waitingUsd ?? null, needed_usd: report.neededUsd ?? null,
          actions: row.actions, warnings: row.warnings, holdings: row.holdings, error: row.error,
        }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify({ ...report, drop, yield: yld }), { headers: { "content-type": "application/json" } });
});
