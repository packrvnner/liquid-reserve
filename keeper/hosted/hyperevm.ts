// Liquid Reserve: the bot's HyperEVM job.
//
// The KNTQ share of the reserve leaves Elysium through the canonical bridge.
// This job finishes the trip and looks after the staked side:
//
//   1. claim   each KNTQ batch on HyperEVM's outbox once the bridge has confirmed it
//              (a day or more after it left Elysium; the bridge's confirmation period was
//              5.6 days until November 2026 and is 1 day now); the KNTQ lands in StakeAndLock
//   2. stake   StakeAndLock.stake(): KNTQ -> sKNTQ, locked in the HyperEVM reserve
//   3. yield   at least once a day: harvest what the locked sKNTQ has earned, unstake it
//              (7 days), and bridge the KNTQ back to Elysium's yield contract. Each day's
//              yield therefore reaches Elysium about a week later, one day after another.
//
// Everything it calls is permissionless and can only move funds along that
// fixed path. It keeps a small state (which Elysium blocks it has scanned and
// which batches are still unclaimed) that the caller stores between runs.
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
export interface HyperConfig {
  elysium: { rpc: string; bridgeOut: string; scanFromBlock: number; logChunk: number; maxChunksPerRun: number; rpcGapMs: number };
  hyperevm: {
    rpc: string; chainId: number; multicall: string; rollup: string; outbox: string; inbox: string;
    kntq: string; skntq: string; reserve: string; stakeAndLock: string; yieldBridge: string; rpcGapMs: number;
  };
  /** Stake once at least this much KNTQ has arrived. */
  minStakeKntq: string;
  /** Ignore yield smaller than this much KNTQ (dust). */
  minYieldKntq: string;
  /** Collect the yield at least this often, counted from the last time KNTQ was locked or yield was collected. */
  yieldEverySec: number;
  /** Warn when the bot holds less HYPE than this on HyperEVM. */
  minGasHype: string;
  maxClaimsPerRun: number;
}
export const HYPER_CONFIG: HyperConfig = {
  elysium: {
    rpc: "https://rpc.elysium.kinetiq.xyz",
    bridgeOut: "0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4",
    scanFromBlock: 6_860_000, // just before the reserve was launched
    logChunk: 500_000,
    maxChunksPerRun: 6,
    rpcGapMs: 180,
  },
  hyperevm: {
    rpc: "https://rpc.hyperliquid.xyz/evm",
    chainId: 999,
    multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
    rollup: "0x508C173dFe5F737B3493195Bf785d71fA76fD217",
    outbox: "0xeC6B106DfA14428FE5Eec2a4065a7be599f02728",
    inbox: "0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff",
    kntq: "0x000000000000780555bD0BCA3791f89f9542c2d6",
    skntq: "0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F",
    reserve: "0x394f6103B88D4DEB3A9686991C0dE24F968094A6",
    stakeAndLock: "0x06C9A2581BD8EA1ace6ada407F4289c932C7e060",
    yieldBridge: "0x38Cc13C526834b73290AD1ae59335D628DF3ac47",
    rpcGapMs: 700, // the public HyperEVM RPC allows about 100 requests a minute
  },
  minStakeKntq: "1",
  minYieldKntq: "0.0005",
  yieldEverySec: 86_400,
  minGasHype: "0.002",
  maxClaimsPerRun: 3,
};

/** Kept between runs by the caller. */
export interface HyperState {
  /** Last Elysium block scanned for KNTQ batches leaving through the bridge. */
  scanBlock?: number;
  /** Elysium transaction hash of each batch -> has it been claimed on HyperEVM? */
  withdrawals: Record<string, "PENDING" | "EXECUTED">;
}
export interface HyperAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface HyperReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  gasHype?: string;
  status: "not-deployed" | "idle" | "waiting" | "acted" | "paused";
  reason: string;
  /** KNTQ batches on their way: where each one stands. */
  batches: { tx: string; position?: string; state: "not confirmed yet" | "ready to claim" | "claimed" | "unreadable" }[];
  holdings?: { kntqToStake: string; skntqLocked: string; lockedValueKntq: string; yieldPendingKntq: string; yieldUnstaking: string; kntqToBridgeBack: string };
  actions: HyperAction[];
  warnings: string[];
  error?: string;
}

