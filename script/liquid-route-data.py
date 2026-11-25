#!/usr/bin/env python3
"""Builds the data for site/tools/liquid-route.html: lets the reserve convert the $liquid it receives as fees.

Why: the HYPE-$liquid vault earns part of its fees in $liquid. The reserve's allocator turns whatever arrives into
kHYPE (40%), KNTQ (40%) and USDC (20%, parked), but it had no way to price or swap $liquid, so that $liquid stopped
at the fee inbox (`allocate($liquid)` reverted NoRoute).

What it adds, through the 48-hour timelock that owns the swapper and the oracle (one batch of seven calls):
  oracle.addFeed(Ascend's $liquid/WHYPE pool)                      a 30-minute average price for $liquid
  oracle.setRoute($liquid -> kHYPE | KNTQ | USDC)                   how the expected output is priced
  swapper.setRoute($liquid -> kHYPE | KNTQ | USDC)                  where the swap goes
Each route is two hops: $liquid -> WHYPE in Ascend's pool (its hook takes Ascend's 2% fee, so the oracle prices that
hop with a 2% fee), then the hop the reserve already uses for WHYPE (kHYPE/WHYPE, HYPE/KNTQ or HYPE/USDC).
Nothing else changes: the allocator, its 40/40/20 split and the 1% slippage limit are fixed in code.

  python3 script/liquid-route-data.py            real network data
  python3 script/liquid-route-data.py --local    the same, for a local anvil fork on port 8597
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PATH": os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"]}


def sh(*args):
    r = subprocess.run(list(args), capture_output=True, text=True, cwd=ROOT, env=ENV)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(args[:3])} failed: {r.stderr.strip()[:400]}")
    return r.stdout.strip()


LOCAL = "--local" in sys.argv
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
TIMELOCK = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
ORACLE = "0x51670e163023CC3fa63d857A655A430321Fc1f56"
SWAPPER = "0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4"
Z = "0x0000000000000000000000000000000000000000"
WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0"
KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0"
USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65"
LIQUID = "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6"
DELAY = 172800
ASCEND_FEE_PIPS = 20000  # Ascend's hook takes 2% of every trade; the pool's own fee field reads 0

# pool keys: (currency0, currency1, fee, tickSpacing, hooks), and their ids
ASCEND = (f"({LIQUID},{WHYPE},8388608,200,0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC)", "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c")
KHYPE_WHYPE = (f"({KHYPE},{WHYPE},8388608,1,0x8129bab872318a64B0e6212C6C491feED06C3de3)", "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c")
HYPE_KNTQ = (f"({Z},{KNTQ},3000,60,{Z})", "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a")
HYPE_USDC = (f"({Z},{USDC},3000,60,{Z})", "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc")
# second hop per target: (pool, zeroForOne when paying WHYPE in, the fee the oracle already uses for that hop)
SECOND = {KHYPE: (KHYPE_WHYPE, "false", 0), KNTQ: (HYPE_KNTQ, "true", 3000), USDC: (HYPE_USDC, "true", 3000)}

HOPS = "(uint8,(address,address,uint24,int24,address),bool,address)[]"
calls = [(ORACLE, sh("cast", "calldata", "addFeed((address,address,uint24,int24,address))", ASCEND[0]), "price feed: Ascend's $liquid pool")]
for out, (pool, zero_for_one, fee) in SECOND.items():
    calls.append((ORACLE, sh("cast", "calldata", "setRoute(address,address,bytes32[],uint24[])", LIQUID, out, f"[{ASCEND[1]},{pool[1]}]", f"[{ASCEND_FEE_PIPS},{fee}]"), f"price route: $liquid -> {out}"))
for out, (pool, zero_for_one, fee) in SECOND.items():
    hops = f"[(0,{ASCEND[0]},true,{Z}),(0,{pool[0]},{zero_for_one},{Z})]"
    calls.append((SWAPPER, sh("cast", "calldata", f"setRoute(address,address,{HOPS})", LIQUID, out, hops), f"swap route: $liquid -> {out}"))

targets = "[" + ",".join(c[0] for c in calls) + "]"
values = "[" + ",".join("0" for _ in calls) + "]"
payloads = "[" + ",".join(c[1] for c in calls) + "]"
zero = "0x" + "00" * 32
salt = sh("cast", "keccak", "liquid-reserve.liquid-route.v1")
schedule = sh("cast", "calldata", "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", targets, values, payloads, zero, salt, str(DELAY))
execute = sh("cast", "calldata", "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, salt))

data = {
    "chainId": 99901,
    "rpc": "http://127.0.0.1:8597" if LOCAL else "https://rpc.elysium.kinetiq.xyz",
    "explorer": "https://elyscan.live",
    "owner": OWNER, "timelock": TIMELOCK, "multicall": MULTICALL3,
    "oracle": ORACLE, "swapper": SWAPPER, "liquid": LIQUID, "khype": KHYPE,
    "ascendPool": ASCEND[1], "ascendFeePips": ASCEND_FEE_PIPS,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out_file = os.path.join(ROOT, "site", "tools", "liquid-route-data.local.json" if LOCAL else "liquid-route-data.json")
json.dump(data, open(out_file, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": salt, "calls": [{"to": c[0], "what": c[2], "data": c[1]} for c in calls]}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "liquid-route-data.json"), "w"), indent=2)
print(f"operation id  {op_id}")
print(f"calls         {len(calls)}")
print(f"wrote         {os.path.relpath(out_file, ROOT)}")
