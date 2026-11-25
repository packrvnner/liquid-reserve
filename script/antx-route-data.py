#!/usr/bin/env python3
"""Builds the data for site/tools/antx-route.html: lets the reserve convert the wANTx it receives as fees.

Why: the wANTx-USDC vault earns part of its fees in wANTx. The reserve's allocator turns whatever arrives into
kHYPE (40%), KNTQ (40%) and USDC (20%, parked), but it had no way to price or swap wANTx, so that wANTx stopped
at the vault fee inbox (`allocate(wANTx)` would revert NoRoute).

What it adds, through the 48-hour timelock that owns the swapper and the oracle (one batch of seven calls):
  oracle.addFeed(the vault's USDC/wANTx pool)                      a 30-minute average price for wANTx
  oracle.setRoute(wANTx -> kHYPE | KNTQ | USDC)                    how the expected output is priced
  swapper.setRoute(wANTx -> kHYPE | KNTQ | USDC)                   where the swap goes
Every route starts with wANTx -> USDC in the vault's own pool (0.30%), the only place wANTx trades on Elysium.
For kHYPE and KNTQ the USDC then takes the two hops the reserve already uses for USDC fees (HYPE/USDC, then
kHYPE/WHYPE or HYPE/KNTQ), copied here from the live routes. Nothing else changes: the allocator, its 40/40/20
split and the 1% slippage limit are fixed in code.

The weak point, said plainly: that pool is thin and the vault is its only liquidity, so its 30-minute average is
cheap to push around. What can be lost that way is the wANTx waiting on the fee path at that moment, nothing else
(the routes only ever start from wANTx).

  python3 script/antx-route-data.py            real network data
  python3 script/antx-route-data.py --local    the same, for a local anvil fork on port 8597
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
RPC = "http://127.0.0.1:8597" if LOCAL else "https://rpc.elysium.kinetiq.xyz"
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
WANTX = "0xd7d0288Cef796cCc5752B4352f80b74aD2929334"
DELAY = 172800
POOL_FEE_PIPS = 3000  # the vault's pool charges 0.30%

# pool keys: (currency0, currency1, fee, tickSpacing, hooks), and their ids
ANTX = (f"({USDC},{WANTX},3000,60,{Z})", "0x8df1ba0bdc5bcba046cbaa33ee32a17f209c39d008cd204931eff3ab76430851")
KHYPE_WHYPE = (f"({KHYPE},{WHYPE},8388608,1,0x8129bab872318a64B0e6212C6C491feED06C3de3)", "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c")
HYPE_KNTQ = (f"({Z},{KNTQ},3000,60,{Z})", "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a")
HYPE_USDC = (f"({Z},{USDC},3000,60,{Z})", "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc")
# after the first hop the reserve holds USDC; per target, the hops that follow: (pool, zeroForOne, oracle fee)
AFTER = {
    KHYPE: [(HYPE_USDC, "false", 3000), (KHYPE_WHYPE, "false", 0)],
    KNTQ: [(HYPE_USDC, "false", 3000), (HYPE_KNTQ, "true", 3000)],
    USDC: [],
}

# The pool id above must be the id of the key above, and the later hops must be the reserve's live USDC routes.
key_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address,address,uint24,int24,address)", USDC, WANTX, "3000", "60", Z))
assert key_id.lower() == ANTX[1].lower(), f"pool id mismatch: {key_id}"
for out, hops in AFTER.items():
    if not hops:
        continue
    live = sh("cast", "call", ORACLE, "getRoute(address,address)(bytes32[],uint24[])", USDC, out, "--rpc-url", RPC).split("\n")
    want_path = "[" + ", ".join(h[0][1] for h in hops) + "]"
    want_fees = "[" + ", ".join(str(h[2]) for h in hops) + "]"
    assert live[0].strip().lower() == want_path.lower() and live[1].strip() == want_fees, f"the live USDC route to {out} is not what this script copies: {live}"

HOPS = "(uint8,(address,address,uint24,int24,address),bool,address)[]"
calls = [(ORACLE, sh("cast", "calldata", "addFeed((address,address,uint24,int24,address))", ANTX[0]), "price feed: the vault's USDC/wANTx pool")]
for out, hops in AFTER.items():
    path = "[" + ",".join([ANTX[1]] + [h[0][1] for h in hops]) + "]"
    fees = "[" + ",".join([str(POOL_FEE_PIPS)] + [str(h[2]) for h in hops]) + "]"
    calls.append((ORACLE, sh("cast", "calldata", "setRoute(address,address,bytes32[],uint24[])", WANTX, out, path, fees), f"price route: wANTx -> {out}"))
for out, hops in AFTER.items():
    # wANTx is the pool's second token, so paying it in is zeroForOne = false
    route = "[" + ",".join([f"(0,{ANTX[0]},false,{Z})"] + [f"(0,{h[0][0]},{h[1]},{Z})" for h in hops]) + "]"
    calls.append((SWAPPER, sh("cast", "calldata", f"setRoute(address,address,{HOPS})", WANTX, out, route), f"swap route: wANTx -> {out}"))

targets = "[" + ",".join(c[0] for c in calls) + "]"
values = "[" + ",".join("0" for _ in calls) + "]"
payloads = "[" + ",".join(c[1] for c in calls) + "]"
zero = "0x" + "00" * 32
salt = sh("cast", "keccak", "liquid-reserve.antx-route.v1")
schedule = sh("cast", "calldata", "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", targets, values, payloads, zero, salt, str(DELAY))
execute = sh("cast", "calldata", "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, salt))

data = {
    "chainId": 99901,
    "rpc": RPC,
    "explorer": "https://elyscan.live",
    "owner": OWNER, "timelock": TIMELOCK, "multicall": MULTICALL3,
    "oracle": ORACLE, "swapper": SWAPPER, "wantx": WANTX, "khype": KHYPE,
    "pool": ANTX[1], "poolFeePips": POOL_FEE_PIPS,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out_file = os.path.join(ROOT, "site", "tools", "antx-route-data.local.json" if LOCAL else "antx-route-data.json")
json.dump(data, open(out_file, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": salt, "calls": [{"to": c[0], "what": c[2], "data": c[1]} for c in calls]}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "antx-route-data.json"), "w"), indent=2)
print(f"operation id  {op_id}")
print(f"calls         {len(calls)}")
print(f"wrote         {os.path.relpath(out_file, ROOT)}")