const ARB_SYS = "0x0000000000000000000000000000000000000064";
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const BRIDGE_OUT_ABI = ["event Bridged(uint256 amount, address indexed l1Recipient)"];
const ARBSYS_ABI = ["event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)"];
const NODE_ABI = ["function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)"];
const OUTBOX_ABI = [
  "function isSpent(uint256 index) view returns (bool)",
  "function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)",
];
const ROLLUP_ABI = [
  "function latestConfirmed() view returns (bytes32)",
  "function getAssertion(bytes32 assertionHash) view returns (tuple(uint64 firstChildBlock, uint64 secondChildBlock, uint64 createdAtBlock, bool isFirstChild, uint8 status, bytes32 configHash))",
  "event AssertionCreated(bytes32 indexed assertionHash, bytes32 indexed parentAssertionHash, tuple(tuple(bytes32 prevPrevAssertionHash, bytes32 sequencerBatchAcc, tuple(bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks, uint64 nextInboxPosition) configData) beforeStateData, tuple(tuple(bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus, bytes32 endHistoryRoot) beforeState, tuple(tuple(bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus, bytes32 endHistoryRoot) afterState) assertion, bytes32 afterInboxBatchAcc, uint256 inboxMaxCount, bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks)",
];
const INBOX_ABI = ["function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)"];
const RESERVE_ABI = ["function principal(address) view returns (uint256)", "function valueOf(address) view returns (uint256)", "function pendingYield(address) view returns (uint256)", "function checkpoints(address) view returns (uint192 rate, uint64 time)", "function harvest(address asset) returns (uint256)"];
const STAKE_ABI = ["function stake() returns (uint256)"];
const SKNTQ_ABI = [
  "function withdrawalDelay() view returns (uint256)",
  "function nextWithdrawalRequestId(address owner) view returns (uint256)",
  "function withdrawalRequest(address owner, uint256 id) view returns (uint256 assets, uint256 shares, uint256 timestamp)",
];
const YIELD_ABI = [
  "function minGas() view returns (uint256)",
  "function minGasPrice() view returns (uint256)",
  "function requestUnstake() returns (uint256, uint256)",
  "function confirm(uint256 requestId) returns (uint256)",
  "function bridge(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost) payable returns (uint256)",
];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];

/** One Elysium -> HyperEVM message, read from the ArbSys event in the Elysium transaction. */
export interface Withdrawal { position: bigint; caller: string; destination: string; arbBlockNum: string; ethBlockNum: string; timestamp: string; callvalue: string; data: string }

