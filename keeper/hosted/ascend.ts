// Liquid Reserve: the bot's Ascend job.
//
// The $liquid coin's creator fees are paid by Ascend to a "seat" contract whose
// recipient is the reserve's fee contract. That contract cannot call anything
// itself, and Ascend does not claim for recipients, so this job does it:
//
//   1. finds the coin by itself: any Ascend seat launched with the fee contract
//      as its first recipient (so nothing has to be configured after launch)
//   2. settle   moves trading fees from Ascend's launchpad into the coin's escrow
//   3. harvest  moves the released creator share from the escrow into the seat
//   4. claim    pays the recipient's share to the fee contract
//   5. pays the coin's other recipients (the creator's own wallet) their share too
//
// Anyone may make these calls; the money can only go to the fixed recipient.
// From the fee contract the reserve job takes over. A recipient that nobody
// claims for during 180 days can be removed by anyone, so the job also claims
// at least every 30 days, however small the amount.
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node
// (tests). ethers v5 is passed in.

export interface Lib { Wallet: any; utils: any }
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
export interface AscendConfig {
  rpc: string;
  chainId: number;
  multicall: string;
  seatFactory: string;
  launchpad: string;
  /** The recipient to look for: the reserve's fee contract. */
  payee: string;
  scanFromBlock: number;
  logChunk: number;
  maxChunksPerRun: number;
  /** Pair assets and the smallest amounts worth a transaction (roughly $3 to settle, $0.70 to claim). */
  quotes: Record<string, { sym: string; decimals: number; minSettle: string; minClaim: string }>;
  /** Claim at least this often, whatever the amount, to keep the recipient's place. */
  keepAliveDays: number;
  maxSeats: number;
  rpcGapMs: number;
}
export const ASCEND_CONFIG: AscendConfig = {
  rpc: "https://rpc.elysium.kinetiq.xyz",
  chainId: 99901,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  seatFactory: "0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1",
  launchpad: "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC",
  payee: "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c",
  scanFromBlock: 6_872_000, // 15 November 2026, before $liquid launched
  logChunk: 500_000,
  maxChunksPerRun: 6,
  quotes: {
    "0xba876237b0f021a6c6d852d6c26e107997cc5e81": { sym: "HYPE", decimals: 18, minSettle: "0.05", minClaim: "0.01" },
    "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0": { sym: "KNTQ", decimals: 18, minSettle: "15", minClaim: "3" },
    "0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65": { sym: "USDC", decimals: 6, minSettle: "3", minClaim: "0.7" },
  },
  keepAliveDays: 30,
  maxSeats: 3,
  rpcGapMs: 180,
};

/** Kept between runs by the caller. */
export interface AscendState { scanBlock?: number; seats: string[] }
export interface AscendAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface AscendReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  status: "no-coin" | "idle" | "acted" | "waiting" | "paused";
  reason: string;
  coins: { seat: string; pair: string; atAscend: string; releasedToSeat: string; claimable: string; lastClaimDaysAgo: number; daysUntilRemovable: number;
    /** The coin's other recipients (the creator's wallet): what is still waiting for each, and how long their place is safe. */
    recipients?: { account: string; sharePct: number; waiting: string; daysUntilRemovable: number }[] }[];
  actions: AscendAction[];
  warnings: string[];
  error?: string;
}

