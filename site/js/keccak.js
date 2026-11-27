// Keccak-256, the hash Ethereum uses. The site precomputes every selector and topic it needs (see abi.js); this is
// for the one key it cannot know in advance: where a pool keeps a position, which depends on the position's range.
// Plain and slow (64-bit lanes as BigInt), which is fine for a few dozen bytes once per refresh.
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
  0x80000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // lane x + 5y
const M = (1n << 64n) - 1n;
const rol = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M);

function permute(s) {
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rol(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M & B[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

/** keccak256 of the bytes given as hex ("0x…" or bare). Returns "0x" and 64 hex digits. */
export function keccak256(hex) {
  const h = hex.replace(/^0x/, "");
  const bytes = [];
  for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  const RATE = 136;
  bytes.push(0x01);
  while (bytes.length % RATE !== 0) bytes.push(0);
  bytes[bytes.length - 1] |= 0x80;
  const s = new Array(25).fill(0n);
  for (let at = 0; at < bytes.length; at += RATE) {
    for (let i = 0; i < RATE; i++) s[i >> 3] ^= BigInt(bytes[at + i]) << BigInt(8 * (i & 7));
    permute(s);
  }
  let out = "";
  for (let i = 0; i < 32; i++) out += Number((s[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn).toString(16).padStart(2, "0");
  return "0x" + out;
}
