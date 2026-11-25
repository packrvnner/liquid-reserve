export const units = (v, decimals = 18) => Number(v) / 10 ** decimals;

const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export function usd(n) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${trim((n / 1e9).toFixed(2))}B`;
  if (a >= 1e6) return `$${trim((n / 1e6).toFixed(2))}M`;
  if (a >= 1e4) return `$${trim((n / 1e3).toFixed(1))}K`;
  if (a >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (a >= 1) return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
  if (a === 0) return "$0";
  if (a >= 0.001) return `$${trim(n.toFixed(3))}`;
  return `$${n.toPrecision(2)}`;
}

export function amount(n) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${trim((n / 1e9).toFixed(2))}B`;
  if (a >= 1e6) return `${trim((n / 1e6).toFixed(2))}M`;
  if (a >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a < 1e-6) return "0";
  return n.toPrecision(3);
}

// four significant digits, never in exponent form (a new coin can cost a millionth of a dollar)
export const price = (n) => (!isFinite(n) || n <= 0 ? "—" : n >= 1 ? usd(n) : `$${n.toFixed(Math.min(14, 3 - Math.floor(Math.log10(n))))}`);
export const pct = (n, digits = 1) => (isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—");
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function ago(seconds) {
  if (seconds < 0) seconds = 0;
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function duration(seconds) {
  if (seconds <= 0) return "now";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
