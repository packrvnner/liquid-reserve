#!/usr/bin/env python3
"""Builds the data for site/tools/hype-only.html: makes the reserve HYPE only.

Why: the reserve's allocator cannot be changed. It turns every fee into 40% kHYPE (locked on Elysium), 40% KNTQ
(bridged, staked and locked on HyperEVM) and 20% USDC (set aside). The owner wants the reserve to be 100% staked
HYPE. What the 48-hour timelock CAN change is which swap contract and which price source the allocator asks
(SwapConfig). `src/adapters/HypeOnlyRouter.sol` is set as both: it passes everything to the real ones, except
"anything to KNTQ", which it turns into kHYPE and locks in the reserve.

Three steps on the page:
  1  create the router (any wallet; the standard CREATE2 factory, so its address is known beforehand)
  2  timelock: start the 48 hours (owner wallet)        SwapConfig.setOracle(router), SwapConfig.setSwapper(router)
  3  timelock: finish (owner wallet, 48 hours later)
It can be put back the same way (the real oracle and swapper are untouched).

  python3 script/hype-only-data.py            real network data
  python3 script/hype-only-data.py --local    the same, for a local anvil fork on port 8597 (--port N for another)
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
PORT = sys.argv[sys.argv.index("--port") + 1] if "--port" in sys.argv else "8597"  # another session may be using 8597
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
KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0"
KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0"
DELAY = 172800

call = lambda to, sig, *a: sh("cast", "call", to, sig, *a, "--rpc-url", RPC).split()[0]
same = lambda a, b: a.lower() == b.lower()

# What this script takes for granted about the live contracts. Checked every time it runs.
assert same(call(ALLOCATOR, "swapConfig()(address)"), SWAP_CONFIG), "the allocator reads a different SwapConfig"
assert same(call(SWAP_CONFIG, "owner()(address)"), TIMELOCK), "SwapConfig is not owned by the timelock"
assert same(call(ALLOCATOR, "asset0()(address)"), KHYPE) and same(call(ALLOCATOR, "asset1()(address)"), KNTQ), "the allocator's assets are not kHYPE and KNTQ"
assert same(call(ALLOCATOR, "destination0()(address)"), RESERVE), "the allocator's kHYPE does not go to this reserve"
assert same(call(RESERVE, "assetAt(uint256)(address)", "0"), KHYPE), "the reserve does not hold kHYPE"
live_oracle, live_swapper = call(SWAP_CONFIG, "oracle()(address)"), call(SWAP_CONFIG, "swapper()(address)")

# ---- the router, through the CREATE2 factory
salt = sh("cast", "keccak", "liquid-reserve.hype-only-router.v1")
args = sh("cast", "abi-encode", "f(address,address,address,address,address,address)", ORACLE, SWAPPER, SWAP_CONFIG, RESERVE, KHYPE, KNTQ)
init = sh("forge", "inspect", "src/adapters/HypeOnlyRouter.sol:HypeOnlyRouter", "bytecode") + args[2:]
router = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + salt[2:] + sh("cast", "keccak", init)[2:])[-40:])
create = salt + init[2:]
already = same(live_oracle, router) and same(live_swapper, router)
assert already or (same(live_oracle, ORACLE) and same(live_swapper, SWAPPER)), f"SwapConfig points somewhere unexpected: {live_oracle} {live_swapper}"

# ---- the timelock batch
calls = [
    (SWAP_CONFIG, sh("cast", "calldata", "setOracle(address)", router), "price source: the router (real oracle for everything except 'to KNTQ')"),
    (SWAP_CONFIG, sh("cast", "calldata", "setSwapper(address)", router), "swap contract: the router (real swapper for everything except 'to KNTQ')"),
]
targets = "[" + ",".join(c[0] for c in calls) + "]"
values = "[" + ",".join("0" for _ in calls) + "]"
payloads = "[" + ",".join(c[1] for c in calls) + "]"
zero = "0x" + "00" * 32
op_salt = sh("cast", "keccak", "liquid-reserve.hype-only.v1")
schedule = sh("cast", "calldata", "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", targets, values, payloads, zero, op_salt, str(DELAY))
execute = sh("cast", "calldata", "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, op_salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, zero, op_salt))

data = {
    "chainId": 99901,
    "rpc": RPC,
    "explorer": "https://elyscan.live",
    "owner": OWNER, "timelock": TIMELOCK, "multicall": MULTICALL3,
    "factory": FACTORY, "swapConfig": SWAP_CONFIG, "oracle": ORACLE, "swapper": SWAPPER, "reserve": RESERVE,
    "router": router, "create": create,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out_file = os.path.join(ROOT, "site", "tools", "hype-only-data.local.json" if LOCAL else "hype-only-data.json")
json.dump(data, open(out_file, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": op_salt, "routerSalt": salt, "routerConstructorArgs": args, "calls": [{"to": c[0], "what": c[2], "data": c[1]} for c in calls]}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "hype-only-data.json"), "w"), indent=2)
print(f"router        {router}  ({(len(init) - 2) // 2:,} bytes to create)")
print(f"operation id  {op_id}")
print(f"wrote         {os.path.relpath(out_file, ROOT)}")
