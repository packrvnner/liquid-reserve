#!/usr/bin/env python3
"""Builds the data for site/tools/nvda-route.html: lets the reserve convert the wNVDAx it receives as fees.

Why: the wNVDAx-USDC vault earns part of its fees in wNVDAx. The reserve's allocator turns whatever arrives into
its three parts, but it has no way to price or swap wNVDAx, so that wNVDAx stops at the vault fee inbox
(`allocate(wNVDAx)` reverts NoRoute). The same was true of wANTx; this is the same remedy.

What it adds, through the 48-hour timelock that owns the swapper and the oracle (one batch of seven calls):
  oracle.addFeed(the vault's wNVDAx/USDC pool)                     a 30-minute average price for wNVDAx
  oracle.setRoute(wNVDAx -> kHYPE | KNTQ | USDC)                   how the expected output is priced
  swapper.setRoute(wNVDAx -> kHYPE | KNTQ | USDC)                  where the swap goes
Every route starts with wNVDAx -> USDC in the vault's OWN pool (0.30%). wNVDAx is that pool's first token, so
paying it in is zeroForOne = true (for wANTx it is false). For kHYPE and KNTQ the USDC then takes the two hops the
reserve already uses for USDC fees (HYPE/USDC, then kHYPE/WHYPE or HYPE/KNTQ), copied here from the live routes.
Nothing else changes. The routes sit on the real oracle and the real swapper, which the HYPE-only router (if the
owner has finished that step) asks in turn: with it, the part the allocator would spend on KNTQ is locked as
kHYPE through the wNVDAx -> kHYPE route instead.

Why the vault's own pool and not one of the other pools that trade wNVDAx on Elysium: those belong to other
people (their liquidity can leave at any time, and the USDC one runs through a hook its owner can change), a
price feed can never be removed from the oracle, and the fees are earned in this pool in the first place.

The weak point, said plainly: that pool is thin and the vault is its only liquidity to begin with, so its
30-minute average is cheap to push around. What can be lost that way is the wNVDAx waiting on the fee path at that
moment, nothing else (the routes only ever start from wNVDAx).

The pool must exist before the batch can be FINISHED (the oracle refuses a feed on a pool that is not open), so
the vault is launched first.

  python3 script/nvda-route-data.py                  real network data
  python3 script/nvda-route-data.py --local          the same, for a local anvil fork (port 8611, or --port N)
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PATH": os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], "ETH_RPC_TIMEOUT": "180"}


def sh(*args):
    r = subprocess.run(list(args), capture_output=True, text=True, cwd=ROOT, env=ENV)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(args[:3])} failed: {r.stderr.strip()[:400]}")
    return r.stdout.strip()


LOCAL = "--local" in sys.argv
PORT = sys.argv[sys.argv.index("--port") + 1] if "--port" in sys.argv else "8611"
REAL = "https://rpc.elysium.kinetiq.xyz"
RPC = f"http://127.0.0.1:{PORT}" if LOCAL else REAL
V = json.load(open(os.path.join(ROOT, "site", "tools", "nvda-vault-data.json")))   # the vault's launch data
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
TIMELOCK = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
STATE_VIEW = "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE"
ORACLE = "0x51670e163023CC3fa63d857A655A430321Fc1f56"
SWAPPER = "0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4"
Z = "0x0000000000000000000000000000000000000000"
WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0"
KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0"
USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65"
WNVDAX = "0x11265018bF2d5a99fb71EFaE73aD670203C1dF44"
DELAY = 172800
POOL_FEE_PIPS = 3000  # the vault's pool charges 0.30%
assert V["elysium"]["wnvdax"].lower() == WNVDAX.lower() and V["elysium"]["usdc"].lower() == USDC.lower()

# pool keys: (currency0, currency1, fee, tickSpacing, hooks), and their ids
NVDA = (f"({WNVDAX},{USDC},3000,60,{Z})", V["elysium"]["pool"])
KHYPE_WHYPE = (f"({KHYPE},{WHYPE},8388608,1,0x8129bab872318a64B0e6212C6C491feED06C3de3)", "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c")
HYPE_KNTQ = (f"({Z},{KNTQ},3000,60,{Z})", "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a")
HYPE_USDC = (f"({Z},{USDC},3000,60,{Z})", "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc")
# after the first hop the reserve holds USDC; per target, the hops that follow: (pool, zeroForOne, oracle fee)
AFTER = {
    KHYPE: [(HYPE_USDC, "false", 3000), (KHYPE_WHYPE, "false", 0)],
    KNTQ: [(HYPE_USDC, "false", 3000), (HYPE_KNTQ, "true", 3000)],
    USDC: [],
}

# The pool id above must be the id of the key above, and the later hops must be the reserve's live USDC routes
# (read from the real network whatever the target, so a used fork cannot mislead).
key_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address,address,uint24,int24,address)", WNVDAX, USDC, "3000", "60", Z))
assert key_id.lower() == NVDA[1].lower(), f"pool id mismatch: {key_id}"
assert int(WNVDAX, 16) < int(USDC, 16), "wNVDAx must be the pool's first token"
for out, hops in AFTER.items():
    if not hops:
        continue
    live = sh("cast", "call", ORACLE, "getRoute(address,address)(bytes32[],uint24[])", USDC, out, "--rpc-url", REAL).split("\n")
    want_path = "[" + ", ".join(h[0][1] for h in hops) + "]"
    want_fees = "[" + ", ".join(str(h[2]) for h in hops) + "]"
    assert live[0].strip().lower() == want_path.lower() and live[1].strip() == want_fees, f"the live USDC route to {out} is not what this script copies: {live}"
    SWAP_SIG = "getRoute(address,address)((uint8,(address,address,uint24,int24,address),bool,address)[])"
    # cast prints a large number twice ("8388608 [8.388e6]"): drop the second form before comparing
    swap_live = re.sub(r" \[[0-9.e]+\]", "", sh("cast", "call", SWAPPER, SWAP_SIG, USDC, out, "--rpc-url", REAL)).lower().replace(" ", "")
    for h in hops:
        want = f"(0,{h[0][0]},{h[1]},{Z})".lower()
        assert want in swap_live, f"the live USDC swap route to {out} does not have the hop this script copies: {want}"
assert sh("cast", "call", ORACLE, "owner()(address)", "--rpc-url", REAL).lower() == TIMELOCK.lower(), "the oracle's owner is not the timelock"
assert sh("cast", "call", SWAPPER, "owner()(address)", "--rpc-url", REAL).lower() == TIMELOCK.lower(), "the swapper's owner is not the timelock"

HOPS = "(uint8,(address,address,uint24,int24,address),bool,address)[]"
calls = [(ORACLE, sh("cast", "calldata", "addFeed((address,address,uint24,int24,address))", NVDA[0]), "price feed: the vault's wNVDAx/USDC pool")]
NAMES = {KHYPE: "kHYPE", KNTQ: "KNTQ", USDC: "USDC"}
for out, hops in AFTER.items():
    path = "[" + ",".join([NVDA[1]] + [h[0][1] for h in hops]) + "]"
    fees = "[" + ",".join([str(POOL_FEE_PIPS)] + [str(h[2]) for h in hops]) + "]"
    calls.append((ORACLE, sh("cast", "calldata", "setRoute(address,address,bytes32[],uint24[])", WNVDAX, out, path, fees), f"price route: wNVDAx -> {NAMES[out]}"))
for out, hops in AFTER.items():
    # wNVDAx is the pool's first token, so paying it in is zeroForOne = true
    route = "[" + ",".join([f"(0,{NVDA[0]},true,{Z})"] + [f"(0,{h[0][0]},{h[1]},{Z})" for h in hops]) + "]"
    calls.append((SWAPPER, sh("cast", "calldata", f"setRoute(address,address,{HOPS})", WNVDAX, out, route), f"swap route: wNVDAx -> {NAMES[out]}"))

targets = "[" + ",".join(c[0] for c in calls) + "]"
values = "[" + ",".join("0" for _ in calls) + "]"
payloads = "[" + ",".join(c[1] for c in calls) + "]"
zero = "0x" + "00" * 32
salt = sh("cast", "keccak", "liquid-reserve.nvda-route.v1")
schedule = sh("cast", "calldata", "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", targets, values, payloads, zero, salt, str(DELAY))
execute = sh("cast", "calldata", "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, salt))

data = {
    "chainId": 99901,
    "rpc": RPC,
    "explorer": "https://elyscan.live",
    "owner": OWNER, "timelock": TIMELOCK, "multicall": MULTICALL3, "stateView": STATE_VIEW,
    "oracle": ORACLE, "swapper": SWAPPER, "wnvdax": WNVDAX, "khype": KHYPE, "vault": V["elysium"]["vault"],
    "pool": NVDA[1], "poolFeePips": POOL_FEE_PIPS,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out_file = os.path.join(ROOT, "site", "tools", "nvda-route-data.local.json" if LOCAL else "nvda-route-data.json")
json.dump(data, open(out_file, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": salt, "calls": [{"to": c[0], "what": c[2], "data": c[1]} for c in calls]}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "nvda-route-data.json"), "w"), indent=2)
print(f"operation id  {op_id}")
print(f"calls         {len(calls)}")
print(f"wrote         {os.path.relpath(out_file, ROOT)}")
