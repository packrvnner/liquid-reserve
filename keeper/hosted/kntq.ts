// Liquid Reserve: the bot's KNTQ staking job (liquidKNTQ).
//
// People on Elysium put KNTQ into the staking queue (src/staking/KntqStakeQueue.sol), or liquidKNTQ when they want
// to leave. Nothing else is asked of them: this job carries every batch through.
//
//   on Elysium    send      an open batch goes over the bridge once it is big enough (or, as the queue's keeper,
//                           once a smaller one has waited long enough)
//   on HyperEVM   claim     each batch on the bridge's outbox once the bridge has confirmed it (about a day)
//                 stake     a deposit batch's agent stakes the KNTQ and bridges the liquidKNTQ home
//                 unstake   an exit batch's agent opens Kinetiq's 7-day withdrawal, and when that is over
//                           collects the KNTQ and bridges it home
//                 fee       collects the vault's fee when there is one worth collecting: 20% to the creator's
//                           wallet, 80% locked in the reserve
//   on Elysium    rescue    runs a bridge ticket home that did not run by itself (it stays redeemable for 7 days)
//                 pay out   claims for every member of a batch whatever has come back for them
//
// Every call it makes is open to anyone and can only move tokens along the path the contracts fix. It keeps a small
// state between runs (which Elysium blocks it has read, and the batches still in progress).
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node (tests). ethers v5 is passed in.

export interface Lib { Wallet: any; utils: any }
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
export interface KntqConfig {
  elysium: { rpc: string; chainId: number; multicall: string; queue: string; scanFromBlock: number; logChunk: number; maxChunksPerRun: number; rpcGapMs: number };
  hyperevm: {
    rpc: string; chainId: number; multicall: string; rollup: string; outbox: string; inbox: string; bridge: string;
    kntq: string; skntq: string; vault: string; agentFactory: string; splitter: string; lock: string; rpcGapMs: number;
  };
  /** As the queue's keeper, send a batch smaller than the public minimum once its first member has waited this long. */
  smallBatchAfterSec: number;
  /** Collect the vault's fee once at least this much sKNTQ is waiting. */
  minFeeSkntq: string;
  /** Gas for the bridge ticket that carries tokens home. The first liquidKNTQ to reach Elysium also creates its token there. */
  homeGas: number; firstHomeGas: number;
  minGasHype: string;
  maxClaimsPerRun: number;
  maxPayoutsPerRun: number;
  /** Run a bridge ticket home by hand once it has sat unrun on Elysium this long (normally it runs within minutes). */
  rescueAfterSec: number;
  /** Tests only: no outbox (a simulated bridge delivers by itself). */
  skipOutbox?: boolean;
  /** Tests only: do not look for the ticket's own transaction on Elysium (a local chain has none). */
  skipTicketReceipt?: boolean;
}
export const KNTQ_CONFIG: KntqConfig = {
  elysium: {
    rpc: "https://rpc.elysium.kinetiq.xyz",
    chainId: 99901,
    multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
    queue: "0x14e2EdfBc51c94dba6b858c6B3dF5b2227A5E74C",
    scanFromBlock: 8_950_000, // the queue was created in block 8,950,427
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
    bridge: "0x503D572157113fAaaD4DbeD2647Bb10b949216B6", // inbox.bridge(): logs each message sent to Elysium
    kntq: "0x000000000000780555bD0BCA3791f89f9542c2d6",
    skntq: "0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F",
    vault: "0x3DE32a31484240d01f8d114bcCC570d90bc95AAb",
    agentFactory: "0x7c21642E662d7aC55685BA56480fE8eb681ebd63",
    splitter: "0x2c86d01601D2295E66AdE98749963f0a8a311CfF",
    lock: "0x9cce7DD4402688849A68A03D4A64c704e92301c7",
    rpcGapMs: 700, // the public HyperEVM RPC allows about 100 requests a minute
  },
  smallBatchAfterSec: 6 * 3600,
  minFeeSkntq: "5",
  homeGas: 400_000,
  firstHomeGas: 1_500_000,
  minGasHype: "0.002",
  maxClaimsPerRun: 3,
  maxPayoutsPerRun: 12,
  rescueAfterSec: 20 * 60,
};

