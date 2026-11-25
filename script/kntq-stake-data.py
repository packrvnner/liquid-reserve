#!/usr/bin/env python3
"""Builds the transactions that launch KNTQ staking (liquidKNTQ): four on HyperEVM and two on Elysium.

  HyperEVM   K1  SkntqLock           the reserve's side of the fee: sKNTQ that arrives is locked as principal
             K2  FeeSplitter         20% of the fee to the creator's wallet, 80% to K1
             K3  KntqVault           liquidKNTQ: holds sKNTQ, fee 20% of yield to K2
             K4  KntqAgentFactory    makes the per-batch agents for people who stake from Elysium
  Elysium    E1  KntqStakeQueue      where people on Elysium deposit KNTQ and ask to unstake
             E2  setKeeper           (owner wallet) lets the bot send batches smaller than the minimum

Every contract is created through the standard CREATE2 factory, so every address is known before anything is sent
and any wallet may send K1-K4 and E1: who sends them has no power over the contracts.

K3 is built from the `kntqvault` profile in foundry.toml (optimised for size) so that creating it fits in 2,000,000
gas, the limit some wallets apply to HyperEVM's fast blocks. Everything else comes from the default build. SkntqLock
(K1, already live) is compiled from src/staking/KntqStakingVault.sol, which must stay byte-identical for that reason.

  python3 script/kntq-stake-data.py            real network data
  python3 script/kntq-stake-data.py --local    the same, for local anvil forks (Elysium on 8597, HyperEVM on 8598)
  python3 script/kntq-stake-data.py --gas K1=123,K2=456,...   also record measured gas for each step
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PATH": os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"]}


def sh(*args, profile=None):
    env = {**ENV, "FOUNDRY_PROFILE": profile} if profile else ENV
    r = subprocess.run(list(args), capture_output=True, text=True, cwd=ROOT, env=env)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(args[:3])} failed: {r.stderr.strip()[:400]}")
    return r.stdout.strip()


LOCAL = "--local" in sys.argv
GAS = dict(kv.split("=") for kv in sys.argv[sys.argv.index("--gas") + 1].split(",")) if "--gas" in sys.argv else {}
ERPC = "http://127.0.0.1:8597" if LOCAL else "https://rpc.elysium.kinetiq.xyz"
HRPC = "http://127.0.0.1:8598" if LOCAL else "https://rpc.hyperliquid.xyz/evm"

NAME, SYMBOL = "Liquid Reserve Staked KNTQ", "liquidKNTQ"   # constants in KntqVault; here for the launch page
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37"   # 20% of the fee, on HyperEVM (the same wallet address)
BOT = "0x0461663d46DA68264966a0670335E3ecf0b96F3C"
FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"   # the standard CREATE2 factory, on both chains
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
# HyperEVM
SKNTQ = "0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F"
KNTQ_L1 = "0x000000000000780555bD0BCA3791f89f9542c2d6"
L1_ROUTER = "0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0"
H_RESERVE = "0x394f6103B88D4DEB3A9686991C0dE24F968094A6"  # the live Locked Reserve that holds sKNTQ
MIN_GAS, MIN_GAS_PRICE = 300_000, 500_000_000           # floors for the bridge ticket home (0.5 gwei)
CAP = 125_000 * 10**18                                   # sKNTQ, to start with (unaudited); the owner can raise it
# Elysium
KNTQ_L2 = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0"
L2_ROUTER = "0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17"
MIN_DEPOSITS, MIN_EXITS = 250 * 10**18, 250 * 10**18     # smallest batch anyone may send

VAULT_PROFILE = "kntqvault"
sh("forge", "build", "--silent")
sh("forge", "build", "--silent", "--skip", "test/**", "--skip", "script/**", profile=VAULT_PROFILE)
SALT = sh("cast", "keccak", "liquidreserve.xyz KNTQ staking v1")


def c2(contract, types, values, profile=None):
    """(address, transaction data) of a CREATE2 deployment through the standard factory."""
    code = sh("forge", "inspect", contract, "bytecode", profile=profile)
    args = sh("cast", "abi-encode", f"f({types})", *values) if types else "0x"
    init = code + args[2:]
    addr = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + SALT[2:] + sh("cast", "keccak", init)[2:])[-40:])
    return addr, SALT + init[2:], args


lock, d_lock, a_lock = c2("SkntqLock", "address,address", [SKNTQ, H_RESERVE])
splitter, d_splitter, a_splitter = c2("FeeSplitter", "address,uint16,address", [CREATOR, "2000", lock])
vault, d_vault, a_vault = c2("src/staking/KntqVault.sol:KntqVault", "address,address,address,uint256", [OWNER, SKNTQ, splitter, str(CAP)], profile=VAULT_PROFILE)
agents, d_agents, a_agents = c2("KntqAgentFactory", "address,address,uint256,uint256", [vault, L1_ROUTER, str(MIN_GAS), str(MIN_GAS_PRICE)])
agent_impl = sh("cast", "compute-address", agents, "--nonce", "1").split()[-1]
queue, d_queue, a_queue = c2(
    "KntqStakeQueue", "(address,address,address,address,address,address,address,uint256,uint256)",
    [f"({OWNER},{KNTQ_L2},{KNTQ_L1},{vault},{L2_ROUTER},{agents},{agent_impl},{MIN_DEPOSITS},{MIN_EXITS})"])
box_impl = sh("cast", "compute-address", queue, "--nonce", "1").split()[-1]
share_l2 = sh("cast", "call", L2_ROUTER, "calculateL2TokenAddress(address)(address)", vault, "--rpc-url", "https://rpc.elysium.kinetiq.xyz")
set_keeper = sh("cast", "calldata", "setKeeper(address)", BOT)


def step(id_, chain, title, to, data, creates=None, sender=None):
    s = {"id": id_, "chainId": chain, "title": title, "to": to, "data": data, "value": "0x0"}
    if creates:
        s["creates"] = creates
    if sender:
        s["from"] = sender
    if id_ in GAS:
        s["gasEstimate"] = int(GAS[id_])
    return s


data = {
    "chains": {"99901": {"name": "Elysium", "rpc": ERPC, "explorer": "https://elyscan.live"},
               "999": {"name": "HyperEVM", "rpc": HRPC, "explorer": "https://hyperevmscan.io"}},
    "owner": OWNER, "creator": CREATOR, "keeper": BOT, "factory": FACTORY, "multicall": MULTICALL3, "salt": SALT,
    "name": NAME, "symbol": SYMBOL, "cap": str(CAP), "minDeposits": str(MIN_DEPOSITS), "minExits": str(MIN_EXITS),
    "steps": [
        step("K1", 999, "HyperEVM: the reserve's lock for the fee", FACTORY, d_lock, lock),
        step("K2", 999, "HyperEVM: fee splitter (20% you, 80% reserve)", FACTORY, d_splitter, splitter),
        step("K3", 999, "HyperEVM: the staking vault (liquidKNTQ)", FACTORY, d_vault, vault),
        step("K4", 999, "HyperEVM: batch agents for stakers from Elysium", FACTORY, d_agents, agents),
        step("E1", 99901, "Elysium: the staking queue", FACTORY, d_queue, queue),
        step("E2", 99901, "Elysium: let the bot send small batches", queue, set_keeper, sender=OWNER),
    ],
    "hyperevm": {"skntq": SKNTQ, "kntq": KNTQ_L1, "router": L1_ROUTER, "reserve": H_RESERVE, "lock": lock, "splitter": splitter,
                 "vault": vault, "agentFactory": agents, "agentImpl": agent_impl, "minGas": MIN_GAS, "minGasPrice": str(MIN_GAS_PRICE)},
    "elysium": {"kntq": KNTQ_L2, "router": L2_ROUTER, "queue": queue, "boxImpl": box_impl, "share": share_l2},
}
out = os.path.join(ROOT, "site", "tools", "kntq-stake-data.local.json" if LOCAL else "kntq-stake-data.json")
json.dump(data, open(out, "w"), indent=2)
if not LOCAL:
    record = {**data, "build": {"KntqVault": f"foundry profile {VAULT_PROFILE} (optimizer runs 1)", "everything else": "default profile (optimizer runs 200)"},
              "constructorArgs": {"SkntqLock": a_lock, "FeeSplitter": a_splitter, "KntqVault": a_vault, "KntqAgentFactory": a_agents,
                                          "KntqStakeAgent": sh("cast", "abi-encode", "f(address,address,uint256,uint256)", vault, L1_ROUTER, str(MIN_GAS), str(MIN_GAS_PRICE)),
                                          "KntqStakeQueue": a_queue, "StakeBox": "0x"}}
    json.dump(record, open(os.path.join(ROOT, "deployments", "kntq-stake-launch-data.json"), "w"), indent=2)
for k, v in [("lock", lock), ("fee splitter", splitter), ("vault (liquidKNTQ)", vault), ("agent factory", agents), ("agent implementation", agent_impl),
             ("queue (Elysium)", queue), ("box implementation", box_impl), ("liquidKNTQ on Elysium", share_l2)]:
    print(f"{k:<24}{v}")
print(f"wrote {os.path.relpath(out, ROOT)}")
