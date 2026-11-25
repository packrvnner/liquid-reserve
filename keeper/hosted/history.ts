// Liquid Reserve: price and range history for the vault pages.
//
// Every 5 minutes this records, in one Multicall3 read, each vault pool's price (its tick),
// Ascend's $liquid pool price, each vault's ranges and holdings, and the staking vault's
// holdings (liquidHYPE). A second read, on HyperEVM, records Kinetiq's own kHYPE rate once an hour:
// the Stake page's chart and its APY are worked out from that. The vault list comes
// from the live site's deployment.json, so new vaults are picked up without a redeploy.
// It holds no keys and sends no transactions.
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node (tests).
// ethers v5 is passed in.

export interface Lib { utils: any }
export interface HistoryConfig {
  rpc: string; multicall: string; stateView: string; deployment: string; rpcGapMs: number;
  /** HyperEVM, where Kinetiq keeps kHYPE's own rate (HYPE per kHYPE): StakingAccountant.kHYPEToHYPE. */
  hyperevmRpc: string; khypeAccountant: string;
}
export const HISTORY_CONFIG: HistoryConfig = {
  rpc: "https://rpc.elysium.kinetiq.xyz",
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE",
  deployment: "https://liquidreserve.xyz/deployment.json",
  rpcGapMs: 200,
  hyperevmRpc: "https://rpc.hyperliquid.xyz/evm",
  khypeAccountant: "0x9209648Ec9D448EF57116B73A2f081835643dc7A",
};
/** The staking vault (liquidHYPE) at one moment, in wei: kHYPE held for stakers, liquidHYPE in issue, the rate the
 *  vault values kHYPE at, and the fee waiting inside it. */
export interface StakeState { vault: string; ts: string; assets: string; supply: string; rate: string; fees: string }
/** Kinetiq's kHYPE rate at one moment, in wei. `ts` is the start of the hour it was read in, so there is one row an hour. */
export interface KhypeRate { ts: string; block: number; rate: string }
export interface PoolTick { pool: string; ts: string; tick: number }
export interface VaultState {
  vault: string; ts: string;
  main_lower: number; main_upper: number; main_liq: string;
  alt_lower: number; alt_upper: number; alt_liq: string;
  total0: string; total1: string; supply: string;
}

const MC_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function getCurrentBlockTimestamp() view returns (uint256)",
];
const SV_ABI = ["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"];
const VAULT_ABI = [
  "function main() view returns (int24 lower, int24 upper, uint128 liquidity)",
  "function alt() view returns (int24 lower, int24 upper, uint128 liquidity)",
  "function balances() view returns (uint256 total0, uint256 total1)",
  "function totalSupply() view returns (uint256)",
];
const STAKE_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function currentRate() view returns (uint256)",
  "function pendingFees() view returns (uint256)",
];
const ACCOUNTANT_ABI = ["function kHYPEToHYPE(uint256) view returns (uint256)"];
const isHex = (s: unknown, len: number) => typeof s === "string" && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(s);

/** Kinetiq's own kHYPE rate right now, read from HyperEVM in one request. */
export async function readKhypeRate(lib: Lib, fetchFn: typeof fetch, cfg: HistoryConfig = HISTORY_CONFIG, rpcUrl?: string): Promise<KhypeRate> {
  const { utils } = lib;
  const MC = new utils.Interface([...MC_ABI, "function getBlockNumber() view returns (uint256)"]), ACC = new utils.Interface(ACCOUNTANT_ABI);
  const one = "1000000000000000000";
  const calls = [
    { target: cfg.multicall, allowFailure: false, callData: MC.encodeFunctionData("getCurrentBlockTimestamp", []) },
    { target: cfg.multicall, allowFailure: false, callData: MC.encodeFunctionData("getBlockNumber", []) },
    { target: cfg.khypeAccountant, allowFailure: false, callData: ACC.encodeFunctionData("kHYPEToHYPE", [one]) },
  ];
  const res = await fetchFn(rpcUrl || cfg.hyperevmRpc, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: cfg.multicall, data: MC.encodeFunctionData("aggregate3", [calls]) }, "latest"] }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(j.error.message ?? "HyperEVM RPC error");
  const [rows] = MC.decodeFunctionResult("aggregate3", j.result);
  const num = (i: number) => BigInt(rows[i].returnData);
  const rate = num(2);
  // kHYPE started at exactly 1 HYPE and only gains; anything outside 1 to 2 is not a rate
  if (rate < 10n ** 18n || rate >= 2n * 10n ** 18n) throw new Error(`unexpected kHYPE rate ${rate}`);
  const hour = Math.floor(Number(num(0)) / 3600) * 3600;
  return { ts: new Date(hour * 1000).toISOString(), block: Number(num(1)), rate: rate.toString() };
}

