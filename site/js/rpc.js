// Minimal JSON-RPC client.
// - Calls made in the same tick go out as one batch.
// - Public RPCs are rate-limited (Elysium's allows about 7 requests a second), so
//   requests are paced: at most a few calls in any window of about a second. A call
//   goes out at once while there is room in the window (it does not wait for earlier
//   answers), and anything the node rejects for rate reasons is retried instead of
//   failing the page.
// - multicall() packs many read calls into ONE request through Multicall3, and sets
//   asked for in the same tick by different parts of the page share that one request.
import { encodeAggregate3, decodeAggregate3 } from "./abi.js";

const RATE = /rate limit|too many requests/i;
const CHUNK = 400; // most read calls in one Multicall3 request (150 of them cost under 1M gas); larger sets are split and sent side by side
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Rpc {
  constructor(url, name, opts = {}) {
    this.url = url;
    this.name = name;
    this.queue = [];
    this.nextId = 1;
    this.ok = null; // did the last request succeed?
    const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
    this.perWindow = opts.perWindow ?? (local ? 40 : 6);
    this.windowMs = opts.windowMs ?? (local ? 0 : 1100);
    this.multicallAddr = opts.multicall || null;
    this.busy = false;
    this.sent = []; // when each recent call went out
    this.blockedUntil = 0; // set after the node says "slow down"
    this.timer = null;
    this.sets = []; // multicall sets waiting to be joined into one request
  }

  kick() {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.joinSets(); this.pump(); }, 0);
  }

  /** Joins the multicall sets asked for in this tick into as few requests as possible; each caller gets its own answers back. */
  joinSets() {
    const sets = this.sets.splice(0);
    if (!sets.length) return;
    const all = sets.flatMap((x) => x.calls), parts = [];
    for (let i = 0; i < all.length; i += CHUNK) parts.push(all.slice(i, i + CHUNK));
    // Placed ahead of anything else waiting: current state matters more than history when the rate limit makes something wait.
    const entries = [];
    const answers = parts.map((part) => new Promise((resolve, reject) => {
      entries.push({ id: this.nextId++, method: "eth_call", params: [{ to: this.multicallAddr, data: encodeAggregate3(part) }, "latest"], resolve, reject, tries: 0 });
    }));
    this.queue.unshift(...entries);
    Promise.all(answers)
      .then((res) => {
        const flat = res.flatMap((a) => decodeAggregate3(a));
        let at = 0;
        for (const x of sets) { x.resolve(flat.slice(at, at + x.calls.length)); at += x.calls.length; }
      })
      .catch((err) => { for (const x of sets) x.reject(err); });
  }

  request(method, params = []) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, method, params, resolve, reject, tries: 0 });
      this.kick();
    });
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const now = Date.now();
        if (now < this.blockedUntil) { await sleep(this.blockedUntil - now); continue; }
        this.sent = this.sent.filter((t) => now - t < this.windowMs);
        const room = this.perWindow - this.sent.length;
        if (room <= 0) { await sleep(this.sent[0] + this.windowMs - now + 5); continue; }
        const part = this.queue.splice(0, room);
        for (let i = 0; i < part.length; i++) this.sent.push(now);
        this.send(part); // not awaited: the next calls go out as soon as the rate allows, not after this answer
      }
    } finally {
      this.busy = false;
    }
  }

  /** Puts rate-limited calls back at the front of the queue; gives up after a few tries. */
  retry(calls, error) {
    const again = [];
    for (const c of calls) {
      if (c.tries++ < 5) again.push(c);
      else c.reject(error);
    }
    this.queue.unshift(...again);
    this.blockedUntil = Date.now() + Math.max(this.windowMs, 300);
    if (again.length) this.kick();
  }

  async send(part) {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(part.map(({ id, method, params }) => ({ jsonrpc: "2.0", id, method, params }))),
      });
      if (res.status === 429) return this.retry(part, new Error(`${this.name} RPC is rate-limiting this connection`));
      if (!res.ok) throw new Error(`${this.name} RPC HTTP ${res.status}`);
      const out = await res.json();
      const byId = new Map((Array.isArray(out) ? out : [out]).map((r) => [r.id, r]));
      this.ok = true;
      const limited = [];
      for (const c of part) {
        const r = byId.get(c.id);
        if (!r) c.reject(new Error("missing response"));
        else if (r.error && RATE.test(r.error.message ?? "")) limited.push(c);
        else if (r.error) c.reject(Object.assign(new Error(r.error.message), { rpcError: r.error }));
        else c.resolve(r.result);
      }
      if (limited.length) this.retry(limited, new Error(`${this.name} RPC is rate-limiting this connection`));
    } catch (e) {
      this.ok = false;
      for (const c of part) c.reject(e);
    }
  }

  call(to, data) {
    return this.request("eth_call", [{ to, data }, "latest"]);
  }

  /**
   * Many read calls in one request. calls: [{ to, data }]. Returns return data
   * per call, or null where a call reverted. A call to an address with no
   * contract comes back as "0x".
   */
  multicall(calls) {
    if (!calls.length) return Promise.resolve([]);
    if (!this.multicallAddr) return Promise.all(calls.map((c) => this.call(c.to, c.data).catch(() => null)));
    return new Promise((resolve, reject) => {
      this.sets.push({ calls, resolve, reject });
      this.kick();
    });
  }

  /** True if the call reverts (used for the "no owner" proof). */
  async reverts(to, data) {
    try {
      await this.call(to, data);
      return false;
    } catch (e) {
      if (e.rpcError) return true;
      throw e;
    }
  }
}
