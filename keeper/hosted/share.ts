// Liquid Reserve: the bot's creator-share job (runs inside "creator-keeper").
//
// Two splitters, each fixed for good, pay 20% to the creator's wallet:
//
//   VaultFeeSplit  the fee recipient of vaults launched after 17 November 2026:
//                  20% of their fee cut to the creator, 80% to the vault fee inbox (the reserve)
//   YieldSplit     where the reserve's yield contract points once the 48-hour timelock step is done:
//                  20% of reserve yield to the creator, 80% held for the rest of the yield plan
//
// Money that reaches a splitter waits there until someone calls it. This job does that: straight away when a
// token is worth passing on, and otherwise at least once a day for anything above dust. Until the contracts
// exist (and, for yield, until the yield contract points at YieldSplit) it does nothing.
//
// The HYPE staking vault (liquidHYPE) pays its fee, 20% of the staking yield, to the same VaultFeeSplit. That fee
// builds up inside the vault, in kHYPE, until someone calls collectFees(). This job makes that call when the fee is
// worth collecting (at once from about $1, otherwise at most once a day from about six cents), and the kHYPE that
// arrives is then paid out like any other vault fee.
//
// Anyone may make these calls; the money can only go to the splitters' fixed recipients.
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node (tests). ethers v5 is passed in.

