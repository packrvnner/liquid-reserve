// Reward pools (src/staking/RewardPool.sol): deposit a staking token, earn $liquid.
//
// The reserve's yield is split by shares the owner sets; the shares that go to a pool buy $liquid, which the pool
// pays out to whoever has deposited the pool's token there, pro-rata, streamed over a week. A deposit can be taken
// out again at any time. Settings come from deployment.json -> elysium.rewardPools; a pool's card only appears once
// the pool exists on-chain, and says so plainly when nothing is being paid.
//
// Reads: one Multicall3 request for every pool. Nothing here is an estimate of future pay: the card shows what
// the pool is paying out right now and until when.
import { SEL, encode, addr, uint, words, toUint } from "./abi.js";
import { esc, explorer } from "./ui.js";
import { amount } from "./format.js";
import { wallet } from "./wallet.js";

// pool: totalStaked(), rewardRate(), periodFinish(), queuedRewards(), earned(address), stake(uint256), withdraw(uint256), claim()
// token: totalSupply(), allowance(address,address), approve(address,uint256); Multicall3 getCurrentBlockTimestamp()
const P = {
  totalStaked: "0x817b1cd2", rewardRate: "0x7b0a47ee", periodFinish: "0xebe2b12b", queuedRewards: "0x63d38c3b", earned: "0x008cc262",
  stake: "0xa694fc3a", withdraw: "0x2e1a7d4d", claim: "0x4e71d92d",
  totalSupply: "0x18160ddd", allowance: "0xdd62ed3e", approve: "0x095ea7b3", now: "0x0f28c97d",
};
const E18 = 10n ** 18n;
// Gas limit = the network's own estimate plus 30%. Taking a deposit out clears storage, which is refunded only at
// the end: a wallet that sets the limit to what such a call finally costs runs it out of gas half way (seen in
// testing). Unused gas is not charged.
const GAS_PAD = 30;
const has = (x) => !!x && x.length >= 66;
const num = (v, digits = 4) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: digits });
const cfgOf = (S, key) => S.cfg?.elysium?.rewardPools?.[key];
// what is typed in each pool's card, kept across redraws
const ui = {};
const uiOf = (key) => (ui[key] ??= { tab: "deposit", text: "", busy: false, msg: null });

function parse18(text) {
  const t = String(text ?? "").trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return 0n;
  const [w, f = ""] = t.split(".");
  return BigInt(w || "0") * E18 + BigInt((f + "0".repeat(18)).slice(0, 18));
}

/** Every configured pool, in one request. `exists`: the pool is on-chain. `tokenExists`: so is the token it takes. */
export async function loadPools({ cfg, e }, account) {
  const pools = cfg.elysium.rewardPools;
  if (!pools) return null;
  const keys = Object.keys(pools), PER = 9, calls = [{ to: cfg.elysium.multicall, data: P.now }];
  for (const k of keys) {
    const { pool, token } = pools[k], me = account ?? pool; // without a wallet the personal reads are asked for the pool itself and ignored
    calls.push(
      { to: pool, data: P.totalStaked }, { to: pool, data: P.rewardRate }, { to: pool, data: P.periodFinish }, { to: pool, data: P.queuedRewards },
      { to: token, data: P.totalSupply },
      { to: pool, data: encode(SEL.balanceOf, addr(me)) }, { to: pool, data: encode(P.earned, addr(me)) },
      { to: token, data: encode(SEL.balanceOf, addr(me)) }, { to: token, data: encode(P.allowance, addr(me), addr(pool)) },
    );
  }
  const res = await e.multicall(calls);
  const big = (i) => (has(res[i]) ? toUint(words(res[i])[0]) : 0n);
  const now = has(res[0]) ? Number(big(0)) : Math.floor(Date.now() / 1000);
  const out = {};
  keys.forEach((k, n) => {
    const at = 1 + n * PER, finish = Number(big(at + 2));
    out[k] = {
      exists: has(res[at]), tokenExists: has(res[at + 4]),
      total: big(at), rate: big(at + 1), finish, queued: big(at + 3), running: finish > now && big(at + 1) > 0n, now,
      user: account ? { deposited: big(at + 5), earned: big(at + 6), wallet: big(at + 7), allowance: big(at + 8) } : null,
    };
  });
  return out;
}

