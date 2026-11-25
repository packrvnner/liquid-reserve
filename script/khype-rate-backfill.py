#!/usr/bin/env python3
"""Reads the history of Kinetiq's kHYPE rate (HYPE per kHYPE) from HyperEVM, for the Stake page's chart and APY.

The rate is StakingAccountant.kHYPEToHYPE(1e18) on HyperEVM, Kinetiq's own redemption rate. HyperEVM's main public RPC
only answers for the newest block, so the past is read from public archive endpoints. Every sample is read from two
of them and kept only if they agree.

Samples: one a day (every 86,400 blocks, HyperEVM makes about one a second) from the first block the rate exists, and
one every four hours over the last 30 days. Output: a CSV of  unix_time,block,rate_wei  on stdout or in --out.

  python3 script/khype-rate-backfill.py --out /tmp/khype-rate.csv
  python3 script/khype-rate-backfill.py --since-block 51000000 --out more.csv     only newer samples

The archive endpoints are slow, so samples are read eight at a time. Run it again with the same --out and it
carries on where it stopped (blocks already in the file are skipped).
"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ACCOUNTANT = "0x9209648Ec9D448EF57116B73A2f081835643dc7A"
CALL = "0x" + "759bc2fc" + f"{10**18:064x}"  # kHYPEToHYPE(1e18)
ARCHIVES = ["https://hyperliquid.drpc.org", "https://rpc.purroofgroup.com", "https://rpc.hyperlend.finance/archive"]
HEAD_RPC = "https://rpc.hyperliquid.xyz/evm"
DAY, FOUR_HOURS, RECENT = 86_400, 14_400, 30 * 86_400


def rpc(url, method, params, tries=5):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for n in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "liquid-reserve-history/1"})
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read())
            if "error" in j:
                msg = str(j["error"].get("message", ""))
                if "revert" in msg.lower() or j["error"].get("code") == 3:
                    return None  # the contract did not exist yet (or the call reverted)
                raise RuntimeError(msg[:120])
            return j["result"]
        except Exception as e:  # rate limits and timeouts: wait and try again
            if n == tries - 1:
                raise
            time.sleep(1.5 * (n + 1))
    return None


def rate_at(url, block):
    r = rpc(url, "eth_call", [{"to": ACCOUNTANT, "data": CALL}, hex(block)])
    return int(r, 16) if r and len(r) >= 66 else 0


def agreed_rate(block):
    """The rate at a block, from two archive endpoints that give the same answer (0 when there is none)."""
    seen = []
    for url in ARCHIVES:
        try:
            seen.append(rate_at(url, block))
        except Exception:
            continue
        time.sleep(0.12)
        if len(seen) >= 2 and seen.count(seen[-1]) >= 2:
            return seen[-1]
    return seen[0] if len(seen) == 2 and seen[0] == seen[1] else -1


def stamp(block):
    for url in ARCHIVES:
        try:
            b = rpc(url, "eth_getBlockByNumber", [hex(block), False])
            if b:
                return int(b["timestamp"], 16)
        except Exception:
            continue
    raise RuntimeError(f"no timestamp for block {block}")


def main():
    args = sys.argv[1:]
    path = args[args.index("--out") + 1] if "--out" in args else None
    have = set()
    if path and os.path.exists(path):
        have = {int(l.split(",")[1]) for l in open(path) if l.strip()}
    out = open(path, "a") if path else sys.stdout
    since = int(args[args.index("--since-block") + 1]) if "--since-block" in args else None
    head = int(rpc(HEAD_RPC, "eth_blockNumber", []), 16)
    live = rate_at(HEAD_RPC, head)
    if not 10**18 <= live < 2 * 10**18:
        raise SystemExit(f"the rate call does not answer as expected ({live}); check the selector")
    if since is None and have:
        first = min(have)
    elif since is None:
        lo, hi = 1, head  # first block at which the rate can be read
        while lo < hi:
            mid = (lo + hi) // 2
            if rate_at(ARCHIVES[2], mid) >= 10**18:
                hi = mid
            else:
                lo = mid + 1
            time.sleep(0.1)
        first = lo
    else:
        first = since
    print(f"head {head}, rate now {live / 1e18:.6f}, first block with a rate {first}", file=sys.stderr)
    blocks = list(range(first, max(first, head - RECENT), DAY)) + list(range(max(first, head - RECENT), head, FOUR_HOURS)) + [head - 5]
    blocks = [b for b in sorted(set(blocks)) if b not in have]
    kept = bad = 0

    def one(b):
        try:
            r = agreed_rate(b)
            return (b, r, stamp(b) if r >= 10**18 else 0)
        except Exception:
            return (b, -1, 0)

    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, (b, r, t) in enumerate(pool.map(one, blocks)):
            if r < 10**18:
                bad += 1
                continue
            out.write(f"{t},{b},{r}\n")
            out.flush()
            kept += 1
            if i % 50 == 0:
                print(f"  {i}/{len(blocks)} block {b} rate {r / 1e18:.6f}", file=sys.stderr)
    print(f"done: {kept} new samples, {bad} skipped (no agreement or no rate), {len(have)} were already in the file", file=sys.stderr)


if __name__ == "__main__":
    main()