const FACTORY_ABI = ["event SeatDeployed(address indexed seat, address indexed deployer, address indexed primaryPayee, address devBuyTo, uint16 holderBpsQuote, uint16 holderBpsToken, uint16 buybackBps, bool burnBought, address[] payees, uint16[] bps, address[] exclusions)"];
const SEAT_ABI = [
  "function escrow() view returns (address)",
  "function quote() view returns (address)",
  "function poolId() view returns (bytes32)",
  "function claimable(uint256 i, bool t) view returns (uint256)",
  "function slot(uint256 i) view returns (address account, uint16 bps, address pending, uint40 lastSeen)",
  "function SUNSET_AFTER() view returns (uint256)",
  "function harvest()",
  "function claim(uint256 i, bool t) returns (uint256)",
];
const ESCROW_ABI = ["function settle()", "function claimable(address account) view returns (uint256)"];
const LAUNCHPAD_ABI = ["function accruedFees(bytes32 poolId) view returns (uint256)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];

export async function runAscend(deps: Deps, stateIn: AscendState | null, cfg: AscendConfig = ASCEND_CONFIG): Promise<{ report: AscendReport; state: AscendState }> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: AscendState = { scanBlock: stateIn?.scanBlock, seats: [...(stateIn?.seats ?? [])] };
  const report: AscendReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", coins: [], actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("ASCEND_PAUSED") === "1") {
    report.mode = "paused"; report.status = "paused"; report.reason = "paused by its switch";
    return { report, state };
  }

  // ---- wallet. The key is never logged, echoed or put in an error message.
  let wallet: any = null;
  const rawKey = (deps.env("KEEPER_PRIVATE_KEY") ?? "").trim();
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
    if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
      try { wallet = new Wallet(key); } catch { report.warnings.push("KEEPER_PRIVATE_KEY could not be used as a wallet key"); }
    } else report.warnings.push("KEEPER_PRIVATE_KEY is set but is not a 64-character hex key");
  }
  const dry = deps.env("DRY_RUN") === "1" || deps.env("ASCEND_DRY_RUN") === "1";
  report.mode = !wallet ? "watch-only" : dry ? "dry-run" : "live";
  report.keeper = wallet ? wallet.address : null;
  const rpcUrl = deps.env("ELYSIUM_RPC") || cfg.rpc;

  let lastCall = 0;
  async function rpc(method: string, params: unknown[] = [], tries = 0): Promise<any> {
    const wait = lastCall + cfg.rpcGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await deps.fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j: any = await res.json();
    if (j.error) {
      if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 4) { await sleep(1200); return rpc(method, params, tries + 1); }
      throw Object.assign(new Error(j.error.message ?? "RPC error"), { data: j.error.data, code: j.error.code });
    }
    return j.result;
  }
  const I = (abi: string[]) => new utils.Interface(abi);
  const FAC = I(FACTORY_ABI), SEAT = I(SEAT_ABI), ESC = I(ESCROW_ABI), LP = I(LAUNCHPAD_ABI), MC = I(MULTICALL_ABI);
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  async function multicall(calls: Call[]): Promise<any[]> {
    const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const [rows] = MC.decodeFunctionResult("aggregate3", await rpc("eth_call", [{ to: cfg.multicall, data }, "latest"]));
    return rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  }
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);

  async function act(what: string, to: string, data: string): Promise<boolean> {
    if (!wallet) { report.actions.push({ what, note: "ready, but no keeper wallet is configured" }); return false; }
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to, data }]));
    } catch (e: any) {
      report.actions.push({ what, note: `skipped: ${String(e?.message ?? e).slice(0, 140)}` });
      return false;
    }
    if (dry) { report.actions.push({ what, note: "dry run: would have been sent" }); return false; }
    const nonce = Number(await rpc("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (BigInt(await rpc("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data, nonce, gasLimit: hex((gas * 13n) / 10n), gasPrice: hex(gasPrice), chainId: cfg.chainId, value: 0, type: 0 });
    const tx = await rpc("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 16; i++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) {
        report.actions.push({ what, tx, confirmed: r.status === "0x1" });
        if (r.status !== "0x1") report.ok = false;
        return r.status === "0x1";
      }
    }
    report.actions.push({ what, tx, confirmed: null });
    return false;
  }

  // ---- 1. has a coin been launched with the fee contract as its recipient?
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const head = Number(latest.number), now = Number(latest.timestamp);
  const payeeTopic = utils.hexZeroPad(cfg.payee.toLowerCase(), 32);
  let from = (state.scanBlock ?? cfg.scanFromBlock - 1) + 1;
  for (let n = 0; from <= head && n < cfg.maxChunksPerRun; n++) {
    const to = Math.min(head, from + cfg.logChunk - 1);
    const logs = await rpc("eth_getLogs", [{ address: cfg.seatFactory, topics: [FAC.getEventTopic("SeatDeployed"), null, null, payeeTopic], fromBlock: hex(from), toBlock: hex(to) }]);
    for (const l of logs) {
      const seat = utils.getAddress("0x" + l.topics[1].slice(-40));
      if (!state.seats.includes(seat)) state.seats.push(seat);
    }
    state.scanBlock = to;
    from = to + 1;
  }
  if (!state.seats.length) {
    report.status = "no-coin";
    report.reason = "no Ascend coin has been launched with the reserve's fee contract as its recipient yet";
    return { report, state };
  }
  if (state.seats.length > cfg.maxSeats) report.warnings.push(`${state.seats.length} coins name the fee contract as their recipient; only the first ${cfg.maxSeats} are looked after`);

  // ---- 2. each coin: settle -> harvest -> claim, when worth it
  let toReserve = false, toOthers = false;
  for (const seat of state.seats.slice(0, cfg.maxSeats)) {
    const a = await multicall([
      { to: seat, iface: SEAT, fn: "escrow" }, { to: seat, iface: SEAT, fn: "quote" }, { to: seat, iface: SEAT, fn: "poolId" },
      { to: seat, iface: SEAT, fn: "slot", args: [0] }, { to: seat, iface: SEAT, fn: "SUNSET_AFTER" }, { to: seat, iface: SEAT, fn: "claimable", args: [0, false] },
    ]);
    if (a.slice(0, 5).some((x) => !x)) { report.warnings.push(`could not read the seat ${seat}`); continue; }
    const escrow = a[0][0], quote = String(a[1][0]).toLowerCase(), poolId = a[2][0], lastSeen = Number(a[3].lastSeen), sunsetAfter = Number(a[4][0]);
    if (String(a[3].account).toLowerCase() !== cfg.payee.toLowerCase()) { report.warnings.push(`the first recipient of ${seat} is no longer the fee contract`); continue; }
    const q = cfg.quotes[quote];
    if (!q) { report.warnings.push(`the coin at seat ${seat} is paired with an asset the reserve cannot use (${quote})`); continue; }
    const b = await multicall([{ to: cfg.launchpad, iface: LP, fn: "accruedFees", args: [poolId] }, { to: escrow, iface: ESC, fn: "claimable", args: [seat] }]);
    const big = (x: any) => BigInt((x?.[0] ?? 0).toString());
    const unit = (v: string) => BigInt(utils.parseUnits(v, q.decimals).toString());
    const fmt = (v: bigint) => `${utils.formatUnits(v.toString(), q.decimals)} ${q.sym}`;
    let atAscend = big(b[0]), released = big(b[1]), claimable = big(a[5]);
    const idleDays = (now - lastSeen) / 86400;
    const keepAlive = idleDays >= cfg.keepAliveDays;

    if (atAscend >= unit(q.minSettle) || (keepAlive && atAscend > 0n)) {
      if (await act(`settle ${fmt(atAscend)} of trading fees at Ascend`, escrow, ESC.encodeFunctionData("settle", []))) {
        released = big(await multicall([{ to: escrow, iface: ESC, fn: "claimable", args: [seat] }]).then((r) => r[0]));
        atAscend = 0n;
      }
    }
    if (released >= unit(q.minClaim) || (keepAlive && released > 0n)) {
      if (await act(`collect ${fmt(released)} of released creator fees into the coin's seat`, seat, SEAT.encodeFunctionData("harvest", []))) {
        claimable = big(await multicall([{ to: seat, iface: SEAT, fn: "claimable", args: [0, false] }]).then((r) => r[0]));
        released = 0n;
      }
    }
    if (claimable >= unit(q.minClaim) || (keepAlive && claimable > 0n)) {
      if (await act(`claim ${fmt(claimable)} for the reserve's fee contract`, seat, SEAT.encodeFunctionData("claim", [0, false]))) { claimable = 0n; toReserve = true; }
    }
    const left = (lastSeen + sunsetAfter - now) / 86400;
    if (left < 60) report.warnings.push(`the fee contract's place on the coin can be removed in ${Math.max(0, left).toFixed(0)} days unless a claim goes through`);

    // The coin's other recipients (the creator's own wallet): nobody claims for them either, so their share
    // would sit at Ascend. Anyone may make the claim and the money can only go to the recipient, so the job
    // pays them out too, each at the same point as the fee contract (the smallest claim, scaled to their share).
    // A claim made by someone else does NOT renew a plain wallet's place on the coin: only a claim sent from
    // that wallet does, so the job warns when one is due.
    const rest = await multicall([1, 2, 3].flatMap((i) => [{ to: seat, iface: SEAT, fn: "slot", args: [i] }, { to: seat, iface: SEAT, fn: "claimable", args: [i, false] }]));
    const share0 = BigInt(a[3].bps), recipients: { account: string; sharePct: number; waiting: string; daysUntilRemovable: number }[] = [];
    for (let k = 0; k < 3 && rest[2 * k]; k++) {
      const sl = rest[2 * k], account = utils.getAddress(sl.account), share = BigInt(sl.bps);
      let owed = big(rest[2 * k + 1]);
      const min = share0 > 0n ? (unit(q.minClaim) * share) / share0 : unit(q.minClaim);
      if (owed > 0n && owed >= min) {
        if (await act(`pay ${fmt(owed)} to the coin's recipient ${account}`, seat, SEAT.encodeFunctionData("claim", [k + 1, false]))) { owed = 0n; toOthers = true; }
      }
      const leftK = (Number(sl.lastSeen) + sunsetAfter - now) / 86400;
      if (leftK < 60) report.warnings.push(`${account} must send one claim from its own wallet within ${Math.max(0, leftK).toFixed(0)} days, or its place on the coin can be removed`);
      recipients.push({ account, sharePct: Number(share) / 100, waiting: fmt(owed), daysUntilRemovable: Math.round(leftK) });
    }
    report.coins.push({ seat, pair: q.sym, atAscend: fmt(atAscend), releasedToSeat: fmt(released), claimable: fmt(claimable), lastClaimDaysAgo: Math.round(idleDays * 10) / 10, daysUntilRemovable: Math.round(left), recipients });
  }

  const sent = report.actions.filter((x) => x.confirmed === true).length;
  report.status = sent > 0 ? "acted" : report.actions.length > 0 ? "waiting" : "idle";
  report.reason = sent > 0 ? `${sent} step${sent === 1 ? "" : "s"} done${toReserve ? "; the reserve's share is in its fee contract" : ""}${toOthers ? "; the other recipient was paid" : ""}`
    : report.actions.length > 0 ? "fees are ready but nothing was sent this run"
    : "the coin's fees are too small to be worth collecting yet";
  return { report, state };
}