/** True when the pool's card should be drawn at all. */
export const poolOn = (S, key) => !!cfgOf(S, key) && !!S.pools?.[key]?.exists;

function paying(p) {
  if (p.running) return `${num(p.rate * 86_400n, 2)} $liquid a day, shared between everyone in the pool, until ${new Date(p.finish * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  return p.queued > 0n && p.total === 0n ? `${num(p.queued, 2)} $liquid is waiting for the first deposit` : "Nothing is being paid right now";
}

/** The card for one pool, or nothing while the pool does not exist. */
export function card(S, key) {
  if (!poolOn(S, key)) return "";
  const c = cfgOf(S, key), p = S.pools[key], u = p.user, s = uiOf(key), sym = esc(c.symbol), dep = s.tab === "deposit";
  const row = (k, v) => `<div class="kv"><span>${k}</span><b class="r">${v}</b></div>`;
  const head = `<div class="label">Boost · paid in $liquid</div>
    <p class="note" style="margin:8px 0 12px">Deposit your ${sym} here and it earns $liquid as well. The $liquid comes from the reserve's yield, in a share the owner sets and can change at any time, including to zero. Take your ${sym} out whenever you like.</p>`;
  const facts = row("In the pool", `${num(p.total)} ${sym}`) + row("Being paid", esc(paying(p)));
  if (!p.tokenExists) {
    return `<section class="card" style="margin-bottom:44px" data-pool="${esc(key)}">${head}${facts}
      <div class="msg" style="margin-top:12px">${sym} does not exist on Elysium yet. This pool opens for deposits once it does.</div></section>`;
  }
  const mine = u ? row("Your deposit", `${num(u.deposited, 6)} ${sym}`) + row("You have earned", `${num(u.earned, 4)} $liquid`) : "";
  const bal = !u ? "" : dep ? `In your wallet: ${num(u.wallet, 6)} ${sym}` : `Deposited: ${num(u.deposited, 6)} ${sym}`;
  const label = !wallet.account ? "Connect wallet" : s.busy ? "Confirm in your wallet…" : dep ? "Deposit" : "Take out";
  const msg = s.msg?.kind === "ok" ? `<div class="msg ok">${s.msg.html}</div>` : s.msg?.kind === "err" ? `<div class="msg err">${esc(s.msg.text)}</div>` : "";
  return `<section class="card" style="margin-bottom:44px" data-pool="${esc(key)}">${head}
    <div class="two" style="gap:18px;align-items:start">
      <div>${facts}${mine}
        ${u && u.earned > 0n ? `<button class="btn chrome" data-pclaim="${esc(key)}" type="button" ${s.busy ? "disabled" : ""} style="margin-top:12px">Claim ${num(u.earned, 4)} $liquid</button>` : ""}</div>
      <div>
        <div class="seggroup" role="group" aria-label="Deposit or take out" style="margin-bottom:12px">
          <button type="button" data-ptab="${esc(key)}:deposit" class="${dep ? "active" : ""}">Deposit</button>
          <button type="button" data-ptab="${esc(key)}:withdraw" class="${dep ? "" : "active"}">Take out</button></div>
        <div class="field"><label><span>${dep ? "You deposit" : "You take out"}</span><span>${esc(bal)}</span></label>
          <div class="in"><input data-pamt="${esc(key)}" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(s.text)}" aria-label="${dep ? `${sym} to deposit` : `${sym} to take out`}" />
            <button class="maxbtn" data-pmax="${esc(key)}" type="button">MAX</button><span class="sym">${sym}</span></div></div>
        ${msg}
        <button class="btn primary block" data-pgo="${esc(key)}" type="button" ${s.busy ? "disabled" : ""}>${label}</button>
        ${dep ? `<p class="note">Depositing takes two confirmations the first time: one to let the pool take your ${sym}, one to deposit it.</p>` : ""}
      </div>
    </div>
    <p class="note" style="margin-top:12px">Pool: ${explorer(S.cfg, "elysium", "address", c.pool)}. It has no owner and cannot be changed. It has not been audited. Rewards are streamed over a week, so a deposit made just before a payment earns very little of it.</p></section>`;
}

