#!/usr/bin/env python3
"""sKNTQ's own rate (the KNTQ that 1 sKNTQ redeems for) since sKNTQ began, for the KNTQ staking announcement image.

Read from public HyperEVM archive endpoints; a value is only kept when two endpoints agree on it. Weekly samples,
plus the two turning points (when the rate first rose, and when it reached today's value).

  python3 script/skntq-rate-history.py        writes site/brand/src/kntq-staking-data.json
"""
import datetime
import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKNTQ = "0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F"
RATE = "0x07a2d13a" + f"{10**18:064x}"  # convertToAssets(1e18)
ARCHIVES = ["https://rpc.purroofgroup.com", "https://rpc.hyperlend.finance/archive", "https://hyperliquid.drpc.org"]
HEAD = "https://rpc.hyperliquid.xyz/evm"
ONE = 10**18


def rpc(url, method, params, tries=5):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for n in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "liquid-reserve-history/1"})
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read())
            if "error" in j:
                return None
            return j["result"]
        except Exception:
            time.sleep(1.2 * (n + 1))
    return None


def rate_at(block):
    """sKNTQ's rate at a block, when two archive endpoints agree; 0 before sKNTQ existed; -1 when they do not agree."""
    seen = []
    for u in ARCHIVES:
        r = rpc(u, "eth_call", [{"to": SKNTQ, "data": RATE}, hex(block)])
        seen.append(int(r, 16) if r and len(r) >= 66 else 0)
        if len(seen) >= 2 and seen.count(seen[-1]) >= 2:
            return seen[-1]
    return -1


def stamp(block):
    for u in ARCHIVES + [HEAD]:
        b = rpc(u, "eth_getBlockByNumber", [hex(block), False])
        if b:
            return int(b["timestamp"], 16)
    return None


def first_block(test, lo, hi):
    """The first block in [lo, hi] at which test(rate) holds (the rate never falls, so this is a clean search)."""
    while lo < hi:
        mid = (lo + hi) // 2
        r = rate_at(mid)
        if r < 0:
            raise SystemExit(f"the archive endpoints disagree at block {mid}")
        if test(r):
            hi = mid
        else:
            lo = mid + 1
    return lo


head = int(rpc(HEAD, "eth_blockNumber", []), 16) - 5
final = rate_at(head)
assert final > ONE, final
began = first_block(lambda r: r >= ONE, 1, head)
rose = first_block(lambda r: r > ONE, began, head)
settled = first_block(lambda r: r >= final, rose, head)
blocks = sorted(set(list(range(began, head, 7 * 86_400)) + [rose - 1, rose, settled - 1, settled, head]))


def one(b):
    return b, stamp(b), rate_at(b)


with ThreadPoolExecutor(max_workers=6) as pool:
    rows = sorted(x for x in pool.map(one, blocks) if x[1] and x[2] >= ONE)
assert all(rows[i][2] >= rows[i - 1][2] for i in range(1, len(rows))), "the rate went down between samples"
point = lambda b: next([t, r / 1e18] for bb, t, r in rows if bb == b)
out = {
    "now": int(time.time()),
    "rate": [[t, r / 1e18] for _, t, r in rows],
    "marks": {"first": point(began), "roseFrom": point(rose - 1), "settled": point(settled), "latest": point(head)},
    "blocks": {"first": began, "roseFrom": rose - 1, "settled": settled, "latest": head},
}
path = os.path.join(ROOT, "site", "brand", "src", "kntq-staking-data.json")
json.dump(out, open(path, "w"))
day = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
m = out["marks"]
days = (m["latest"][0] - m["first"][0]) / 86_400
print(f"sKNTQ began   {day(m['first'][0])}  rate {m['first'][1]:.6f}")
print(f"rate rose from {day(m['roseFrom'][0])}")
print(f"settled        {day(m['settled'][0])}  rate {m['settled'][1]:.6f}")
print(f"latest         {day(m['latest'][0])}  rate {m['latest'][1]:.6f}")
print(f"{len(rows)} samples; +{(m['latest'][1] / m['first'][1] - 1) * 100:.3f}% over {days:.1f} days = {((m['latest'][1] / m['first'][1]) ** (365 / days) - 1) * 100:.2f}% a year")
print(f"while it was rising ({(m['settled'][0] - m['roseFrom'][0]) / 86_400:.0f} days): {((m['settled'][1] / m['roseFrom'][1]) ** (365 * 86_400 / (m['settled'][0] - m['roseFrom'][0])) - 1) * 100:.2f}% a year")
print("wrote", os.path.relpath(path, ROOT))