/** One batch the job is still carrying. `key` is "1:<id>" for deposits and "2:<id>" for exits. */
export interface KntqBatch {
  members: string[];
  /** When its first member joined (Elysium time). */
  openedAt?: number;
  /** The Elysium transaction that sent it over the bridge, once sent. */
  sentTx?: string;
  /** Claimed on HyperEVM's outbox. */
  claimed?: boolean;
  /** HyperEVM transactions that sent this batch's tokens home, and those whose bridge tickets are known to have run. */
  homeTxs?: string[];
  homeSettled?: string[];
  /** Everything has come home and been paid out. */
  done?: boolean;
}
export interface KntqState { scanBlock?: number; batches: Record<string, KntqBatch> }
export interface KntqAction { chain: "Elysium" | "HyperEVM"; what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface KntqReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  gasHype?: { elysium: string; hyperevm: string };
  status: "not-deployed" | "idle" | "waiting" | "acted" | "paused";
  reason: string;
  /** Where each batch in progress stands, in words. */
  batches: { batch: string; total: string; state: string }[];
  holdings?: { staked: string; liquidKntq: string; rate: string; feeWaiting: string; openDeposits: string; openExits: string };
  actions: KntqAction[];
  warnings: string[];
  error?: string;
}

const ARB_SYS = "0x0000000000000000000000000000000000000064";
const ARB_RETRYABLE = "0x000000000000000000000000000000000000006E";
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const DEPOSIT = 1, EXIT = 2;
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const QUEUE_ABI = [
  "function openBatch(uint8 kind) view returns (uint256)",
  "function batch(uint8 kind, uint256 id) view returns (tuple(uint256 total, uint64 sentAt, uint256 received, uint256 returned))",
  "function boxOf(uint8 kind, uint256 id) view returns (address)",
  "function agentOf(uint8 kind, uint256 id) view returns (address)",
  "function claimable(uint8 kind, uint256 id, address account) view returns (uint256 received, uint256 returned)",
  "function minDeposits() view returns (uint256)",
  "function minExits() view returns (uint256)",
  "function keeper() view returns (address)",
  "function share() view returns (address)",
  "function sendDeposits() returns (uint256)",
  "function sendExits() returns (uint256)",
  "function claim(uint8 kind, uint256 id, address account) returns (uint256, uint256)",
  "event Joined(uint8 indexed kind, uint256 indexed id, address indexed account, uint256 amount)",
  "event Sent(uint8 indexed kind, uint256 indexed id, uint256 total, address agent, address box)",
];
const FACTORY_ABI = ["function open(uint8 kind, uint256 id, address l2Box) returns (address)"];
const AGENT_ABI = [
  "function minGas() view returns (uint256)",
  "function minGasPrice() view returns (uint256)",
  "function stake(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost) payable returns (bool, uint256)",
  "function startExit() returns (uint256, uint256)",
  "function finishExit(uint256[] requestIds, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost) payable returns (uint256)",
];
const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function currentRate() view returns (uint256)",
  "function pendingFees() view returns (uint256)",
  "function collectFees() returns (uint256)",
];
const SPLIT_ABI = ["function distribute(address token) returns (uint256, uint256)"];
const LOCK_ABI = ["function lock() returns (uint256)"];
const SKNTQ_ABI = [
  "function withdrawalDelay() view returns (uint256)",
  "function nextWithdrawalRequestId(address owner) view returns (uint256)",
  "function withdrawalRequest(address owner, uint256 id) view returns (uint256 assets, uint256 shares, uint256 timestamp)",
];
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
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];
const RETRY_ABI = ["function getTimeout(bytes32 ticketId) view returns (uint256)", "function redeem(bytes32 ticketId) returns (bytes32)"];
const INBOX_LOG_ABI = ["event InboxMessageDelivered(uint256 indexed messageNum, bytes data)"];
const BRIDGE_LOG_ABI = ["event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)"];
const SUBMIT_RETRYABLE = 9; // the bridge's message kind for a ticket

