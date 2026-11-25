// Liquid Reserve: the bot's creator-cut job.
//
// The fee splitter sets 20% of everything aside in the creator's waiting
// contract. If the owner has pointed that contract at the reserve's allocator
// (a one-time, permanent choice), this job passes what collects there on, so it
// is bought, staked and locked like the rest. If the contract points anywhere
// else, or nowhere yet, this job does nothing.
//
// Anyone may make the call; the money can only go to the contract's fixed target.
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
export interface CreatorConfig {
  rpc: string;
  chainId: number;
  multicall: string;
  creatorWait: string;
  allocator: string;
  /** Pass a token on once at least this much has collected (roughly $1.40, so the fees of moving it stay small). */
  tokens: { sym: string; address: string; decimals: number; min: string }[];
  rpcGapMs: number;
}
export const CREATOR_CONFIG: CreatorConfig = {
  rpc: "https://rpc.elysium.kinetiq.xyz",
  chainId: 99901,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  creatorWait: "0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4",
  allocator: "0xB7c3865FfF8e88276a1D57D31869A2b0a839356f",
  tokens: [
    { sym: "WHYPE", address: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", decimals: 18, min: "0.02" },
    { sym: "USDC", address: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65", decimals: 6, min: "1.4" },
    { sym: "KNTQ", address: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", decimals: 18, min: "6" },
    { sym: "$liquid", address: "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6", decimals: 18, min: "400000" }, // from the HYPE-$liquid vault's fees; converted once the reserve has a $liquid route
    { sym: "kHYPE", address: "0x248888D396A546A69A188f3Deb476964e581E9d0", decimals: 18, min: "0.02" }, // from the staking vault's fee
    { sym: "wANTx", address: "0xd7d0288Cef796cCc5752B4352f80b74aD2929334", decimals: 18, min: "0.016" }, // from the wANTx-USDC vault's fees; none arrives here before the reserve has a wANTx route
    { sym: "wNVDAx", address: "0x11265018bF2d5a99fb71EFaE73aD670203C1dF44", decimals: 18, min: "0.0085" }, // from the wNVDAx-USDC vault's fees; none arrives here before the reserve has a wNVDAx route
  ],
  rpcGapMs: 180,
};
export interface CreatorAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface CreatorReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  /** off: the waiting contract does not point at the reserve. idle: nothing worth passing on. acted: passed on. */
  status: "off" | "idle" | "acted" | "waiting" | "paused";
  reason: string;
  waiting?: Record<string, string>;
  actions: CreatorAction[];
  warnings: string[];
  error?: string;
}

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const INBOX_ABI = ["function target() view returns (address)", "function forward(address token) returns (uint256)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];

export async function runCreator(deps: Deps, cfg: CreatorConfig = CREATOR_CONFIG): Promise<CreatorReport> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: CreatorReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
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
  const ERC20 = new utils.Interface(ERC20_ABI), INBOX = new utils.Interface(INBOX_ABI), MC = new utils.Interface(MULTICALL_ABI);
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);

  const calls = [{ target: cfg.creatorWait, allowFailure: true, callData: INBOX.encodeFunctionData("target", []) },
    ...cfg.tokens.map((t) => ({ target: t.address, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [cfg.creatorWait]) }))];
  const [rows] = MC.decodeFunctionResult("aggregate3", await rpc("eth_call", [{ to: cfg.multicall, data: MC.encodeFunctionData("aggregate3", [calls]) }, "latest"]));
  const target = rows[0].success && rows[0].returnData.length >= 66 ? "0x" + rows[0].returnData.slice(-40) : "";
  const bal = cfg.tokens.map((_, i) => (rows[i + 1].success && rows[i + 1].returnData.length >= 66 ? BigInt(rows[i + 1].returnData) : 0n));
  report.waiting = Object.fromEntries(cfg.tokens.map((t, i) => [t.sym, utils.formatUnits(bal[i].toString(), t.decimals)]));

  if (target.toLowerCase() !== cfg.allocator.toLowerCase()) {
    report.status = "off";
    report.reason = /^0x0{40}$/.test(target) ? "the creator's waiting contract has not been pointed anywhere; its share waits there" : "the creator's waiting contract does not point at the reserve";
    return report;
  }

  for (let i = 0; i < cfg.tokens.length; i++) {
    const t = cfg.tokens[i];
    if (bal[i] < BigInt(utils.parseUnits(t.min, t.decimals).toString())) continue;
    const what = `pass ${utils.formatUnits(bal[i].toString(), t.decimals)} ${t.sym} of creator cut on to the reserve`;
    if (!wallet) { report.actions.push({ what, note: "ready, but no keeper wallet is configured" }); continue; }
    const data = INBOX.encodeFunctionData("forward", [t.address]);
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to: cfg.creatorWait, data }]));
    } catch (e: any) {
      report.actions.push({ what, note: `skipped: ${String(e?.message ?? e).slice(0, 140)}` });
      continue;
    }
    if (dry) { report.actions.push({ what, note: "dry run: would have been sent" }); continue; }
    const nonce = Number(await rpc("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (BigInt(await rpc("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to: cfg.creatorWait, data, nonce, gasLimit: hex((gas * 13n) / 10n), gasPrice: hex(gasPrice), chainId: cfg.chainId, value: 0, type: 0 });
    const tx = await rpc("eth_sendRawTransaction", [raw]);
    let confirmed: boolean | null = null;
    for (let n = 0; n < 16 && confirmed === null; n++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) confirmed = r.status === "0x1";
    }
    report.actions.push({ what, tx, confirmed });
    if (confirmed === false) report.ok = false;
  }
  const sent = report.actions.filter((a) => a.confirmed === true).length;
  report.status = sent > 0 ? "acted" : report.actions.length > 0 ? "waiting" : "idle";
  report.reason = sent > 0 ? "creator cut passed on; the reserve job buys and locks it on its next run"
    : report.actions.length > 0 ? "creator cut is ready but nothing was sent this run"
    : "too little creator cut has collected to be worth passing on yet";
  return report;
}
