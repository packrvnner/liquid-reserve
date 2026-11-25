// Liquid Reserve: the bot's treasury job. It looks after the bot's own wallet,
// so the owner never has to send a particular token to a particular place.
//
//   Tokens sent to the bot wallet go into the reserve:
//     Elysium   WHYPE, USDC or KNTQ  -> the vault fee contract (then 20% creator / 80% reserve, as fees do)
//     HyperEVM  KNTQ                 -> StakeAndLock (staked as sKNTQ and locked)
//   Plain HYPE is the bot's fuel and is never locked, unless the owner sets
//   FUEL_KEEP_HYPE: then the bot keeps that much HYPE on Elysium and sends the
//   rest into the fee contract (wrapped, in one transaction).
//
//   Fuel is kept on both chains:
//     Elysium low, HyperEVM has spare   -> deposit HYPE through the bridge's inbox (arrives in minutes)
//     HyperEVM low, Elysium has spare   -> withdraw HYPE through the bridge (arrives after the bridge
//                                          confirms it, a day or more; the HyperEVM job claims it)
//
// Tokens other than these have no price route in the reserve's swap contracts,
// so the bot leaves them where they are and says so.
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
export interface TreasuryConfig {
  elysium: { rpc: string; chainId: number; multicall: string; feeInbox: string; feeSplitter: string; rpcGapMs: number; tokens: { sym: string; address: string; decimals: number; min: string }[] };
  hyperevm: { rpc: string; chainId: number; inbox: string; kntq: string; stakeAndLock: string; minKntq: string; rpcGapMs: number };
  /** Top up a chain when the bot holds less HYPE than this there... */
  lowElysium: string;
  lowHyperevm: string;
  /** ...by this much, as long as the other chain keeps at least this much afterwards. */
  topUp: string;
  keepElysium: string;
  keepHyperevm: string;
}
export const TREASURY_CONFIG: TreasuryConfig = {
  elysium: {
    rpc: "https://rpc.elysium.kinetiq.xyz",
    chainId: 99901,
    multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
    feeInbox: "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c",
    feeSplitter: "0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e",
    rpcGapMs: 180,
    tokens: [
      { sym: "WHYPE", address: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", decimals: 18, min: "0.002" },
      { sym: "USDC", address: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65", decimals: 6, min: "0.1" },
      { sym: "KNTQ", address: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", decimals: 18, min: "0.5" },
    ],
  },
  hyperevm: {
    rpc: "https://rpc.hyperliquid.xyz/evm",
    chainId: 999,
    inbox: "0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff",
    kntq: "0x000000000000780555bD0BCA3791f89f9542c2d6",
    stakeAndLock: "0x06C9A2581BD8EA1ace6ada407F4289c932C7e060",
    minKntq: "1",
    rpcGapMs: 700,
  },
  lowElysium: "0.03",
  lowHyperevm: "0.005",
  topUp: "0.02",
  keepElysium: "0.05",
  keepHyperevm: "0.01",
};

export interface TreasuryAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface TreasuryReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  status: "idle" | "acted" | "waiting" | "paused";
  reason: string;
  fuel?: { elysium: string; hyperevm: string };
  actions: TreasuryAction[];
  warnings: string[];
  error?: string;
}

const ARB_SYS = "0x0000000000000000000000000000000000000064";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];
const INBOX_ABI = ["function target() view returns (address)"];
const WHYPE_ABI = ["function deposit() payable"];
const ARBSYS_ABI = ["function withdrawEth(address destination) payable returns (uint256)"];
const BRIDGE_INBOX_ABI = ["function depositEth() payable returns (uint256)"];
const MULTICALL_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
];

/**
 * @param fuelInFlight true while an earlier Elysium -> HyperEVM fuel withdrawal has not been claimed yet
 * @returns the report, and the Elysium transaction hash of a new fuel withdrawal for the HyperEVM job to claim
 */
