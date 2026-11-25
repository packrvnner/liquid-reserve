#!/usr/bin/env python3
"""Builds the data for site/tools/drop.html: the $liquid drop.

The reserve's allocator sets a fifth of every fee aside as USDC in a waiting contract (liquidWait) whose
destination can be set once, for good, by the 48-hour timelock. `src/DropFeeder.sol` becomes that destination:
half of the USDC buys kHYPE for the reserve, half buys $liquid for the drop (the bot's wallet) until the drop
holds 5% of the unburned supply, and after that for Ascend's burn address.

Three steps on the page:
  1  create the feeder (any wallet; the standard CREATE2 factory, so its address is known beforehand)
  2  timelock: start the 48 hours (owner wallet)
       oracle.setRoute(USDC -> $liquid)      how the expected $liquid is priced: HYPE/USDC, then Ascend's pool (2% fee)
       swapper.setRoute(USDC -> $liquid)     where the swap goes
       liquidWait.setTarget(feeder)          PERMANENT
  3  timelock: finish (owner wallet, 48 hours later)
Step 3 also needs the $liquid route's own timelock step to be done first (it adds the price feed for Ascend's
pool); the batch names it as its predecessor, so the timelock refuses the wrong order.

  python3 script/drop-data.py                      real network data
  python3 script/drop-data.py --local [--port N]   the same, for a local anvil fork (default port 8597)
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
PORT = sys.argv[sys.argv.index("--port") + 1] if "--port" in sys.argv else "8597"
RPC = f"http://127.0.0.1:{PORT}" if LOCAL else "https://rpc.elysium.kinetiq.xyz"
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
TIMELOCK = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"  # the standard CREATE2 factory
SWAP_CONFIG = "0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87"
ORACLE = "0x51670e163023CC3fa63d857A655A430321Fc1f56"
SWAPPER = "0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4"
RESERVE = "0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61"
ALLOCATOR = "0xB7c3865FfF8e88276a1D57D31869A2b0a839356f"
LIQUID_WAIT = "0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB"
SEAT = "0x7D5b955B49F53E452853D0a087f9B3307DfA9B99"  # the coin's Ascend seat, which names the burn address
BOT = "0x0461663d46DA68264966a0670335E3ecf0b96F3C"  # the drop: the bot's wallet (the owner's choice)
Z = "0x0000000000000000000000000000000000000000"
WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0"
USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65"
LIQUID = "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6"
BURN_SINK = "0x9F0b0e3B362937b07Cd1E869b50687961e0c7741"
LIQUID_ROUTE_OP = "0x3e3514f7f93704c5e6509c1c678fee539ab39778dd9e3845fb26774693e67da6"  # adds the Ascend price feed
DELAY = 172800
ASCEND_FEE_PIPS = 20000  # Ascend's hook takes 2% of every trade; the pool's own fee field reads 0

# pool keys: (currency0, currency1, fee, tickSpacing, hooks), and their ids
ASCEND = (f"({LIQUID},{WHYPE},8388608,200,0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC)", "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c")
HYPE_USDC = (f"({Z},{USDC},3000,60,{Z})", "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc")

call = lambda to, sig, *a: sh("cast", "call", to, sig, *a, "--rpc-url", RPC).split()[0]
same = lambda a, b: a.lower() == b.lower()

# What this script takes for granted about the live contracts. Checked every time it runs.
assert same(call(ALLOCATOR, "destination2()(address)"), LIQUID_WAIT) and same(call(ALLOCATOR, "asset2()(address)"), USDC), "the allocator's set-aside share is not USDC at this waiting contract"
assert same(call(LIQUID_WAIT, "setter()(address)"), TIMELOCK), "the waiting contract's destination is not set by the timelock"
target = call(LIQUID_WAIT, "target()(address)")
assert same(call(SEAT, "burnSink()(address)"), BURN_SINK), "Ascend's burn address is not the one this script names"
assert sh("cast", "code", BURN_SINK, "--rpc-url", RPC) != "0x", "the burn address has no code"
assert same(call(RESERVE, "assetAt(uint256)(address)", "0"), KHYPE), "the reserve does not hold kHYPE"
assert same(call(ORACLE, "owner()(address)"), TIMELOCK) and same(call(SWAPPER, "owner()(address)"), TIMELOCK), "the oracle or swapper is not owned by the timelock"
live_khype_route = sh("cast", "call", ORACLE, "getRoute(address,address)(bytes32[],uint24[])", USDC, KHYPE, "--rpc-url", RPC).split("\n")[0]
assert HYPE_USDC[1] in live_khype_route.lower(), "the reserve has no USDC to kHYPE route through the HYPE/USDC pool"

# ---- the feeder, through the CREATE2 factory
salt = sh("cast", "keccak", "liquid-reserve.drop-feeder.v1")
args = sh("cast", "abi-encode", "f(address,address,address,address,address,address,address,address,address,address)",
          TIMELOCK, USDC, LIQUID, KHYPE, BURN_SINK, RESERVE, ORACLE, SWAPPER, SWAP_CONFIG, BOT)
init = sh("forge", "inspect", "src/DropFeeder.sol:DropFeeder", "bytecode") + args[2:]
feeder = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + salt[2:] + sh("cast", "keccak", init)[2:])[-40:])
create = salt + init[2:]
assert same(target, Z) or same(target, feeder), f"the waiting contract already points somewhere else: {target}"

# ---- the timelock batch. USDC -> HYPE in the HYPE/USDC pool (USDC is its second token), then HYPE -> $liquid in
# Ascend's pool ($liquid is its first token, so paying HYPE in is zeroForOne = false).
HOPS = "(uint8,(address,address,uint24,int24,address),bool,address)[]"
calls = [
    (ORACLE, sh("cast", "calldata", "setRoute(address,address,bytes32[],uint24[])", USDC, LIQUID, f"[{HYPE_USDC[1]},{ASCEND[1]}]", f"[3000,{ASCEND_FEE_PIPS}]"), "price route: USDC -> $liquid"),
    (SWAPPER, sh("cast", "calldata", f"setRoute(address,address,{HOPS})", USDC, LIQUID, f"[(0,{HYPE_USDC[0]},false,{Z}),(0,{ASCEND[0]},false,{Z})]"), "swap route: USDC -> $liquid"),
    (LIQUID_WAIT, sh("cast", "calldata", "setTarget(address)", feeder), "the set-aside share goes to the feeder, for good"),
]
targets = "[" + ",".join(c[0] for c in calls) + "]"
values = "[" + ",".join("0" for _ in calls) + "]"
payloads = "[" + ",".join(c[1] for c in calls) + "]"
op_salt = sh("cast", "keccak", "liquid-reserve.drop.v1")
schedule = sh("cast", "calldata", "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", targets, values, payloads, LIQUID_ROUTE_OP, op_salt, str(DELAY))
execute = sh("cast", "calldata", "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, LIQUID_ROUTE_OP, op_salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, LIQUID_ROUTE_OP, op_salt))

data = {
    "chainId": 99901,
    "rpc": RPC,
    "explorer": "https://elyscan.live",
    "owner": OWNER, "timelock": TIMELOCK, "multicall": MULTICALL3,
    "factory": FACTORY, "liquidWait": LIQUID_WAIT, "oracle": ORACLE, "swapper": SWAPPER, "reserve": RESERVE,
    "usdc": USDC, "liquid": LIQUID, "burnSink": BURN_SINK, "drop": BOT,
    "feeder": feeder, "create": create,
    "liquidRouteId": LIQUID_ROUTE_OP,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out_file = os.path.join(ROOT, "site", "tools", "drop-data.local.json" if LOCAL else "drop-data.json")
json.dump(data, open(out_file, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": op_salt, "feederSalt": salt, "feederConstructorArgs": args, "calls": [{"to": c[0], "what": c[2], "data": c[1]} for c in calls]}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "drop-data.json"), "w"), indent=2)
print(f"feeder        {feeder}  ({(len(init) - 2) // 2:,} bytes to create)")
print(f"operation id  {op_id}")
print(f"wrote         {os.path.relpath(out_file, ROOT)}")