/** Wires up one pool's card after a draw. */
export function mount(S, api, key) {
  const root = document.querySelector(`[data-pool="${key}"]`);
  if (!root || !poolOn(S, key)) return;
  const c = cfgOf(S, key), s = uiOf(key), sym = c.symbol;
  const input = root.querySelector(`[data-pamt="${key}"]`);
  input?.addEventListener("input", () => { s.text = input.value; s.msg = null; });
  root.querySelectorAll("[data-ptab]").forEach((b) => b.addEventListener("click", () => { Object.assign(s, { tab: b.dataset.ptab.split(":")[1], text: "", msg: null }); api.render(); }));
  root.querySelector(`[data-pmax="${key}"]`)?.addEventListener("click", () => {
    const u = S.pools[key].user;
    if (!u || !input) return;
    const v = s.tab === "deposit" ? u.wallet : u.deposited, whole = v / E18, frac = (v % E18).toString().padStart(18, "0").replace(/0+$/, "");
    s.text = frac ? `${whole}.${frac}` : `${whole}`; // exact, as a decimal with 18 places
    input.value = s.text; s.msg = null;
  });
  const run = async (work) => {
    if (s.busy) return;
    try {
      if (!wallet.account) { await wallet.connect(); return api.refresh(); }
      s.busy = true; s.msg = null; api.render();
      const done = await work(S.pools[key].user, wallet.account);
      s.msg = { kind: "ok", html: done };
      s.text = "";
      await api.refresh();
    } catch (e) {
      s.msg = { kind: "err", text: e?.code === 4001 ? "Cancelled in your wallet. Nothing was sent." : String(e?.message || e).slice(0, 240) };
    }
    s.busy = false; api.render();
  };
  const link = (hash) => explorer(S.cfg, "elysium", "tx", hash, "View transaction");
  root.querySelector(`[data-pgo="${key}"]`)?.addEventListener("click", () => run(async (u) => {
    const want = parse18(s.text);
    if (want === 0n) throw new Error("Enter an amount first.");
    if (s.tab === "deposit") {
      if (u && want > u.wallet) throw new Error(`This wallet has ${num(u.wallet, 6)} ${sym}.`);
      // the pool may only take exactly what is being deposited
      if (!u || u.allowance < want) await wallet.send(c.token, P.approve + addr(c.pool) + uint(want), S.conn.e, 0n, GAS_PAD);
      const hash = await wallet.send(c.pool, P.stake + uint(want), S.conn.e, 0n, GAS_PAD);
      return `${esc(`Deposited ${num(want, 6)} ${sym}.`)} ${link(hash)}`;
    }
    if (u && want > u.deposited) throw new Error(`You have ${num(u.deposited, 6)} ${sym} in the pool.`);
    const hash = await wallet.send(c.pool, P.withdraw + uint(want), S.conn.e, 0n, GAS_PAD);
    return `${esc(`Took out ${num(want, 6)} ${sym}.`)} ${link(hash)}`;
  }));
  root.querySelector(`[data-pclaim="${key}"]`)?.addEventListener("click", () => run(async (u) => {
    const hash = await wallet.send(c.pool, P.claim, S.conn.e, 0n, GAS_PAD);
    return `${esc(`Claimed ${num(u?.earned ?? 0n, 4)} $liquid.`)} ${link(hash)}`;
  }));
}