/** What fixes a bridge ticket (an Arbitrum retryable). Numbers as 0x-hex of any length. */
export interface TicketFields {
  chainId: string; requestId: string; from: string; l1BaseFee: string; depositValue: string; maxFeePerGas: string; gas: string;
  retryTo: string; retryValue: string; beneficiary: string; maxSubmissionFee: string; refundTo: string; retryData: string;
}
/** A ticket's id: the hash of the Elysium transaction that submits it (type 0x69), which is also how it is redeemed. */
export function ticketId(utils: any, f: TicketFields): string {
  const n = (v: string) => "0x" + utils.hexZeroPad(v, 32).slice(2).replace(/^(00)+/, ""); // a number, without leading zero bytes
  const a = (v: string) => utils.hexZeroPad(utils.hexStripZeros(v), 20);
  const fields = [
    n(f.chainId), utils.hexZeroPad(f.requestId, 32), a(f.from), n(f.l1BaseFee), n(f.depositValue), n(f.maxFeePerGas), n(f.gas),
    /^0x0*$/.test(f.retryTo) ? "0x" : a(f.retryTo), n(f.retryValue), a(f.beneficiary), n(f.maxSubmissionFee), a(f.refundTo), f.retryData,
  ];
  return utils.keccak256(utils.hexConcat(["0x69", utils.RLP.encode(fields)]));
}
/** The ids of the tickets a HyperEVM transaction created for Elysium, read from what the inbox and the bridge logged. */
export function ticketIdsOf(utils: any, receipt: any, inbox: string, bridge: string, l2ChainId: number): string[] {
  const IN = new utils.Interface(INBOX_LOG_ABI), BR = new utils.Interface(BRIDGE_LOG_ABI);
  const low = (x: unknown) => String(x ?? "").toLowerCase();
  const sent = new Map<string, { sender: string; baseFee: string }>();
  for (const l of receipt?.logs ?? []) {
    if (low(l.address) !== low(bridge) || l.topics[0] !== BR.getEventTopic("MessageDelivered")) continue;
    const ev = BR.parseLog(l).args;
    if (Number(ev.kind) === SUBMIT_RETRYABLE) sent.set(ev.messageIndex.toString(), { sender: ev.sender, baseFee: ev.baseFeeL1.toHexString() });
  }
  const ids: string[] = [];
  for (const l of receipt?.logs ?? []) {
    if (low(l.address) !== low(inbox) || l.topics[0] !== IN.getEventTopic("InboxMessageDelivered")) continue;
    const ev = IN.parseLog(l).args, m = sent.get(ev.messageNum.toString());
    if (!m) continue;
    const d = String(ev.data).slice(2), word = (i: number) => "0x" + d.slice(i * 64, i * 64 + 64);
    if (d.length < 9 * 64) continue;
    ids.push(ticketId(utils, {
      chainId: "0x" + l2ChainId.toString(16), requestId: ev.messageNum.toHexString(), from: m.sender, l1BaseFee: m.baseFee,
      retryTo: word(0), retryValue: word(1), depositValue: word(2), maxSubmissionFee: word(3), refundTo: word(4), beneficiary: word(5),
      gas: word(6), maxFeePerGas: word(7), retryData: "0x" + d.slice(9 * 64, 9 * 64 + Number(BigInt(word(8))) * 2),
    }));
  }
  return ids;
}

interface Withdrawal { position: bigint; caller: string; destination: string; arbBlockNum: string; ethBlockNum: string; timestamp: string; callvalue: string; data: string }

