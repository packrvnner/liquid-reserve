#!/usr/bin/env python3
"""Builds the one transaction that opens the HYPE staking vault (src/staking/HypeStakingVault.sol) on Elysium.

The vault is created through the standard CREATE2 factory, so its address is known before anything is sent, and
any wallet may send the transaction: who sends it has no power over the vault. Its settings are fixed here:

  token            Liquid Reserve Staked HYPE (liquidHYPE)   name chosen by the owner, 2026-11-20
  asset            kHYPE, Kinetiq's staked HYPE as bridged to Elysium
  pool             the kHYPE / WHYPE Uniswap v4 pool the reserve already swaps in
  rate provider    the reserve's own kHYPE rate (30-minute average of that pool)
  fee              20% of the yield, to VaultFeeSplit: 20% of it to the creator's wallet, 80% to the reserve
  owner            the owner wallet: may pause new deposits and change the deposit cap, nothing else
  deposit cap      400 kHYPE to start with (the contract is unaudited); the owner can raise it

  python3 script/stake-data.py            real network data
  python3 script/stake-data.py --local    the same, for a local anvil fork on port 8597
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
NAME, SYMBOL = "Liquid Reserve Staked HYPE", "liquidHYPE"
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"      # the standard CREATE2 factory
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
POOL_MANAGER = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1"
WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
KHYPE = "0x248888D396A546A69A188f3Deb476964e581E9d0"
KHYPE_POOL_HOOK = "0x8129bab872318a64B0e6212C6C491feED06C3de3"
KHYPE_RATE = "0xcd08e24b11f4bD4e2F609964692A7E78BC09e708"   # TwapRateProvider created with the reserve
FEE_TO = "0xB92c756347de468d7086a97EF112801b3371a408"       # VaultFeeSplit: 20% creator 0x9324...DC37, 80% vault fee inbox
QUOTER = "0x379f556c5a748bd7cc9baf0f7a344094ac1814f5"       # Uniswap's V4Quoter on Elysium (for the site's previews)
CAP = 400 * 10**18

sh("forge", "build", "--silent")
code = sh("forge", "inspect", "HypeStakingVault", "bytecode")
POOL = f"({KHYPE},{WHYPE},8388608,1,{KHYPE_POOL_HOOK})"
TYPES = "f((string,string,address,address,address,address,(address,address,uint24,int24,address),address,address,uint256))"
args = sh("cast", "abi-encode", TYPES, f"({NAME},{SYMBOL},{OWNER},{POOL_MANAGER},{WHYPE},{KHYPE},{POOL},{KHYPE_RATE},{FEE_TO},{CAP})")
init = code + args[2:]
salt = sh("cast", "keccak", "liquidreserve.xyz HYPE staking vault v1")
# CREATE2: the last 20 bytes of keccak256(0xff ++ factory ++ salt ++ keccak256(init code))
vault = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + salt[2:] + sh("cast", "keccak", init)[2:])[-40:])

data = {
    "chainId": 99901,
    "rpc": "http://127.0.0.1:8597" if LOCAL else "https://rpc.elysium.kinetiq.xyz",
    "explorer": "https://elyscan.live",
    "owner": OWNER, "multicall": MULTICALL3, "factory": FACTORY,
    "vault": vault, "name": NAME, "symbol": SYMBOL,
    "khype": KHYPE, "whype": WHYPE, "feeTo": FEE_TO, "rateProvider": KHYPE_RATE, "cap": str(CAP),
    "to": FACTORY, "data": salt + init[2:],
}
out = os.path.join(ROOT, "site", "tools", "stake-data.local.json" if LOCAL else "stake-data.json")
json.dump(data, open(out, "w"), indent=2)
if not LOCAL:
    record = {**data, "salt": salt, "contract": "src/staking/HypeStakingVault.sol:HypeStakingVault",
              "constructorArgs": {"name": NAME, "symbol": SYMBOL, "owner": OWNER, "poolManager": POOL_MANAGER, "whype": WHYPE, "khype": KHYPE,
                                  "pool": {"currency0": KHYPE, "currency1": WHYPE, "fee": 8388608, "tickSpacing": 1, "hooks": KHYPE_POOL_HOOK},
                                  "rateProvider": KHYPE_RATE, "feeRecipient": FEE_TO, "depositCap": str(CAP)},
              "constructorArgsEncoded": args, "quoter": QUOTER}
    json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "stake-launch-data.json"), "w"), indent=2)
print(f"vault   {vault}")
print(f"token   {NAME} ({SYMBOL})")
print(f"wrote   {os.path.relpath(out, ROOT)} ({len(data['data']) // 2} bytes of transaction data)")
