// Tiny ABI helpers. Selectors and event topics are precomputed (cast sig / cast keccak),
// so the site needs no crypto library.
export const SEL = {
  principal: "0x2ce0f9d6",
  valueOf: "0xa48028aa",
  pendingYield: "0xc7bf1980",
  assetCount: "0xeafe7a74",
  assetAt: "0xaa9239f5",
  yieldRouter: "0x08ccadd8",
  owner: "0x8da5cb5b",
  balanceOf: "0x70a08231",
  getSlot0: "0xc815641c",
  convertToAssets: "0x07a2d13a",
  totalStaked: "0x817b1cd2",
  rewardRate: "0x7b0a47ee",
  periodFinish: "0xebe2b12b",
  queuedRewards: "0x63d38c3b",
  payoutAddress: "0x5b8d02d7",
  feeds: "0xe90f1a43",
  minAmount: "0x9b2cb5d8",
  withdrawalDelay: "0xa7ab6961",
  nextWithdrawalRequestId: "0x35eb16a5",
  withdrawalRequest: "0x9d2ce6f6",
};

export const TOPIC = {
  Distributed: "0x60ce3cc2d133631eac66a476f14997a9fa682bd05a60dd993cf02285822d78d8",
  Allocated: "0x550466c302fb3fcd28d5f502af266537812f66ee8333b1035979e8cd09af29e6",
  Routed: "0x6a7479a3fc50aac2028aecb19a36990659266ff4faf3e0bea35bd4a781ebdbfc",
  Deposited: "0xf5681f9d0db1b911ac18ee83d515a1cf1051853a9eae418316a2fdf7dea427c5",
  Harvested: "0x81ca9b2c230070eaa84787556b1aaf18bf1e2f07ea5d3dae4819db77a1a5b224",
  PaidOut: "0xd6612f6d950855c64eb839ee777db67012c79adb6b084566bf69a6600a85b280",
  Bridged: "0x583c44171d9e72b72f8e9aabc33445b6f8aa102f763d58a941d9c6c19b3f9ec5",
  FeedAdded: "0xeef70127d22bfc4914a0e7ae7c31bd95af45f32a61cb62624938ba6d7cda81bf",
};

/** EIP-1967 implementation slot: zero means the contract is not an upgradeable proxy. */
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const addr = (a) => pad(a);
export const uint = (n) => pad(BigInt(n).toString(16));
export const b32 = (h) => pad(h);
export const encode = (selector, ...args) => selector + args.join("");

/** Splits return data into 32-byte words. */
export const words = (hex) => hex.replace(/^0x/, "").match(/.{64}/g) ?? [];
export const toUint = (w) => BigInt("0x" + (w || "0"));
export const toAddr = (w) => "0x" + w.slice(24);
export const topicAddr = (t) => "0x" + t.slice(26);

// ---- Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[]) ----
export const MULTICALL = { aggregate3: "0x82ad56cb", timestamp: "0x0f28c97d", ethBalance: "0x4d2301cc" };

export function encodeAggregate3(calls) {
  const tuples = calls.map(({ to, data }) => {
    const d = data.replace(/^0x/, ""), len = d.length / 2;
    return addr(to) + uint(1) + uint(0x60) + uint(len) + d.padEnd(Math.ceil(len / 32) * 64, "0");
  });
  let offsets = "", pos = calls.length * 32;
  for (const t of tuples) { offsets += uint(pos); pos += t.length / 2; }
  return MULTICALL.aggregate3 + uint(0x20) + uint(calls.length) + offsets + tuples.join("");
}

/** Returns each call's return data ("0x…"), or null where it failed. */
export function decodeAggregate3(hex) {
  const h = hex.replace(/^0x/, "");
  const num = (byte) => Number(BigInt("0x" + (h.slice(byte * 2, byte * 2 + 64) || "0")));
  const base = num(0), n = num(base), start = base + 32, out = [];
  for (let i = 0; i < n; i++) {
    const t = start + num(start + i * 32), b = t + num(t + 32), len = num(b);
    out.push(num(t) === 1 ? "0x" + h.slice((b + 32) * 2, (b + 32 + len) * 2) : null);
  }
  return out;
}