export async function runKntq(deps: Deps, stateIn: KntqState | null, cfg: KntqConfig = KNTQ_CONFIG): Promise<{ report: KntqReport; state: KntqState }> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: KntqState = { scanBlock: stateIn?.scanBlock, batches: JSON.parse(JSON.stringify(stateIn?.batches ?? {})) };
  const report: KntqReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", batches: [], actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("KNTQ_PAUSED") === "1") {
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
  const dry = deps.env("DRY_RUN") === "1" || deps.env("KNTQ_DRY_RUN") === "1";
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
  const e = cfg.elysium, h = cfg.hyperevm;
  const E = client(deps.env("ELYSIUM_RPC") || e.rpc, e.rpcGapMs);
  const H = client(deps.env("HYPEREVM_RPC") || h.rpc, h.rpcGapMs);
  const I = (abi: string[]) => new utils.Interface(abi);
  const ERC20 = I(ERC20_ABI), Q = I(QUEUE_ABI), FAC = I(FACTORY_ABI), AG = I(AGENT_ABI), V = I(VAULT_ABI), SPL = I(SPLIT_ABI), LK = I(LOCK_ABI), SK = I(SKNTQ_ABI);
  const SYS = I(ARBSYS_ABI), NODE = I(NODE_ABI), OUT = I(OUTBOX_ABI), ROLL = I(ROLLUP_ABI), INBOX = I(INBOX_ABI), MC = I(MULTICALL_ABI), RETRY = I(RETRY_ABI);
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const lower = (a: unknown) => String(a ?? "").toLowerCase();
  const amt = (v: bigint) => utils.formatUnits(v.toString(), 18);
  const parse = (v: string) => BigInt(utils.parseUnits(v, 18).toString());
  type Rpc = typeof E;
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  async function multicall(rpc: Rpc, mc: string, calls: Call[]): Promise<any[]> {
    if (!calls.length) return [];
    const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const [rows] = MC.decodeFunctionResult("aggregate3", await rpc("eth_call", [{ to: mc, data }, "latest"]));
    return rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  }
  const call = async (rpc: Rpc, to: string, iface: any, fn: string, args: unknown[] = []) => iface.decodeFunctionResult(fn, await rpc("eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"]));
  const big = (r: any, i = 0) => BigInt((r?.[i] ?? 0).toString());

  // ---- simulate, sign, send, wait, on either chain
  const gasBal = { Elysium: 0n, HyperEVM: 0n };
  async function act(chain: "Elysium" | "HyperEVM", what: string, to: string, data: string, value: bigint = 0n): Promise<boolean> {
    const rpc = chain === "Elysium" ? E : H, chainId = chain === "Elysium" ? e.chainId : h.chainId;
    if (!wallet) { report.actions.push({ chain, what, note: "ready, but no keeper wallet is configured" }); return false; }
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to, data, value: hex(value) }]));
    } catch (err: any) {
      const low = gasBal[chain] < parse(cfg.minGasHype) + value;
      report.actions.push({ chain, what, note: low ? `skipped: the bot wallet needs HYPE on ${chain}` : `skipped: ${String(err?.message ?? err).slice(0, 140)}` });
      return false;
    }
    if (dry) { report.actions.push({ chain, what, note: "dry run: would have been sent" }); return false; }
    let limit = (gas * 13n) / 10n;
    if (chain === "HyperEVM" && limit > 2_900_000n) limit = 2_900_000n; // HyperEVM's fast blocks hold 3,000,000 gas
    const nonce = Number(await rpc("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (BigInt(await rpc("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data, nonce, gasLimit: hex(limit), gasPrice: hex(gasPrice), chainId, value: hex(value), type: 0 });
    const tx = await rpc("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) {
        report.actions.push({ chain, what, tx, confirmed: r.status === "0x1" });
        if (r.status !== "0x1") report.ok = false;
        return r.status === "0x1";
      }
    }
    report.actions.push({ chain, what, tx, confirmed: null });
    return false;
  }

  // ---- is it there at all? (the job is deployed before the contracts are)
  const base = await multicall(E, e.multicall, [
    { to: e.queue, iface: Q, fn: "openBatch", args: [DEPOSIT] }, { to: e.queue, iface: Q, fn: "openBatch", args: [EXIT] },
    { to: e.queue, iface: Q, fn: "minDeposits" }, { to: e.queue, iface: Q, fn: "minExits" }, { to: e.queue, iface: Q, fn: "keeper" }, { to: e.queue, iface: Q, fn: "share" },
  ]);
  if (!base[0] || !base[2]) { report.status = "not-deployed"; report.reason = "the KNTQ staking queue is not on Elysium yet"; return { report, state }; }
  const open = { [DEPOSIT]: Number(big(base[0])), [EXIT]: Number(big(base[1])) } as Record<number, number>;
  const minimum = { [DEPOSIT]: big(base[2]), [EXIT]: big(base[3]) } as Record<number, bigint>;
  const isKeeper = !!wallet && lower(base[4]?.[0]) === lower(wallet.address);
  if (wallet) {
    gasBal.Elysium = BigInt(await E("eth_getBalance", [wallet.address, "latest"]));
    gasBal.HyperEVM = BigInt(await H("eth_getBalance", [wallet.address, "latest"]));
    report.gasHype = { elysium: utils.formatEther(gasBal.Elysium.toString()), hyperevm: utils.formatEther(gasBal.HyperEVM.toString()) };
    for (const c of ["Elysium", "HyperEVM"] as const) if (gasBal[c] < parse(cfg.minGasHype)) report.warnings.push(`the bot wallet is low on HYPE on ${c}`);
  }

  // ---- 1. read the queue's events since the last run: who is in which batch, and which batches were sent
  const headBlock = await E("eth_getBlockByNumber", ["latest", false]);
  const head = Number(headBlock.number), nowE = Number(headBlock.timestamp);
  const key = (kind: number, id: number | bigint) => `${kind}:${id}`;
  const slot = (k: string) => (state.batches[k] ??= { members: [] });
  let from = (state.scanBlock ?? e.scanFromBlock - 1) + 1;
  for (let n = 0; from <= head && n < e.maxChunksPerRun; n++) {
    const to = Math.min(head, from + e.logChunk - 1);
    const logs = await E("eth_getLogs", [{ address: e.queue, topics: [[Q.getEventTopic("Joined"), Q.getEventTopic("Sent")]], fromBlock: hex(from), toBlock: hex(to) }]);
    for (const l of logs) {
      const ev = Q.parseLog(l), b = slot(key(Number(ev.args.kind), BigInt(ev.args.id.toString())));
      if (ev.name === "Joined") {
        const who = lower(ev.args.account);
        if (!b.members.includes(who)) b.members.push(who);
        b.openedAt ??= Number(l.blockTimestamp ?? (await E("eth_getBlockByNumber", [l.blockNumber, false])).timestamp);
      } else b.sentTx = l.transactionHash;
    }
    state.scanBlock = to;
    from = to + 1;
  }

  // ---- 2. send an open batch over the bridge when it is due
  const openInfo = await multicall(E, e.multicall, [{ to: e.queue, iface: Q, fn: "batch", args: [DEPOSIT, open[DEPOSIT]] }, { to: e.queue, iface: Q, fn: "batch", args: [EXIT, open[EXIT]] }]);
  const openTotal = { [DEPOSIT]: BigInt((openInfo[0]?.[0]?.total ?? 0).toString()), [EXIT]: BigInt((openInfo[1]?.[0]?.total ?? 0).toString()) } as Record<number, bigint>;
  for (const kind of [DEPOSIT, EXIT]) {
    const total = openTotal[kind], k = key(kind, open[kind]), name = kind === DEPOSIT ? "deposit" : "exit", unit = kind === DEPOSIT ? "KNTQ" : "liquidKNTQ";
    if (total === 0n) continue;
    const waited = nowE - (state.batches[k]?.openedAt ?? nowE);
    const due = total >= minimum[kind] || (isKeeper && waited >= cfg.smallBatchAfterSec);
    if (!due) { report.batches.push({ batch: `${name} ${open[kind]}`, total: `${amt(total)} ${unit}`, state: `collecting; goes once it reaches ${amt(minimum[kind])} ${unit}${isKeeper ? ` or has waited ${Math.round(cfg.smallBatchAfterSec / 3600)} hours` : ""}` }); continue; }
    const ok = await act("Elysium", `send ${name} batch ${open[kind]} (${amt(total)} ${unit}) over the bridge`, e.queue, Q.encodeFunctionData(kind === DEPOSIT ? "sendDeposits" : "sendExits", []));
    if (ok) slot(k).sentTx = report.actions[report.actions.length - 1].tx;
  }

  // ---- 3. the batches in flight
  const flying = Object.keys(state.batches).filter((k) => state.batches[k].sentTx && !state.batches[k].done);
  const ids = flying.map((k) => k.split(":").map(Number) as [number, number]);
  const where = await multicall(E, e.multicall, ids.flatMap(([kind, id]) => [
    { to: e.queue, iface: Q, fn: "agentOf", args: [kind, id] }, { to: e.queue, iface: Q, fn: "boxOf", args: [kind, id] }, { to: e.queue, iface: Q, fn: "batch", args: [kind, id] },
  ]));

  // 3a. claim on the outbox what the bridge has confirmed
  const unclaimed = flying.filter((k) => !state.batches[k].claimed);
  let unconfirmed = 0, claims = 0;
  if (unclaimed.length && !cfg.skipOutbox) {
    const [latest] = await call(H, h.rollup, ROLL, "latestConfirmed");
    const [assertion] = await call(H, h.rollup, ROLL, "getAssertion", [latest]);
    const created = hex(Number(assertion.createdAtBlock));
    const logs = await H("eth_getLogs", [{ address: h.rollup, topics: [ROLL.getEventTopic("AssertionCreated"), latest], fromBlock: created, toBlock: created }]);
    if (logs.length !== 1) throw new Error(`expected one AssertionCreated log, got ${logs.length}`);
    const [blockHash, sendRoot] = ROLL.parseLog(logs[0]).args.assertion.afterState.globalState.bytes32Vals;
    const block = await E("eth_getBlockByHash", [blockHash, false]);
    if (!block || block.sendRoot !== sendRoot) throw new Error("the bridge's confirmed checkpoint does not match Elysium");
    const sendCount = BigInt(block.sendCount);
    for (const k of unclaimed) {
      const receipt = await E("eth_getTransactionReceipt", [state.batches[k].sentTx]);
      const topic = SYS.getEventTopic("L2ToL1Tx");
      const ws: Withdrawal[] = (receipt?.logs ?? []).filter((l: any) => lower(l.address) === ARB_SYS && l.topics[0] === topic).map((l: any) => {
        const a = SYS.parseLog(l).args;
        return { position: BigInt(a.position.toString()), caller: a.caller, destination: a.destination, arbBlockNum: a.arbBlockNum.toString(), ethBlockNum: a.ethBlockNum.toString(), timestamp: a.timestamp.toString(), callvalue: a.callvalue.toString(), data: a.data };
      });
      if (!ws.length) { report.warnings.push(`batch ${k}: its bridge message could not be read from ${state.batches[k].sentTx}`); continue; }
      let all = true;
      for (const w of ws) {
        const [spent] = await call(H, h.outbox, OUT, "isSpent", [w.position.toString()]);
        if (spent) continue;
        all = false;
        if (w.position >= sendCount) { unconfirmed++; continue; }
        if (claims >= cfg.maxClaimsPerRun) continue;
        claims++;
        const proof = await call(E, NODE_INTERFACE, NODE, "constructOutboxProof", [sendCount.toString(), w.position.toString()]);
        const data = OUT.encodeFunctionData("executeTransaction", [proof.proof, w.position.toString(), w.caller, w.destination, w.arbBlockNum, w.ethBlockNum, w.timestamp, w.callvalue, w.data]);
        if (await act("HyperEVM", `claim batch ${k} on HyperEVM's outbox`, h.outbox, data)) all = ws.length === 1;
      }
      if (all) state.batches[k].claimed = true;
    }
  } else if (cfg.skipOutbox) for (const k of unclaimed) state.batches[k].claimed = true;

  // 3b. what each batch's agent holds on HyperEVM, and the vault
  const agents = ids.map((_, i) => String(where[i * 3]?.[0] ?? "")), boxes = ids.map((_, i) => String(where[i * 3 + 1]?.[0] ?? ""));
  const hv = await multicall(H, h.multicall, [
    { to: h.vault, iface: V, fn: "totalAssets" }, { to: h.vault, iface: V, fn: "totalSupply" }, { to: h.vault, iface: V, fn: "currentRate" }, { to: h.vault, iface: V, fn: "pendingFees" },
    { to: h.skntq, iface: SK, fn: "withdrawalDelay" },
    ...agents.flatMap((a) => [
      { to: h.kntq, iface: ERC20, fn: "balanceOf", args: [a] }, { to: h.vault, iface: ERC20, fn: "balanceOf", args: [a] },
      { to: h.skntq, iface: ERC20, fn: "balanceOf", args: [a] }, { to: h.skntq, iface: SK, fn: "nextWithdrawalRequestId", args: [a] },
    ]),
  ]);
  if (!hv[0]) { report.status = "not-deployed"; report.reason = "the KNTQ staking vault is not on HyperEVM yet"; return { report, state }; }
  const delay = Number(big(hv[4]));
  const nowH = Number((await H("eth_getBlockByNumber", ["latest", false])).timestamp);

  /** Gas settings and fee for the bridge ticket that carries tokens home. */
  async function ticket(agent: string, gasWanted: number) {
    const [mg, mp] = await multicall(H, h.multicall, [{ to: agent, iface: AG, fn: "minGas" }, { to: agent, iface: AG, fn: "minGasPrice" }]);
    const latest = await H("eth_getBlockByNumber", ["latest", false]);
    const baseFee = BigInt(latest.baseFeePerGas ?? (await H("eth_gasPrice")));
    const l2GasPrice = BigInt(await E("eth_gasPrice"));
    const maxGas = big(mg) > BigInt(gasWanted) ? big(mg) : BigInt(gasWanted);
    const gasPriceBid = l2GasPrice * 2n > big(mp) ? l2GasPrice * 2n : big(mp);
    const [fee] = await call(H, h.inbox, INBOX, "calculateRetryableSubmissionFee", [2000, baseFee.toString()]);
    const maxSubmissionCost = BigInt(fee.toString()) * 2n;
    return { maxGas, gasPriceBid, maxSubmissionCost, value: maxSubmissionCost + maxGas * gasPriceBid };
  }
  const shareExists = (await E("eth_getCode", [String(base[5]?.[0]), "latest"])) !== "0x";
  let exiting = 0n, soonest = 0;

  for (let i = 0; i < flying.length; i++) {
    const k = flying[i], [kind, id] = ids[i], agent = agents[i], box = boxes[i], b = state.batches[k];
    const info = where[i * 3 + 2]?.[0], total = BigInt((info?.total ?? 0).toString());
    const name = kind === DEPOSIT ? `deposit ${id}` : `exit ${id}`, unit = kind === DEPOSIT ? "KNTQ" : "liquidKNTQ";
    const at = (j: number) => big(hv[5 + i * 4 + j]);
    const kntqHere = at(0), sharesHere = at(1), skntqHere = at(2), nextReq = Number(at(3));
    let words = !b.claimed ? "crossing the bridge to HyperEVM (about a day)" : "";
    const ensureAgent = async () => (await H("eth_getCode", [agent, "latest"])) !== "0x" || (await act("HyperEVM", `open the agent of ${name}`, h.agentFactory, FAC.encodeFunctionData("open", [kind, id, box])));
    // remember a transaction that sent tokens home, so its bridge ticket can be looked after (below)
    const noteHome = () => { const a = report.actions[report.actions.length - 1]; if (a?.tx && a.confirmed !== false && !(b.homeTxs ?? []).includes(a.tx)) (b.homeTxs ??= []).push(a.tx); };

    if (kind === DEPOSIT && kntqHere > 0n) {
      words = "arrived on HyperEVM, being staked";
      if (await ensureAgent()) {
        const t = await ticket(agent, shareExists ? cfg.homeGas : cfg.firstHomeGas);
        await act("HyperEVM", `stake ${amt(kntqHere)} KNTQ of ${name} and send the liquidKNTQ home (bridge fee ${utils.formatEther(t.value.toString())} HYPE)`, agent,
          AG.encodeFunctionData("stake", [t.maxGas.toString(), t.gasPriceBid.toString(), t.maxSubmissionCost.toString()]), t.value);
        noteHome();
      }
    }
    if (kind === EXIT) {
      if (sharesHere > 0n || skntqHere > 0n) {
        words = "arrived on HyperEVM, starting Kinetiq's 7-day withdrawal";
        if (await ensureAgent()) await act("HyperEVM", `start unstaking ${name} (${amt(sharesHere)} liquidKNTQ; 7 days)`, agent, AG.encodeFunctionData("startExit", []));
      }
      // requests already open at this agent
      const reqIds = Array.from({ length: Math.max(0, Math.min(nextReq - 1, 20)) }, (_, n) => nextReq - 1 - n);
      const reqs = await multicall(H, h.multicall, reqIds.map((r) => ({ to: h.skntq, iface: SK, fn: "withdrawalRequest", args: [agent, r] })));
      const ready: number[] = [];
      reqs.forEach((r, n) => {
        const assets = BigInt((r?.assets ?? 0).toString());
        if (assets === 0n) return; // collected already
        const readyAt = Number(r.timestamp) + delay;
        if (nowH >= readyAt) ready.push(reqIds[n]);
        else { exiting += assets; soonest = soonest ? Math.min(soonest, readyAt - nowH) : readyAt - nowH; words = `unstaking at Kinetiq, ${((readyAt - nowH) / 86400).toFixed(1)} days to go`; }
      });
      if (ready.length || (kntqHere > 0n && (await H("eth_getCode", [agent, "latest"])) !== "0x")) {
        words = "unstaked, sending the KNTQ home";
        const t = await ticket(agent, cfg.homeGas);
        await act("HyperEVM", `collect ${name}'s KNTQ and send it home (bridge fee ${utils.formatEther(t.value.toString())} HYPE)`, agent,
          AG.encodeFunctionData("finishExit", [ready, t.maxGas.toString(), t.gasPriceBid.toString(), t.maxSubmissionCost.toString()]), t.value);
        noteHome();
      }
    }

    // ---- 3c. a bridge ticket home that did not run by itself. It normally runs within minutes of the HyperEVM
    // transaction; if it does not (too little gas for it on Elysium), anyone can run it for 7 days, and this does.
    let onTheWay = false;
    for (const tx of (b.homeTxs ?? []).filter((x) => !(b.homeSettled ?? []).includes(x)).slice(0, 2)) {
      const r = await H("eth_getTransactionReceipt", [tx]);
      if (!r) { onTheWay = true; continue; }
      let unrun = 0;
      for (const ticket of r.status === "0x1" ? ticketIdsOf(utils, r, h.inbox, h.bridge, e.chainId) : []) {
        const age = nowH - Number((await H("eth_getBlockByNumber", [r.blockNumber, false])).timestamp);
        if (!cfg.skipTicketReceipt && !(await E("eth_getTransactionReceipt", [ticket]))) { // not on Elysium yet
          unrun++;
          if (age > 3600) report.warnings.push(`${name}: its bridge ticket home (${ticket}) has not appeared on Elysium after an hour`);
          continue;
        }
        let waiting = true; // a ticket that has run is gone, and asking for it reverts
        try { await call(E, ARB_RETRYABLE, RETRY, "getTimeout", [ticket]); } catch (err: any) { if (/revert/i.test(String(err?.message ?? ""))) waiting = false; }
        if (!waiting) continue;
        unrun++;
        if (age < cfg.rescueAfterSec) continue;
        report.warnings.push(`${name}: its bridge ticket home did not run by itself`);
        if (await act("Elysium", `run the bridge ticket that carries ${name} home`, ARB_RETRYABLE, RETRY.encodeFunctionData("redeem", [ticket]))) unrun--;
      }
      if (unrun === 0) (b.homeSettled ??= []).push(tx); else onTheWay = true;
    }
    if (onTheWay && !words) words = "on its way home over the bridge";

    // ---- 4. pay out on Elysium whatever has come back for each member
    const due = await multicall(E, e.multicall, b.members.map((m) => ({ to: e.queue, iface: Q, fn: "claimable", args: [kind, id, m] })));
    let paid = 0, waiting = 0;
    for (let m = 0; m < b.members.length; m++) {
      const got = big(due[m], 0) + big(due[m], 1);
      if (got === 0n) continue;
      waiting++;
      if (paid >= cfg.maxPayoutsPerRun) continue;
      if (await act("Elysium", `pay ${b.members[m].slice(0, 8)}… their share of ${name}`, e.queue, Q.encodeFunctionData("claim", [kind, id, b.members[m]]))) { paid++; waiting--; }
    }
    const back = BigInt((info?.received ?? 0).toString()) + BigInt((info?.returned ?? 0).toString());
    if (paid > 0 || waiting > 0) words = waiting > 0 ? "home on Elysium, being paid out" : "paid out";
    // finished when something came home, nothing more is owed to anyone, and nothing of it is left on HyperEVM
    if (b.claimed && (back > 0n || paid > 0) && waiting === 0 && kntqHere === 0n && sharesHere === 0n && skntqHere === 0n && !/unstaking|sending/.test(words)) {
      if (paid === 0) b.done = true; // one quiet run after the last payout, so a late piece is not missed
      words = "paid out";
    }
    report.batches.push({ batch: name, total: `${amt(total)} ${unit}`, state: words || "on HyperEVM" });
  }

  // ---- 5. the vault's fee: 20% to the creator, 80% locked in the reserve
  const feeWaiting = big(hv[3]);
  if (feeWaiting >= parse(cfg.minFeeSkntq)) {
    if (await act("HyperEVM", `collect ${amt(feeWaiting)} sKNTQ of staking fee from the liquidKNTQ vault`, h.vault, V.encodeFunctionData("collectFees", []))
      && await act("HyperEVM", "split the fee: 20% to the creator, 80% to the reserve", h.splitter, SPL.encodeFunctionData("distribute", [h.skntq]))) {
      await act("HyperEVM", "lock the reserve's part of the fee", h.lock, LK.encodeFunctionData("lock", []));
    }
  }

  report.holdings = {
    staked: `${amt(big(hv[0]))} sKNTQ`, liquidKntq: amt(big(hv[1])), rate: amt(big(hv[2])), feeWaiting: `${amt(feeWaiting)} sKNTQ`,
    openDeposits: `${amt(openTotal[DEPOSIT])} KNTQ`, openExits: `${amt(openTotal[EXIT])} liquidKNTQ`,
  };
  const sent = report.actions.filter((a) => a.confirmed === true).length;
  const blocked = report.actions.some((a) => a.note?.includes("needs HYPE"));
  const inFlight = flying.filter((k) => !state.batches[k].done).length;
  report.status = sent > 0 ? "acted" : inFlight > 0 || report.actions.length > 0 || openTotal[DEPOSIT] + openTotal[EXIT] > 0n ? "waiting" : "idle";
  report.reason = sent > 0 ? `${sent} step${sent === 1 ? "" : "s"} done`
    : blocked ? "work is ready but the bot wallet needs HYPE"
    : unconfirmed > 0 ? `${unconfirmed} batch${unconfirmed === 1 ? "" : "es"} crossing the bridge; claimable once the bridge confirms them (about a day after leaving Elysium)`
    : exiting > 0n ? `${amt(exiting)} KNTQ is unstaking at Kinetiq; ready in ${(soonest / 86400).toFixed(1)} days`
    : inFlight > 0 ? `${inFlight} batch${inFlight === 1 ? "" : "es"} in progress`
    : openTotal[DEPOSIT] + openTotal[EXIT] > 0n ? "a batch is collecting"
    : "nothing to do: no batch is open or in flight";
  return { report, state };
}