export async function runHyperEvm(deps: Deps, stateIn: HyperState | null, cfg: HyperConfig = HYPER_CONFIG): Promise<{ report: HyperReport; state: HyperState }> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: HyperState = { scanBlock: stateIn?.scanBlock, withdrawals: { ...(stateIn?.withdrawals ?? {}) } };
  const report: HyperReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", batches: [], actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("HYPEREVM_PAUSED") === "1") {
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
  const dry = deps.env("DRY_RUN") === "1" || deps.env("HYPEREVM_DRY_RUN") === "1";
  report.mode = !wallet ? "watch-only" : dry ? "dry-run" : "live";
  report.keeper = wallet ? wallet.address : null;

  // ---- JSON-RPC to both chains, each paced for its public endpoint
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
  const E = client(deps.env("ELYSIUM_RPC") || cfg.elysium.rpc, cfg.elysium.rpcGapMs);
  const H = client(deps.env("HYPEREVM_RPC") || cfg.hyperevm.rpc, cfg.hyperevm.rpcGapMs);
  const I = (abi: string[]) => new utils.Interface(abi);
  const ERC20 = I(ERC20_ABI), BO = I(BRIDGE_OUT_ABI), SYS = I(ARBSYS_ABI), NODE = I(NODE_ABI), OUT = I(OUTBOX_ABI), ROLL = I(ROLLUP_ABI), INBOX = I(INBOX_ABI);
  const RES = I(RESERVE_ABI), STK = I(STAKE_ABI), SK = I(SKNTQ_ABI), YB = I(YIELD_ABI), MC = I(MULTICALL_ABI);
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const h = cfg.hyperevm;
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  async function multicall(calls: Call[]): Promise<any[]> {
    const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const [rows] = MC.decodeFunctionResult("aggregate3", await H("eth_call", [{ to: h.multicall, data }, "latest"]));
    return rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  }
  const call = async (rpc: typeof H, to: string, iface: any, fn: string, args: unknown[] = []) => iface.decodeFunctionResult(fn, await rpc("eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"]));
  const kntq = (v: bigint) => utils.formatUnits(v.toString(), 18);
  const parse = (v: string) => BigInt(utils.parseUnits(v, 18).toString());

  // ---- simulate, sign, send, wait (HyperEVM)
  let gasBalance = 0n;
  async function act(what: string, to: string, data: string, value: bigint = 0n): Promise<boolean> {
    if (!wallet) { report.actions.push({ what, note: "ready, but no keeper wallet is configured" }); return false; }
    let gas: bigint;
    try {
      gas = BigInt(await H("eth_estimateGas", [{ from: wallet.address, to, data, value: hex(value) }]));
    } catch (e: any) {
      const low = gasBalance < parse(cfg.minGasHype);
      report.actions.push({ what, note: low ? "skipped: the bot wallet needs HYPE on HyperEVM" : `skipped: ${String(e?.message ?? e).slice(0, 140)}` });
      return false;
    }
    if (dry) { report.actions.push({ what, note: "dry run: would have been sent" }); return false; }
    let limit = (gas * 13n) / 10n;
    if (limit > 2_900_000n) limit = 2_900_000n; // HyperEVM's fast blocks hold 3,000,000 gas
    const nonce = Number(await H("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (BigInt(await H("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data, nonce, gasLimit: hex(limit), gasPrice: hex(gasPrice), chainId: h.chainId, value: hex(value), type: 0 });
    const tx = await H("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await H("eth_getTransactionReceipt", [tx]);
      if (r) {
        report.actions.push({ what, tx, confirmed: r.status === "0x1" });
        if (r.status !== "0x1") report.ok = false;
        return r.status === "0x1";
      }
    }
    report.actions.push({ what, tx, confirmed: null });
    return false;
  }

  // ---- 1. which KNTQ batches have left Elysium? (new ones since the last run)
  const head = Number(await E("eth_blockNumber"));
  let from = (state.scanBlock ?? cfg.elysium.scanFromBlock - 1) + 1;
  for (let n = 0; from <= head && n < cfg.elysium.maxChunksPerRun; n++) {
    const to = Math.min(head, from + cfg.elysium.logChunk - 1);
    const logs = await E("eth_getLogs", [{ address: cfg.elysium.bridgeOut, topics: [BO.getEventTopic("Bridged")], fromBlock: hex(from), toBlock: hex(to) }]);
    for (const l of logs) state.withdrawals[l.transactionHash] ??= "PENDING";
    state.scanBlock = to;
    from = to + 1;
  }

  // ---- 2. where things stand on HyperEVM, in one request
  const res = await multicall([
    { to: h.kntq, iface: ERC20, fn: "balanceOf", args: [h.stakeAndLock] }, // 0
    { to: h.skntq, iface: ERC20, fn: "balanceOf", args: [h.reserve] }, // 1
    { to: h.reserve, iface: RES, fn: "valueOf", args: [h.skntq] }, // 2
    { to: h.reserve, iface: RES, fn: "pendingYield", args: [h.skntq] }, // 3
    { to: h.skntq, iface: ERC20, fn: "balanceOf", args: [h.yieldBridge] }, // 4
    { to: h.kntq, iface: ERC20, fn: "balanceOf", args: [h.yieldBridge] }, // 5
    { to: h.skntq, iface: SK, fn: "nextWithdrawalRequestId", args: [h.yieldBridge] }, // 6
    { to: h.skntq, iface: SK, fn: "withdrawalDelay" }, // 7
    { to: h.yieldBridge, iface: YB, fn: "minGas" }, // 8
    { to: h.yieldBridge, iface: YB, fn: "minGasPrice" }, // 9
    { to: h.reserve, iface: RES, fn: "checkpoints", args: [h.skntq] }, // 10: when KNTQ was last locked or yield last collected
  ]);
  if (!res[2] || !res[8]) { report.status = "not-deployed"; report.reason = "the HyperEVM reserve contracts are not on-chain"; return { report, state }; }
  const big = (i: number) => BigInt((res[i]?.[0] ?? 0).toString());
  let kntqToStake = big(0);
  const yieldPending = big(3), skntqAtBridge = big(4), kntqAtBridge = big(5), nextId = Number(big(6)), delay = Number(big(7));
  if (wallet) {
    gasBalance = BigInt(await H("eth_getBalance", [wallet.address, "latest"]));
    report.gasHype = utils.formatEther(gasBalance.toString());
  }

  // ---- 3. claim confirmed batches on the outbox
  const pending = Object.keys(state.withdrawals).filter((t) => state.withdrawals[t] === "PENDING");
  let unconfirmed = 0, claims = 0;
  if (pending.length) {
    // How many Elysium -> HyperEVM messages does the bridge's latest confirmed checkpoint cover?
    const [latest] = await call(H, h.rollup, ROLL, "latestConfirmed");
    const [assertion] = await call(H, h.rollup, ROLL, "getAssertion", [latest]);
    const created = hex(Number(assertion.createdAtBlock));
    const logs = await H("eth_getLogs", [{ address: h.rollup, topics: [ROLL.getEventTopic("AssertionCreated"), latest], fromBlock: created, toBlock: created }]);
    if (logs.length !== 1) throw new Error(`expected one AssertionCreated log, got ${logs.length}`);
    const [blockHash, sendRoot] = ROLL.parseLog(logs[0]).args.assertion.afterState.globalState.bytes32Vals;
    const block = await E("eth_getBlockByHash", [blockHash, false]);
    if (!block || block.sendRoot !== sendRoot) throw new Error("the bridge's confirmed checkpoint does not match Elysium");
    const sendCount = BigInt(block.sendCount);

    for (const txHash of pending) {
      const ws = await withdrawalsIn(txHash);
      if (!ws.length) { report.batches.push({ tx: txHash, state: "unreadable" }); continue; }
      let allDone = true;
      for (const w of ws) {
        const [spent] = await call(H, h.outbox, OUT, "isSpent", [w.position.toString()]);
        if (spent) { report.batches.push({ tx: txHash, position: w.position.toString(), state: "claimed" }); continue; }
        allDone = false;
        if (w.position >= sendCount) { unconfirmed++; report.batches.push({ tx: txHash, position: w.position.toString(), state: "not confirmed yet" }); continue; }
        report.batches.push({ tx: txHash, position: w.position.toString(), state: "ready to claim" });
        if (claims >= cfg.maxClaimsPerRun) continue;
        claims++;
        const data = await executeData(w, sendCount);
        if (await act(`claim KNTQ batch ${w.position} on HyperEVM`, h.outbox, data)) {
          report.batches[report.batches.length - 1].state = "claimed";
          kntqToStake = BigInt((await call(H, h.kntq, ERC20, "balanceOf", [h.stakeAndLock]))[0].toString());
        }
      }
      if (allDone) state.withdrawals[txHash] = "EXECUTED";
    }
  }
  /** The bridge messages created by one Elysium transaction. */
  async function withdrawalsIn(txHash: string): Promise<Withdrawal[]> {
    const receipt = await E("eth_getTransactionReceipt", [txHash]);
    if (!receipt) return [];
    const topic = SYS.getEventTopic("L2ToL1Tx");
    return receipt.logs
      .filter((l: any) => l.address.toLowerCase() === ARB_SYS && l.topics[0] === topic)
      .map((l: any) => {
        const a = SYS.parseLog(l).args;
        return { position: BigInt(a.position.toString()), caller: a.caller, destination: a.destination, arbBlockNum: a.arbBlockNum.toString(), ethBlockNum: a.ethBlockNum.toString(), timestamp: a.timestamp.toString(), callvalue: a.callvalue.toString(), data: a.data };
      });
  }
  /** The outbox call that releases one confirmed message. */
  async function executeData(w: Withdrawal, sendCount: bigint): Promise<string> {
    const out = await call(E, NODE_INTERFACE, NODE, "constructOutboxProof", [sendCount.toString(), w.position.toString()]);
    return OUT.encodeFunctionData("executeTransaction", [out.proof, w.position.toString(), w.caller, w.destination, w.arbBlockNum, w.ethBlockNum, w.timestamp, w.callvalue, w.data]);
  }

  // ---- 4. stake what has arrived
  if (kntqToStake >= parse(cfg.minStakeKntq)) await act(`stake ${kntq(kntqToStake)} KNTQ as sKNTQ and lock it`, h.stakeAndLock, STK.encodeFunctionData("stake", []));

  // ---- 5. yield: harvest (at least once a day) -> unstake (7 days) -> bridge back to Elysium
  const minYield = parse(cfg.minYieldKntq);
  const everyHours = Number(deps.env("YIELD_EVERY_HOURS"));
  const yieldEverySec = everyHours > 0 ? everyHours * 3600 : cfg.yieldEverySec;
  const chainNow = Number((await H("eth_getBlockByNumber", ["latest", false])).timestamp);
  const lastTouched = res[10] ? Number(res[10].time) : 0;
  let unstaking = 0n, soonest = 0;
  if (yieldPending >= minYield && chainNow - lastTouched >= yieldEverySec) await act(`collect ${kntq(yieldPending)} KNTQ of staking yield`, h.reserve, RES.encodeFunctionData("harvest", [h.skntq]));
  if (skntqAtBridge > 0n) await act("start unstaking the collected yield (7 days)", h.yieldBridge, YB.encodeFunctionData("requestUnstake", []));
  if (nextId > 1) {
    const ids = Array.from({ length: Math.min(nextId - 1, 40) }, (_, i) => nextId - 1 - i);
    const reqs = await multicall(ids.map((id) => ({ to: h.skntq, iface: SK, fn: "withdrawalRequest", args: [h.yieldBridge, id] })));
    const now = Number((await H("eth_getBlockByNumber", ["latest", false])).timestamp);
    for (let i = ids.length - 1; i >= 0; i--) {
      const r = reqs[i];
      if (!r || BigInt(r.assets.toString()) === 0n) continue; // already collected
      const readyAt = Number(r.timestamp) + delay;
      if (now < readyAt) { unstaking += BigInt(r.assets.toString()); soonest = soonest ? Math.min(soonest, readyAt - now) : readyAt - now; continue; }
      await act(`collect ${kntq(BigInt(r.assets.toString()))} KNTQ from finished unstake #${ids[i]}`, h.yieldBridge, YB.encodeFunctionData("confirm", [ids[i]]));
    }
  }
  const toBridge = BigInt((await call(H, h.kntq, ERC20, "balanceOf", [h.yieldBridge]))[0].toString());
  if (toBridge > 0n && toBridge >= minYield / 2n) {
    const latest = await H("eth_getBlockByNumber", ["latest", false]);
    const baseFee = BigInt(latest.baseFeePerGas ?? (await H("eth_gasPrice")));
    const l2GasPrice = BigInt(await E("eth_gasPrice"));
    const maxGas = big(8) > 300_000n ? big(8) : 300_000n;
    const gasPriceBid = l2GasPrice * 2n > big(9) ? l2GasPrice * 2n : big(9);
    const [fee] = await call(H, h.inbox, INBOX, "calculateRetryableSubmissionFee", [2000, baseFee.toString()]);
    const maxSubmissionCost = BigInt(fee.toString()) * 2n;
    const value = maxSubmissionCost + maxGas * gasPriceBid;
    await act(`bridge ${kntq(toBridge)} KNTQ of yield back to Elysium (bridge fee ${utils.formatEther(value.toString())} HYPE)`, h.yieldBridge, YB.encodeFunctionData("bridge", [maxGas.toString(), gasPriceBid.toString(), maxSubmissionCost.toString()]), value);
  }

  report.holdings = {
    kntqToStake: kntq(kntqToStake), skntqLocked: kntq(big(1)), lockedValueKntq: kntq(big(2)), yieldPendingKntq: kntq(yieldPending),
    yieldUnstaking: kntq(unstaking), kntqToBridgeBack: kntq(kntqAtBridge),
  };
  const sent = report.actions.filter((a) => a.confirmed === true).length;
  const blocked = report.actions.some((a) => a.note?.includes("needs HYPE"));
  if (wallet && gasBalance < parse(cfg.minGasHype) && (blocked || pending.length > 0)) report.warnings.push(`the bot wallet has ${report.gasHype} HYPE on HyperEVM and needs some to act there`);
  report.status = sent > 0 ? "acted" : unconfirmed > 0 || unstaking > 0n || report.actions.length > 0 ? "waiting" : "idle";
  report.reason = sent > 0 ? `${sent} step${sent === 1 ? "" : "s"} done on HyperEVM`
    : blocked ? "work is ready on HyperEVM but the bot wallet has no HYPE there"
    : unconfirmed > 0 ? `${unconfirmed} KNTQ batch${unconfirmed === 1 ? "" : "es"} crossing the bridge; claimable once the bridge confirms them (usually a day or more after leaving Elysium)`
    : unstaking > 0n ? `${kntq(unstaking)} KNTQ of yield is unstaking; ready in ${(soonest / 3600).toFixed(1)} hours`
    : report.actions.length > 0 ? "work is ready but was not sent this run"
    : "nothing to do: no KNTQ has arrived and no yield is due";
  return { report, state };
}
