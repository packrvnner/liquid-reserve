// Supabase Edge Function entry: "hedged-recorder". Called every 5 minutes by pg_cron.
//
// Copies the hedged vault's own events from HyperEVM into the table hedged_events: every deposit, withdrawal and
// claim (with the wallet it concerns), every collection of trading fees, and every time the vault filled its range
// (which is how its range over time is known). The vault's page needs them to tell a wallet what it has put in and
// taken out and to draw the range on its chart, and it cannot read them itself: HyperEVM's public RPC answers event
// queries over 1,000 blocks at most, about a quarter of an hour. So the record has to be kept up as it happens.
//
// It is deliberately slow. That RPC counts one event query for a large part of what an address may ask in a
// minute (measured 2026-11-27: two within seven seconds, and every read from the same address was refused for
// most of a minute; one every half minute went through and left ordinary reads alone). The keeper bots read the
// same RPC from the same service, and their reads matter more than this record. So: ONE event query per run, a
// run every 5 minutes (about 300 blocks, well inside the 1,000), and it waits 20 seconds first so that it never
// lands on the same second as a bot's run. If it falls behind it catches up by 900 blocks a run.
//
// It only reads the chain. It holds no wallet key and sends no transaction. Public data only.
// Where it has got to is kept in keeper_state under the key "hedged-recorder" ({ block }).
// Switch: HEDGED_RECORDER_PAUSED=1 stops it. HYPEREVM_RPC, if set, replaces the public RPC.
export const RECORDER_CONFIG = {
  rpc: "https://rpc.hyperliquid.xyz/evm",
  vault: "0x269ECaEaE9dbC37B9d2cb643Deec89394d9E07DD",
  fromBlock: 52_348_094, // the block the vault was created in
  span: 900, // blocks per query; the RPC refuses more than 1,000
  maxQueries: 1, // event queries per run: see the note above before raising this
  behind: 2, // stay this many blocks behind the newest
  gapMs: 1500, // between any two requests
  startDelayMs: 20_000, // wait this long first: the bots run on the minute
  pxDecimals: 4, // the vault's Snapshot carries Hyperliquid's price with 6 - szDecimals decimals (HYPE: 4)
};
// keccak256 of each event's signature (src/hedged/HedgedTypes.sol)
const TOPIC = {
  deposit: "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7", // Deposit(address indexed sender, address indexed receiver, uint256 usdc, uint256 shares)
  withdraw: "0x7ff9a08662c21e17b8071f3aef03a9712ea9d3824dfb0139bba272915d59a919", // Withdraw(address indexed owner, address indexed receiver, uint256 shares, uint256 usdcPaid, uint256 assetPaid, uint256 usdcOwed)
  claimed: "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a", // Claimed(address indexed receiver, uint256 usdc)
  fees: "0xf5d590414d56d256b8c16b850d0b57f2f5d2ed90686166e150b48a96f0dbdd61", // FeesCollected(uint256 fee0, uint256 fee1, uint256 performanceFee0, uint256 performanceFee1)
  snapshot: "0x4721c31db00d4c86f3effcb9b553c869ce768e138eaf7a09cea387ffb5d9da33", // Snapshot(uint256 totalValue, uint256 totalSupply, uint256 oraclePx)
  filled: "0xd304492c5fde5fd8a83b42344964570c0a15e27d4f3ecf859e97a531010dd3f4", // Filled(int24 tick, int24 lower, int24 upper, uint128 liquidityAdded)
};
type Row = { vault: string; block: number; log_index: number; ts: string; tx: string; kind: string; account: string | null; a: string; b: string; c: string; d: string; px: number | null };

/** Turns the vault's logs of one stretch of blocks into rows. Amounts stay whole numbers, as text. */
export function rowsFromLogs(logs: any[], cfg = RECORDER_CONFIG): Row[] {
  const word = (l: any, i: number) => BigInt("0x" + (l.data.slice(2 + 64 * i, 66 + 64 * i) || "0")).toString();
  const signed = (l: any, i: number) => BigInt.asIntN(256, BigInt("0x" + (l.data.slice(2 + 64 * i, 66 + 64 * i) || "0"))).toString(); // a tick can be below zero
  const who = (t: string) => "0x" + t.slice(26).toLowerCase();
  // Hyperliquid's price in the same transaction, from the snapshot the vault emits at the end of every action
  const px = new Map<string, number>();
  for (const l of logs) if (l.topics[0] === TOPIC.snapshot) px.set(l.transactionHash, Number(BigInt("0x" + l.data.slice(2 + 128, 2 + 192))) / 10 ** cfg.pxDecimals);
  const out: Row[] = [];
  for (const l of logs) {
    if (l.removed) continue;
    const t = l.topics[0];
    let kind = "", account: string | null = null, n = 0;
    if (t === TOPIC.deposit) { kind = "deposit"; account = who(l.topics[2]); n = 2; }
    else if (t === TOPIC.withdraw) { kind = "withdraw"; account = who(l.topics[1]); n = 4; }
    else if (t === TOPIC.claimed) { kind = "claimed"; account = who(l.topics[1]); n = 1; }
    else if (t === TOPIC.fees) { kind = "fees"; n = 4; }
    else if (t === TOPIC.filled) { kind = "filled"; n = 4; } // a = the pool's tick then, b = the range's lower tick, c = its upper tick, d = liquidity added
    else continue;
    const v = [0, 1, 2, 3].map((i) => (i >= n ? "0" : kind === "filled" && i < 3 ? signed(l, i) : word(l, i)));
    out.push({
      vault: cfg.vault.toLowerCase(), block: Number(BigInt(l.blockNumber)), log_index: Number(BigInt(l.logIndex)),
      ts: new Date(Number(BigInt(l.blockTimestamp)) * 1000).toISOString(), tx: l.transactionHash, kind, account,
      a: v[0], b: v[1], c: v[2], d: v[3], px: px.get(l.transactionHash) ?? null,
    });
  }
  return out;
}