export async function runTreasury(deps: Deps, fuelInFlight: boolean, cfg: TreasuryConfig = TREASURY_CONFIG): Promise<{ report: TreasuryReport; fuelWithdrawal?: string }> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: TreasuryReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("TREASURY_PAUSED") === "1") {
    report.mode = "paused"; report.status = "paused"; report.reason = "paused by its switch";
    return { report };
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
  if (!wallet) { report.reason = "no keeper wallet is configured, so there is no wallet to look after"; return { report }; }
  const dry = deps.env("DRY_RUN") === "1" || deps.env("TREASURY_DRY_RUN") === "1";
  report.mode = dry ? "dry-run" : "live";
  report.keeper = wallet.address;
  const me = wallet.address;

  function client(url: string, gapMs: number) {
    let last = 0;
    return async function rpc(method: string, params: unknown[] = [], tries = 0): Promise<any> {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j: any = await res.json();
      if (j.error) {
        if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 4) { await sleep(1500); return rpc(method, params, tries + 1); }
        throw Object.assign(new Error(j.error.message ?? "RPC error"), { data: j.error.data, code: j.error.code });
      }
      return j.result;
    };
  }
  const e = cfg.elysium, h = cfg.hyperevm;
  const E = client(deps.env("ELYSIUM_RPC") || e.rpc, e.rpcGapMs);
  const H = client(deps.env("HYPEREVM_RPC") || h.rpc, h.rpcGapMs);
  const I = (abi: string[]) => new utils.Interface(abi);
  const ERC20 = I(ERC20_ABI), INBOX = I(INBOX_ABI), WH = I(WHYPE_ABI), SYS = I(ARBSYS_ABI), BIN = I(BRIDGE_INBOX_ABI), MC = I(MULTICALL_ABI);
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const wei = (v: string, d = 18) => BigInt(utils.parseUnits(v, d).toString());
  const fmt = (v: bigint, d = 18) => utils.formatUnits(v.toString(), d);

  /** Simulate, sign, send, wait. Returns the transaction hash when it confirmed. */
  async function act(chain: "elysium" | "hyperevm", what: string, to: string, data: string, value: bigint = 0n): Promise<string | null> {
    const rpc = chain === "elysium" ? E : H, chainId = chain === "elysium" ? e.chainId : h.chainId;
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: me, to, data, value: hex(value) }]));
    } catch (err: any) {
      report.actions.push({ what, note: `skipped: ${String(err?.message ?? err).slice(0, 140)}` });
      return null;
    }
    if (dry) { report.actions.push({ what, note: "dry run: would have been sent" }); return null; }
    let limit = (gas * 13n) / 10n;
    if (chain === "hyperevm" && limit > 2_900_000n) limit = 2_900_000n;
    const nonce = Number(await rpc("eth_getTransactionCount", [me, "pending"]));
    const gasPrice = (BigInt(await rpc("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data, nonce, gasLimit: hex(limit), gasPrice: hex(gasPrice), chainId, value: hex(value), type: 0 });
    const tx = await rpc("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) {
        report.actions.push({ what, tx, confirmed: r.status === "0x1" });
        if (r.status !== "0x1") report.ok = false;
        return r.status === "0x1" ? tx : null;
      }
    }
    report.actions.push({ what, tx, confirmed: null });
    return null;
  }

  // ---- what the wallet holds
  const calls = [{ target: e.feeInbox, allowFailure: true, callData: INBOX.encodeFunctionData("target", []) },
    ...e.tokens.map((t) => ({ target: t.address, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [me]) }))];
  const [rows] = MC.decodeFunctionResult("aggregate3", await E("eth_call", [{ to: e.multicall, data: MC.encodeFunctionData("aggregate3", [calls]) }, "latest"]));
  const connected = rows[0].success && rows[0].returnData.length >= 66 && ("0x" + rows[0].returnData.slice(-40)).toLowerCase() === e.feeSplitter.toLowerCase();
  const tokenBal = e.tokens.map((_, i) => (rows[i + 1].success && rows[i + 1].returnData.length >= 66 ? BigInt(rows[i + 1].returnData) : 0n));
  let fuelE = BigInt(await E("eth_getBalance", [me, "latest"]));
  let fuelH = BigInt(await H("eth_getBalance", [me, "latest"]));
  const kntqH = BigInt(await H("eth_call", [{ to: h.kntq, data: ERC20.encodeFunctionData("balanceOf", [me]) }, "latest"]));
  report.fuel = { elysium: fmt(fuelE), hyperevm: fmt(fuelH) };

  // ---- 1. tokens sent to the bot wallet go into the reserve
  for (let i = 0; i < e.tokens.length; i++) {
    const t = e.tokens[i], bal = tokenBal[i];
    if (bal < wei(t.min, t.decimals)) continue;
    if (!connected) { report.actions.push({ what: `send ${fmt(bal, t.decimals)} ${t.sym} into the fee contract`, note: "skipped: the fee contract is not connected to the reserve" }); continue; }
    await act("elysium", `send ${fmt(bal, t.decimals)} ${t.sym} from the bot wallet into the fee contract`, t.address, ERC20.encodeFunctionData("transfer", [e.feeInbox, bal.toString()]));
  }
  if (kntqH >= wei(h.minKntq)) await act("hyperevm", `send ${fmt(kntqH)} KNTQ from the bot wallet to be staked and locked on HyperEVM`, h.kntq, ERC20.encodeFunctionData("transfer", [h.stakeAndLock, kntqH.toString()]));

  // ---- 2. only if the owner asked for it: HYPE above the fuel level goes into the reserve too
  const keepRaw = (deps.env("FUEL_KEEP_HYPE") ?? "").trim();
  if (keepRaw) {
    if (!/^\d+(\.\d{1,18})?$/.test(keepRaw) || wei(keepRaw) < wei(cfg.keepElysium)) report.warnings.push(`FUEL_KEEP_HYPE must be a number of at least ${cfg.keepElysium}; ignoring it`);
    else if (connected && fuelE > wei(keepRaw) + wei("0.01")) {
      const extra = fuelE - wei(keepRaw);
      const wrapAndSend = MC.encodeFunctionData("aggregate3Value", [[
        { target: e.tokens[0].address, allowFailure: false, value: extra.toString(), callData: WH.encodeFunctionData("deposit", []) },
        { target: e.tokens[0].address, allowFailure: false, value: 0, callData: ERC20.encodeFunctionData("transfer", [e.feeInbox, extra.toString()]) },
      ]]);
      if (await act("elysium", `send ${fmt(extra)} HYPE above the ${keepRaw} HYPE fuel level into the fee contract`, e.multicall, wrapAndSend, extra)) fuelE -= extra;
    }
  }

  // ---- 3. keep fuel on both chains
  const top = wei(cfg.topUp);
  let fuelWithdrawal: string | undefined;
  if (fuelE < wei(cfg.lowElysium)) {
    if (fuelH >= top + wei(cfg.keepHyperevm)) await act("hyperevm", `move ${cfg.topUp} HYPE of fuel from HyperEVM to Elysium`, h.inbox, BIN.encodeFunctionData("depositEth", []), top);
    else report.warnings.push(`the bot wallet is low on HYPE on Elysium (${fmt(fuelE)}) and has too little on HyperEVM to top it up`);
  } else if (fuelH < wei(cfg.lowHyperevm)) {
    if (fuelInFlight) report.actions.push({ what: `move ${cfg.topUp} HYPE of fuel from Elysium to HyperEVM`, note: "already on its way; it arrives once the bridge confirms it" });
    else if (fuelE >= top + wei(cfg.keepElysium)) {
      const tx = await act("elysium", `move ${cfg.topUp} HYPE of fuel from Elysium to HyperEVM (arrives after the bridge confirms it)`, ARB_SYS, SYS.encodeFunctionData("withdrawEth", [me]), top);
      if (tx) fuelWithdrawal = tx;
    } else report.warnings.push(`the bot wallet is low on HYPE on HyperEVM (${fmt(fuelH)}) and has too little on Elysium to top it up`);
  }

  const sent = report.actions.filter((a) => a.confirmed === true).length;
  report.status = sent > 0 ? "acted" : report.actions.length > 0 ? "waiting" : "idle";
  report.reason = sent > 0 ? `${sent} step${sent === 1 ? "" : "s"} done` : report.actions.length > 0 ? "something is ready or on its way; nothing was sent this run" : "nothing to do: no tokens in the bot wallet and fuel is fine on both chains";
  return { report, fuelWithdrawal };
}
