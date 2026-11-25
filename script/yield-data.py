#!/usr/bin/env python3
"""Builds the data for site/tools/yield.html: where the reserve's yield goes.

The locked reserve lets only its yield out. A fifth already goes to the creator (YieldSplit). The other four fifths
wait in YieldRest, whose destination can be set once, for good, by the 48-hour timelock. `src/YieldDirector.sol`
becomes that destination. It splits the yield by shares the owner's wallet can change at any time, between:
compounding into the reserve, the $liquid drop, and reward pools paid in $liquid (`src/staking/RewardPool.sol`),
to start with one for people who deposit liquidHYPE and one for liquidKNTQ. New destinations can only be added
through the timelock.

Three steps on the page, then a form for the shares:
  1  create the two reward pools and the director (any wallet; one transaction through Multicall3 and the
     standard CREATE2 factory, so the addresses are known beforehand)
  2  timelock: start the 48 hours (owner wallet)
       oracle.setRoute(kHYPE -> $liquid)     kHYPE/HYPE, then Ascend's pool (2% fee)
       swapper.setRoute(kHYPE -> $liquid)
       yieldRest.setTarget(director)         PERMANENT
  3  timelock: finish (owner wallet, 48 hours later)
The director hands the drop's share to the drop feeder (script/drop-data.py), so the feeder has to exist before
yield with a share for the drop can be distributed.

  python3 script/yield-data.py                      real network data
  python3 script/yield-data.py --local [--port N]   the same, for a local anvil fork (default port 8597)
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
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"  # also the manager who sets the shares
TIMELOCK = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"  # the standard CREATE2 factory
SWAP_CONFIG = "0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87"
ORACLE = "0x51670e163023CC3fa63d857A655A430321Fc1f56"
SWAPPER = "0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4"
RESERVE = "0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61"
YIELD_SPLIT = "0x5b1429a97818E68aF558CcD84cbDab5756520675"
YIELD_REST = "0x14938d73fdCF459c07fB749dbA21DE76e4519938"
Z = "0x0000000000000000000000000000000000000000"
WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0"
LIQUID = "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6"
LIQUID_HYPE = "0x5B550c1DAd656B688Da2422baBb11470f5f419B0"  # the HYPE staking vault's token
LIQUID_KNTQ = "0xf15903dc81e8736Ee107a481b58C57db48482e09"  # the bridged KNTQ staking token; exists on Elysium once the first batch has crossed
DELAY = 172800
ASCEND_FEE_PIPS = 20000
# the first shares, in the order of the director's destinations: compound, the drop, HYPE stakers, KNTQ stakers
NAMES = ["Compound into the reserve", "The drop", "HYPE stakers (deposit liquidHYPE)", "KNTQ stakers (deposit liquidKNTQ)"]
SHARES = [2500, 2500, 2500, 2500]

ASCEND = (f"({LIQUID},{WHYPE},8388608,200,0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC)", "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c")
KHYPE_WHYPE = (f"({KHYPE},{WHYPE},8388608,1,0x8129bab872318a64B0e6212C6C491feED06C3de3)", "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c")

call = lambda to, sig, *a: sh("cast", "call", to, sig, *a, "--rpc-url", RPC).split()[0]
same = lambda a, b: a.lower() == b.lower()
FEEDER = json.load(open(os.path.join(ROOT, "site", "tools", "drop-data.json")))["feeder"]  # from script/drop-data.py

# What this script takes for granted about the live contracts. Checked every time it runs.
assert same(call(YIELD_SPLIT, "recipientB()(address)"), YIELD_REST), "the yield splitter's larger part does not go to YieldRest"
assert same(call(YIELD_REST, "setter()(address)"), TIMELOCK), "YieldRest's destination is not set by the timelock"
target = call(YIELD_REST, "target()(address)")
assert same(call(RESERVE, "assetAt(uint256)(address)", "0"), KHYPE), "the reserve does not hold kHYPE"
assert same(call(LIQUID_HYPE, "asset()(address)"), KHYPE), "the liquidHYPE vault is not over kHYPE"
assert sum(SHARES) == 10000 and len(SHARES) == len(NAMES) == 4


def c2(contract, salt_text, types, values):
    """(address, CREATE2 factory call data) of a deployment through the standard factory."""
    salt = sh("cast", "keccak", salt_text)
    args = sh("cast", "abi-encode", f"f({types})", *values)
    init = sh("forge", "inspect", contract, "bytecode") + args[2:]
    addr = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + salt[2:] + sh("cast", "keccak", init)[2:])[-40:])
    return addr, salt + init[2:], args


hype_pool, d_hype, a_hype = c2("src/staking/RewardPool.sol:RewardPool", "liquid-reserve.reward-pool.liquidhype.v1", "address,address", [LIQUID_HYPE, LIQUID])
kntq_pool, d_kntq, a_kntq = c2("src/staking/RewardPool.sol:RewardPool", "liquid-reserve.reward-pool.liquidkntq.v1", "address,address", [LIQUID_KNTQ, LIQUID])
director, d_dir, a_dir = c2(
    "src/YieldDirector.sol:YieldDirector", "liquid-reserve.yield-director.v1",
    "address,address,address,address,address,address,address,address,address,address[],uint16[]",
    [TIMELOCK, OWNER, KHYPE, LIQUID, RESERVE, FEEDER, ORACLE, SWAPPER, SWAP_CONFIG, f"[{hype_pool},{kntq_pool}]", "[" + ",".join(map(str, SHARES)) + "]"])
assert same(target, Z) or same(target, director), f"YieldRest already points somewhere else: {target}"
# one transaction creates all three: Multicall3 calls the factory three times, and none may fail
create = sh("cast", "calldata", "aggregate3((address,bool,bytes)[])", "[" + ",".join(f"({FACTORY},false,{d})" for d in (d_hype, d_kntq, d_dir)) + "]")

# ---- the timelock batch. kHYPE -> HYPE in the kHYPE pool (kHYPE is its first token), then HYPE -> $liquid in
# Ascend's pool ($liquid is its first token, so paying HYPE in is zeroForOne = false).
HOPS = "(uint8,(address,address,uint24,int24,address),bool,address)[]"
calls = [
    (ORACLE, sh("cast", "calldata", "setRoute(address,address,bytes32[],uint24[])", KHYPE, LIQUID, f"[{KHYPE_WHYPE[1]},{ASCEND[1]}]", f"[0,{ASCEND_FEE_PIPS}]"), "price route: kHYPE -> $liquid"),
    (SWAPPER, sh("cast", "calldata", f"setRoute(address,address,{HOPS})", KHYPE, LIQUID, f"[(0,{KHYPE_WHYPE[0]},true,{Z}),(0,{ASCEND[0]},false,{Z})]"), "swap route: kHYPE -> $liquid"),
    (YIELD_REST, sh("cast", "calldata", "setTarget(address)", director), "the yield goes to the director, for good"),
]
targets = "[" + ",".join(c[0] for c in calls) + "]"
values = "[" + ",".join("0" for _ in calls) + "]"
payloads = "[" + ",".join(c[1] for c in calls) + "]"
zero = "0x" + "00" * 32
op_salt = sh("cast", "keccak", "liquid-reserve.yield-director.v1")
schedule = sh("cast", "calldata", "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", targets, values, payloads, zero, op_salt, str(DELAY))
execute = sh("cast", "calldata", "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, op_salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, op_salt))

data = {
    "chainId": 99901,
    "rpc": RPC,
    "explorer": "https://elyscan.live",
    "owner": OWNER, "timelock": TIMELOCK, "multicall": MULTICALL3,
    "yieldRest": YIELD_REST, "feeder": FEEDER,
    "director": director, "hypePool": hype_pool, "kntqPool": kntq_pool, "liquidKntq": LIQUID_KNTQ,
    "names": NAMES, "firstShares": SHARES,
    "create": create,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out_file = os.path.join(ROOT, "site", "tools", "yield-data.local.json" if LOCAL else "yield-data.json")
json.dump(data, open(out_file, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": op_salt, "constructorArgs": {"hypePool": a_hype, "kntqPool": a_kntq, "director": a_dir},
              "calls": [{"to": c[0], "what": c[2], "data": c[1]} for c in calls]}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "yield-data.json"), "w"), indent=2)
print(f"director      {director}")
print(f"pools         liquidHYPE {hype_pool}   liquidKNTQ {kntq_pool}")
print(f"create        {(len(create) - 2) // 2:,} bytes, one transaction")
print(f"operation id  {op_id}")
print(f"wrote         {os.path.relpath(out_file, ROOT)}")