export interface Lib { Wallet: any; utils: any }
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
/** min: pay out at once from this much. dust: ignore less than this. */
export interface ShareToken { sym: string; address: string; decimals: number; min: string; dust: string }
export interface ShareConfig {
  rpc: string;
  chainId: number;
  multicall: string;
  vaultFeeSplit: string;
  yieldWait: string;
  yieldSplit: string;
  /** Pay out anything above dust when a splitter has paid nothing for this long (PAYOUT_EVERY_HOURS changes it). */
  everySec: number;
  /** How far back to look for a splitter's last payout: comfortably more than a day of Elysium blocks. */
  lookbackBlocks: number;
  feeTokens: ShareToken[];
  yieldTokens: ShareToken[];
  /** The HYPE staking vault. `token` is the kHYPE its fee is paid in: `min` collects at once, `dust` is the least
   *  worth a collection of its own (about ten times the network fees of collecting and paying out). */
  staking?: { vault: string; token: ShareToken };
  rpcGapMs: number;
}
export const SHARE_CONFIG: ShareConfig = {
  rpc: "https://rpc.elysium.kinetiq.xyz",
  chainId: 99901,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  vaultFeeSplit: "0xB92c756347de468d7086a97EF112801b3371a408",
  yieldWait: "0xb99d0AFf4f65AC80c268a3050f72a107329909eE",
  yieldSplit: "0x5b1429a97818E68aF558CcD84cbDab5756520675",
  everySec: 86_400,
  lookbackBlocks: 700_000,
  // "min" is roughly $1 of each token, "dust" roughly a tenth of a cent
  feeTokens: [
    { sym: "WHYPE", address: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", decimals: 18, min: "0.015", dust: "0.00002" },
    { sym: "USDC", address: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65", decimals: 6, min: "1", dust: "0.001" },
    { sym: "KNTQ", address: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", decimals: 18, min: "4.5", dust: "0.005" },
    { sym: "$liquid", address: "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6", decimals: 18, min: "300000", dust: "300" },
    { sym: "kHYPE", address: "0x248888D396A546A69A188f3Deb476964e581E9d0", decimals: 18, min: "0.015", dust: "0.00002" }, // the staking vault's fee
    // the wANTx-USDC vault's fee in wANTx (about $87 each). The creator's fifth is paid out; the reserve's part goes
    // to the vault fee inbox, where it waits until the reserve has a route for wANTx (the timelock steps of
    // script/antx-route-data.py); from then on the reserve job converts it.
    { sym: "wANTx", address: "0xd7d0288Cef796cCc5752B4352f80b74aD2929334", decimals: 18, min: "0.012", dust: "0.00001" },
    // the wNVDAx-USDC vault's fee in wNVDAx (about $165 each). As with wANTx: the creator's fifth is paid out, and
    // the reserve's part waits in the vault fee inbox until the reserve has a route for wNVDAx (through the timelock).
    { sym: "wNVDAx", address: "0x11265018bF2d5a99fb71EFaE73aD670203C1dF44", decimals: 18, min: "0.006", dust: "0.000006" },
  ],
  yieldTokens: [
    { sym: "kHYPE", address: "0x248888D396A546A69A188f3Deb476964e581E9d0", decimals: 18, min: "0.015", dust: "0.000005" },
    { sym: "KNTQ", address: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", decimals: 18, min: "4.5", dust: "0.0005" },
  ],
  staking: {
    vault: "0x5B550c1DAd656B688Da2422baBb11470f5f419B0",
    token: { sym: "kHYPE", address: "0x248888D396A546A69A188f3Deb476964e581E9d0", decimals: 18, min: "0.015", dust: "0.001" },
  },
  rpcGapMs: 180,
};
export interface ShareAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface ShareReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  /** off: the splitters are not on-chain yet. idle: nothing to pay out. acted: paid out. */
  status: "off" | "idle" | "acted" | "waiting" | "paused";
  reason: string;
  /** What is sitting at each stage, as decimal strings. */
  holding?: Record<string, string>;
  actions: ShareAction[];
  warnings: string[];
  error?: string;
}

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const INBOX_ABI = ["function target() view returns (address)", "function forward(address token) returns (uint256)"];
const SPLIT_ABI = ["function recipientA() view returns (address)", "function distribute(address token) returns (uint256, uint256)", "event Distributed(address indexed token, uint256 toA, uint256 toB)"];
const STAKING_ABI = ["function pendingFees() view returns (uint256)", "function feeRecipient() view returns (address)", "function collectFees() returns (uint256)", "event FeesCollected(uint256 amount)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];

export async function runShare(deps: Deps, cfg: ShareConfig = SHARE_CONFIG): Promise<ShareReport> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: ShareReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("CREATOR_PAUSED") === "1") {
    report.mode = "paused"; report.status = "paused"; report.reason = "paused by its switch";
    return report;
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
  const dry = deps.env("DRY_RUN") === "1" || deps.env("CREATOR_DRY_RUN") === "1";
  report.mode = !wallet ? "watch-only" : dry ? "dry-run" : "live";
  report.keeper = wallet ? wallet.address : null;
  const rpcUrl = deps.env("ELYSIUM_RPC") || cfg.rpc;
  const everyHours = Number(deps.env("PAYOUT_EVERY_HOURS"));
  const everySec = everyHours > 0 ? everyHours * 3600 : cfg.everySec;

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
  const ERC20 = new utils.Interface(ERC20_ABI), INBOX = new utils.Interface(INBOX_ABI), SPLIT = new utils.Interface(SPLIT_ABI), STAKE = new utils.Interface(STAKING_ABI), MC = new utils.Interface(MULTICALL_ABI);
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const units = (v: bigint, t: ShareToken) => utils.formatUnits(v.toString(), t.decimals);
  const parse = (v: string, t: ShareToken) => BigInt(utils.parseUnits(v, t.decimals).toString());

  /** Simulates, signs, sends and waits. True when it went through. */
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
    let confirmed: boolean | null = null;
    for (let n = 0; n < 16 && confirmed === null; n++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) confirmed = r.status === "0x1";
    }
    report.actions.push({ what, tx, confirmed });
    if (confirmed === false) report.ok = false;
    return confirmed === true;
  }

  // ---- everything, in one request
  const F = cfg.feeTokens, Y = cfg.yieldTokens;
  const bal = (token: string, who: string) => ({ target: token, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [who]) });
  const calls = [
    { target: cfg.vaultFeeSplit, allowFailure: true, callData: SPLIT.encodeFunctionData("recipientA", []) }, // 0: does it exist?
    { target: cfg.yieldSplit, allowFailure: true, callData: SPLIT.encodeFunctionData("recipientA", []) }, // 1
    { target: cfg.yieldWait, allowFailure: true, callData: INBOX.encodeFunctionData("target", []) }, // 2
    ...F.map((t) => bal(t.address, cfg.vaultFeeSplit)), // 3 ..
    ...Y.map((t) => bal(t.address, cfg.yieldWait)),
    ...Y.map((t) => bal(t.address, cfg.yieldSplit)),
  ];
  // the staking vault, at the end so the positions above never move: the fee waiting in it, and where it pays
  const SK = cfg.staking, sk0 = calls.length;
  if (SK) calls.push({ target: SK.vault, allowFailure: true, callData: STAKE.encodeFunctionData("pendingFees", []) }, { target: SK.vault, allowFailure: true, callData: STAKE.encodeFunctionData("feeRecipient", []) });
  const [rows] = MC.decodeFunctionResult("aggregate3", await rpc("eth_call", [{ to: cfg.multicall, data: MC.encodeFunctionData("aggregate3", [calls]) }, "latest"]));
  const has = (i: number) => rows[i].success && rows[i].returnData.length >= 66;
  const num = (i: number) => (has(i) ? BigInt(rows[i].returnData) : 0n);
  const feeSplitLive = has(0), yieldSplitLive = has(1);
  const yieldPointed = has(2) && same("0x" + rows[2].returnData.slice(-40), cfg.yieldSplit);
  const atFee = F.map((_, i) => num(3 + i));
  const atWait = Y.map((_, i) => num(3 + F.length + i));
  const atSplit = Y.map((_, i) => num(3 + F.length + Y.length + i));
  // The staking vault counts only while it exists and pays the splitter this job serves.
  const stakeLive = !!SK && feeSplitLive && has(sk0) && has(sk0 + 1);
  const stakePaysSplit = stakeLive && same("0x" + rows[sk0 + 1].returnData.slice(-40), cfg.vaultFeeSplit);
  if (stakeLive && !stakePaysSplit) report.warnings.push("the staking vault's fee address is not the vault fee splitter; its fee is left alone");
  const atStake = stakePaysSplit ? num(sk0) : 0n;
  report.holding = {
    ...Object.fromEntries(F.map((t, i) => [`vault fees ${t.sym}`, units(atFee[i], t)])),
    ...Object.fromEntries(Y.map((t, i) => [`yield ${t.sym}`, units(atWait[i] + atSplit[i], t)])),
    ...(stakePaysSplit ? { [`staking fee ${SK!.token.sym}`]: units(atStake, SK!.token) } : {}),
  };
  if (!feeSplitLive && !(yieldSplitLive && yieldPointed)) {
    report.status = "off";
    report.reason = !feeSplitLive && !yieldSplitLive ? "the creator-share contracts are not on-chain yet" : "the reserve's yield does not point at the yield splitter yet (the 48-hour timelock step)";
    return report;
  }

  // ---- when did each splitter last pay out? Only asked when something small is waiting.
  const feeYield = yieldSplitLive && yieldPointed;
  const smallFee = feeSplitLive && F.some((t, i) => atFee[i] >= parse(t.dust, t) && atFee[i] < parse(t.min, t));
  const smallYield = feeYield && Y.some((t, i) => atWait[i] + atSplit[i] >= parse(t.dust, t) && atWait[i] + atSplit[i] < parse(t.min, t));
  const smallStake = stakePaysSplit && atStake >= parse(SK!.token.dust, SK!.token) && atStake < parse(SK!.token.min, SK!.token);
  let feeQuiet = false, yieldQuiet = false; // true when the splitter has paid nothing for `everySec`
  let stakeQuiet = false; // true when the staking vault's fee has not been collected for `everySec`
  if (smallFee || smallYield || smallStake) {
    const head = await rpc("eth_getBlockByNumber", ["latest", false]);
    const now = Number(head.timestamp), from = Math.max(0, Number(head.number) - cfg.lookbackBlocks);
    const logs: any[] = await rpc("eth_getLogs", [{ address: [cfg.vaultFeeSplit, cfg.yieldSplit], topics: [SPLIT.getEventTopic("Distributed")], fromBlock: hex(from), toBlock: "latest" }]);
    /** Time of a splitter's newest payout in the window, or 0 when there is none. */
    const last = async (addr: string) => {
      const mine = logs.filter((l) => same(l.address, addr));
      if (!mine.length) return 0;
      const newest = mine[mine.length - 1];
      // Elysium's RPC puts the block time on each log; if a node does not, ask for the block
      return Number(newest.blockTimestamp ?? (await rpc("eth_getBlockByNumber", [newest.blockNumber, false])).timestamp);
    };
    feeQuiet = now - (await last(cfg.vaultFeeSplit)) >= everySec;
    yieldQuiet = now - (await last(cfg.yieldSplit)) >= everySec;
    if (smallStake) {
      const got: any[] = await rpc("eth_getLogs", [{ address: SK!.vault, topics: [STAKE.getEventTopic("FeesCollected")], fromBlock: hex(from), toBlock: "latest" }]);
      const newest = got[got.length - 1];
      stakeQuiet = !newest || now - Number(newest.blockTimestamp ?? (await rpc("eth_getBlockByNumber", [newest.blockNumber, false])).timestamp) >= everySec;
    }
  }
  const due = (v: bigint, t: ShareToken, quiet: boolean) => v >= parse(t.min, t) || (quiet && v >= parse(t.dust, t));

  // ---- the staking vault's fee: collected into the splitter, then paid out below with the other vault fees
  let fresh = -1; // which fee token was just topped up by a collection, if any
  if (stakePaysSplit && due(atStake, SK!.token, stakeQuiet)) {
    if (await act(`collect ${units(atStake, SK!.token)} ${SK!.token.sym} of staking fee from the liquidHYPE vault`, SK!.vault, STAKE.encodeFunctionData("collectFees", []))) {
      fresh = F.findIndex((t) => same(t.address, SK!.token.address));
      if (fresh >= 0) atFee[fresh] += atStake;
    }
  }
  // ---- vault fees: 20% to the creator, 80% to the reserve
  if (feeSplitLive) {
    for (let i = 0; i < F.length; i++) {
      // what was collected a moment ago is paid out in the same run rather than left for tomorrow
      if (!(i === fresh && atFee[i] >= parse(F[i].dust, F[i])) && !due(atFee[i], F[i], feeQuiet)) continue;
      await act(`pay out ${units(atFee[i], F[i])} ${F[i].sym} of vault fees: 20% to the creator, 80% to the reserve`, cfg.vaultFeeSplit, SPLIT.encodeFunctionData("distribute", [F[i].address]));
    }
  }
  // ---- reserve yield: yield contract -> splitter -> 20% to the creator, 80% held
  if (feeYield) {
    for (let i = 0; i < Y.length; i++) {
      const total = atWait[i] + atSplit[i];
      if (!due(total, Y[i], yieldQuiet)) continue;
      if (atWait[i] > 0n && !(await act(`pass ${units(atWait[i], Y[i])} ${Y[i].sym} of reserve yield to the splitter`, cfg.yieldWait, INBOX.encodeFunctionData("forward", [Y[i].address]))) && atSplit[i] === 0n) continue;
      if (dry && atSplit[i] === 0n) continue; // the next step cannot be simulated until the first is really sent
      await act(`pay out ${units(total, Y[i])} ${Y[i].sym} of reserve yield: 20% to the creator, 80% held for the rest of the yield plan`, cfg.yieldSplit, SPLIT.encodeFunctionData("distribute", [Y[i].address]));
    }
  }
  const sent = report.actions.filter((a) => a.confirmed === true).length;
  report.status = sent > 0 ? "acted" : report.actions.length > 0 ? "waiting" : "idle";
  report.reason = sent > 0 ? "creator share paid out"
    : report.actions.length > 0 ? "a creator-share payout is ready but nothing was sent this run"
    : "nothing to pay out through the creator-share splitters yet";
  return report;
}