/** One run. `store` reads and writes where it has got to, and saves rows; `env` reads a setting. */
export async function runRecorder(deps: { fetch: typeof fetch; env: (k: string) => string | undefined; sleep?: (ms: number) => Promise<void>; load: () => Promise<number | null>; save: (block: number) => Promise<void>; write: (rows: Row[]) => Promise<void> }, cfg = RECORDER_CONFIG) {
  const report: any = { ok: true, time: new Date().toISOString(), status: "idle", from: null, to: null, head: null, events: 0, queries: 0 };
  if (deps.env("HEDGED_RECORDER_PAUSED") === "1") { report.status = "paused"; return report; }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = deps.env("HYPEREVM_RPC") || cfg.rpc;
  let last = 0;
  const rpc = async (method: string, params: unknown[]): Promise<any> => {
    const wait = last + cfg.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "liquid-reserve-history/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j: any = await r.json();
    // Told to slow down: this run ends here and the next one carries on. Asking again would only use up more of
    // what the bots need.
    if (j.error) throw new Error(`${method}: ${j.error.message ?? "RPC error"}`);
    return j.result;
  };
  let done = (await deps.load()) ?? cfg.fromBlock - 1;
  if (done < cfg.fromBlock - 1) done = cfg.fromBlock - 1;
  report.from = done + 1;
  if (cfg.startDelayMs > 0) await sleep(cfg.startDelayMs);
  let head: number;
  try {
    head = Number(BigInt(await rpc("eth_blockNumber", []))) - cfg.behind;
  } catch (e) {
    report.status = "waiting"; report.note = String((e as Error)?.message ?? e).slice(0, 160);
    return report;
  }
  report.head = head;
  while (done < head && report.queries < cfg.maxQueries) {
    const from = done + 1, to = Math.min(from + cfg.span - 1, head);
    let logs: any;
    try {
      logs = await rpc("eth_getLogs", [{ address: cfg.vault, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    } catch (e) {
      // the chain could not be read just now: keep what was done, say so, and let the next run carry on from here
      report.note = String((e as Error)?.message ?? e).slice(0, 160);
      break;
    }
    report.queries++;
    if (!Array.isArray(logs)) throw new Error("eth_getLogs gave no list");
    const rows = rowsFromLogs(logs, cfg);
    if (rows.length) await deps.write(rows); // saved before the place is moved on: a failure here is tried again next run
    await deps.save(to);
    done = to; report.to = to; report.events += rows.length;
  }
  report.behind = head - done;
  report.status = report.note ? "waiting" : report.events > 0 ? "recorded" : report.behind > 0 ? "catching-up" : "idle";
  return report;
}

// Under Deno (Supabase Edge Functions) this file serves; under Node (the test) it only offers the functions above.
const D = (globalThis as any).Deno;
if (D) {
  D.serve(async (_req: Request) => {
    const url = D.env.get("SUPABASE_URL"), key = D.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const headers = { apikey: key ?? "", authorization: `Bearer ${key}`, "content-type": "application/json" };
    let report: any;
    try {
      report = await runRecorder({
        fetch, env: (k: string) => D.env.get(k),
        load: async () => {
          const rows = await (await fetch(`${url}/rest/v1/keeper_state?key=eq.hedged-recorder&select=value`, { headers })).json();
          if (!Array.isArray(rows)) throw new Error("could not read where the recorder had got to");
          return typeof rows[0]?.value?.block === "number" ? rows[0].value.block : null;
        },
        save: async (block: number) => {
          const r = await fetch(`${url}/rest/v1/keeper_state`, { method: "POST", headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "hedged-recorder", value: { block }, updated_at: new Date().toISOString() }) });
          if (!r.ok) throw new Error(`could not save the place: ${r.status}`);
        },
        write: async (rows: Row[]) => {
          const r = await fetch(`${url}/rest/v1/hedged_events?on_conflict=vault,block,log_index`, { method: "POST", headers: { ...headers, prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows) });
          if (!r.ok) throw new Error(`could not save events: ${r.status} ${(await r.text()).slice(0, 120)}`);
        },
      });
    } catch (e) {
      report = { ok: false, time: new Date().toISOString(), status: "error", error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
  });
}