/** One reading of every vault and pool the site lists. */
export async function readHistoryPoint(lib: Lib, fetchFn: typeof fetch, cfg: HistoryConfig = HISTORY_CONFIG, rpcUrl?: string) {
  const { utils } = lib;
  const dep: any = await (await fetchFn(cfg.deployment, { headers: { "cache-control": "no-cache" } })).json();
  const vaults = (dep.vaults ?? []).filter((v: any) => isHex(v.address, 40) && isHex(v.pool, 64));
  const pools = [...new Set<string>([...vaults.map((v: any) => v.pool.toLowerCase()), ...(isHex(dep.pools?.liquidHype, 64) ? [dep.pools.liquidHype.toLowerCase()] : [])])];
  const MC = new utils.Interface(MC_ABI), SV = new utils.Interface(SV_ABI), V = new utils.Interface(VAULT_ABI), SK = new utils.Interface(STAKE_ABI);
  const staking: string | null = isHex(dep.elysium?.staking?.vault, 40) ? dep.elysium.staking.vault.toLowerCase() : null;
  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  const add = (target: string, iface: any, fn: string, args: unknown[] = []) => calls.push({ target, allowFailure: true, callData: iface.encodeFunctionData(fn, args) }) - 1;
  const clock = add(cfg.multicall, MC, "getCurrentBlockTimestamp");
  const poolIdx = pools.map((p) => add(cfg.stateView, SV, "getSlot0", [p]));
  const vaultIdx = vaults.map((v: any) => ["main", "alt", "balances", "totalSupply"].map((fn) => add(v.address, V, fn)));
  const STAKE_FNS = ["totalAssets", "totalSupply", "currentRate", "pendingFees"];
  const stakeIdx = staking ? STAKE_FNS.map((fn) => add(staking, SK, fn)) : [];
  const res = await fetchFn(rpcUrl || cfg.rpc, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: cfg.multicall, data: MC.encodeFunctionData("aggregate3", [calls]) }, "latest"] }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(j.error.message ?? "RPC error");
  const [rows] = MC.decodeFunctionResult("aggregate3", j.result);
  const out = (i: number, iface: any, fn: string) => (rows[i].success && rows[i].returnData !== "0x" ? iface.decodeFunctionResult(fn, rows[i].returnData) : null);
  const ts = new Date(Number(out(clock, MC, "getCurrentBlockTimestamp")[0].toString()) * 1000).toISOString();

  const ticks: PoolTick[] = [];
  pools.forEach((p, i) => {
    const s = out(poolIdx[i], SV, "getSlot0");
    if (s && s.sqrtPriceX96.toString() !== "0") ticks.push({ pool: p, ts, tick: Number(s.tick) });
  });
  const states: VaultState[] = [];
  vaults.forEach((v: any, i: number) => {
    const [m, a, b, s] = vaultIdx[i].map((k: number, n: number) => out(k, V, ["main", "alt", "balances", "totalSupply"][n]));
    if (!m || !a || !b || !s) return; // not deployed yet
    states.push({
      vault: v.address.toLowerCase(), ts,
      main_lower: Number(m.lower), main_upper: Number(m.upper), main_liq: m.liquidity.toString(),
      alt_lower: Number(a.lower), alt_upper: Number(a.upper), alt_liq: a.liquidity.toString(),
      total0: b.total0.toString(), total1: b.total1.toString(), supply: s[0].toString(),
    });
  });
  // the staking vault, once it exists
  const stakes: StakeState[] = [];
  if (staking) {
    const [a, n, r, f] = stakeIdx.map((k, i) => out(k, SK, STAKE_FNS[i]));
    if (a && n && r && f) stakes.push({ vault: staking, ts, assets: a[0].toString(), supply: n[0].toString(), rate: r[0].toString(), fees: f[0].toString() });
  }
  return { ts, ticks, states, stakes };
}
