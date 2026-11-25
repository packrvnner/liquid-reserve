#!/usr/bin/env python3
"""Builds the data for site/tools/creator-share.html: the creator's 20% share of reserve yield and of
the fee cut of vaults launched from now on.

Three small contracts, all from source that is already live and verified (FeeSplitter, FeeInbox):

  VaultFeeSplit  FeeSplitter(creator 20%, the existing vault fee inbox 80%)
                 New vaults use this as their fee recipient: 20% of their fee cut to the creator, 80% to the reserve.
  YieldRest      FeeInbox(setter = the 48-hour timelock)
                 Holds the other 80% of reserve yield until the rest of the yield plan is built.
  YieldSplit     FeeSplitter(creator 20%, YieldRest 80%)
                 The reserve's yield contract is pointed here, once, through the timelock.

They are created through the standard CREATE2 factory in one Multicall3 transaction, so their addresses are
known before anything is sent. Then two timelock transactions point the yield contract at YieldSplit:
schedule now, execute 48 hours later.

  python3 script/creator-share-data.py            real network data
  python3 script/creator-share-data.py --local    the same, for a local anvil fork on port 8597
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
CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37"       # receives the creator share; fixed for good
VAULT_FEE_INBOX = "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c"  # everything sent here ends up locked in the reserve
TIMELOCK = "0xa9e0FEAf8032c669803F68af7e93370D86e03c7F"
YIELD_WAIT = "0xb99d0AFf4f65AC80c268a3050f72a107329909eE"      # where the reserve's yield collects today
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"         # the standard CREATE2 factory
BPS = 2000
DELAY = 172800

sh("forge", "build", "--silent")
splitter_code = sh("forge", "inspect", "FeeSplitter", "bytecode")
inbox_code = sh("forge", "inspect", "FeeInbox", "bytecode")
salt = lambda name: sh("cast", "keccak", name)


def create2(name, code, types, *args):
    init = code + sh("cast", "abi-encode", f"f({types})", *args)[2:]
    s = salt(f"liquid-reserve.creator-share.v1.{name}")
    # CREATE2: the last 20 bytes of keccak256(0xff ++ factory ++ salt ++ keccak256(init code))
    addr = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + s[2:] + sh("cast", "keccak", init)[2:])[-40:])
    return {"name": name, "address": addr, "salt": s, "initCode": init, "factoryCall": s + init[2:]}


yield_rest = create2("YieldRest", inbox_code, "address", TIMELOCK)
yield_split = create2("YieldSplit", splitter_code, "address,uint16,address", CREATOR, str(BPS), yield_rest["address"])
vault_split = create2("VaultFeeSplit", splitter_code, "address,uint16,address", CREATOR, str(BPS), VAULT_FEE_INBOX)
contracts = [yield_rest, yield_split, vault_split]

# one transaction: Multicall3.aggregate3([(factory, false, salt ++ initcode) x 3])
calls = "[" + ",".join(f"({FACTORY},false,{c['factoryCall']})" for c in contracts) + "]"
deploy = sh("cast", "calldata", "aggregate3((address,bool,bytes)[])", calls)

# the timelock operation: yieldWait.setTarget(YieldSplit)
set_target = sh("cast", "calldata", "setTarget(address)", yield_split["address"])
zero = "0x" + "00" * 32
op_salt = salt("liquid-reserve.creator-share.v1.point-yield")
schedule = sh("cast", "calldata", "schedule(address,uint256,bytes,bytes32,bytes32,uint256)", YIELD_WAIT, "0", set_target, zero, op_salt, str(DELAY))
execute = sh("cast", "calldata", "execute(address,uint256,bytes,bytes32,bytes32)", YIELD_WAIT, "0", set_target, zero, op_salt)
op_id = sh("cast", "keccak", sh("cast", "abi-encode", "f(address,uint256,bytes,bytes32,bytes32)", YIELD_WAIT, "0", set_target, zero, op_salt))

data = {
    "chainId": 99901,
    "rpc": "http://127.0.0.1:8597" if LOCAL else "https://rpc.elysium.kinetiq.xyz",
    "explorer": "https://elyscan.live",
    "owner": OWNER, "creator": CREATOR, "bps": BPS,
    "timelock": TIMELOCK, "yieldWait": YIELD_WAIT, "vaultFeeInbox": VAULT_FEE_INBOX,
    "multicall": MULTICALL3, "factory": FACTORY,
    "yieldRest": yield_rest["address"], "yieldSplit": yield_split["address"], "vaultFeeSplit": vault_split["address"],
    "deploy": deploy,
    "id": op_id, "delay": DELAY, "schedule": schedule, "execute": execute,
}
out = os.path.join(ROOT, "site", "tools", "creator-share-data.local.json" if LOCAL else "creator-share-data.json")
json.dump(data, open(out, "w"), indent=2)
if not LOCAL:
    record = {**data, "contracts": [{k: c[k] for k in ("name", "address", "salt")} for c in contracts],
              "constructorArgs": {"YieldRest": [TIMELOCK], "YieldSplit": [CREATOR, BPS, yield_rest["address"]], "VaultFeeSplit": [CREATOR, BPS, VAULT_FEE_INBOX]}}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "creator-share-launch-data.json"), "w"), indent=2)
print(f"YieldRest      {yield_rest['address']}")
print(f"YieldSplit     {yield_split['address']}")
print(f"VaultFeeSplit  {vault_split['address']}")
print(f"timelock operation id {op_id}")
print(f"wrote {out}")
