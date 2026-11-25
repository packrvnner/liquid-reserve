// Supabase Edge Function entry for the bot's creator-cut job.
// Called every 10 minutes by pg_cron (minutes 2, 12, ...), clear of the other
// Elysium jobs, which share the wallet. It runs two things, one after the other:
//   creator.ts  passes the old fee path's creator cut on to the reserve
//   share.ts    pays out through the creator-share splitters (20% to the creator's wallet)
// and stores one row for both in creator_runs.
//
// Secrets: KEEPER_PRIVATE_KEY; KEEPER_PAUSED=1 or CREATOR_PAUSED=1 to stop;
// DRY_RUN=1 or CREATOR_DRY_RUN=1 to decide without sending; ELYSIUM_RPC optional.
import { Wallet, utils } from "npm:ethers@5.8.0";
import { runCreator, CREATOR_CONFIG } from "./creator.ts";
import { runShare, SHARE_CONFIG } from "./share.ts";

Deno.serve(async (_req: Request) => {
  // ?hash=1 answers with a fingerprint of the settings this deploy runs with instead of running, so a deploy can be
  // checked against the files it was made from (every address and threshold). It reads nothing and changes nothing.
  if (new URL(_req.url).searchParams.get("hash") === "1") {
    const sha = async (v: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return new Response(JSON.stringify({ creator: await sha(CREATOR_CONFIG), share: await sha(SHARE_CONFIG) }), { headers: { "content-type": "application/json" } });
  }
  const deps = { ethers: { Wallet, utils }, fetch, env: (k: string) => Deno.env.get(k) };
  const failed = (e: unknown) => ({ ok: false, mode: "error", status: "error", reason: "", time: new Date().toISOString(), keeper: null, actions: [], warnings: [], error: String((e as Error)?.message ?? e).slice(0, 300) });
  let first: any, share: any;
  try { first = await runCreator(deps); } catch (e) { first = failed(e); }
  try { share = await runShare(deps); } catch (e) { share = failed(e); }
  // one report for both parts
  const pick = [first.status, share.status];
  const report: any = {
    ok: first.ok && share.ok, mode: first.mode, time: first.time, keeper: first.keeper ?? share.keeper,
    status: pick.includes("error") ? "error" : pick.includes("acted") ? "acted" : pick.includes("waiting") ? "waiting" : first.status,
    reason: [first.reason, share.reason ? `creator share: ${share.reason}` : ""].filter(Boolean).join(" | "),
    waiting: { ...(first.waiting ?? {}), ...(share.holding ?? {}) },
    actions: [...(first.actions ?? []), ...(share.actions ?? [])],
    warnings: [...new Set([...(first.warnings ?? []), ...(share.warnings ?? [])])],
    error: first.error ?? share.error,
  };
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (url && key) {
      await fetch(`${url}/rest/v1/creator_runs`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({ ok: report.ok, mode: report.mode, status: report.status, reason: report.reason ?? null, keeper: report.keeper, waiting: report.waiting ?? null, actions: report.actions ?? [], warnings: report.warnings ?? [], error: report.error ?? null }),
      });
    }
  } catch (_) {
    // history is best-effort; never fail a run because of it
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
