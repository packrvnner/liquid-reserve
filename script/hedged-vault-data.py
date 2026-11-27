#!/usr/bin/env python3
"""Builds the seven transactions that launch the hedged vault on HyperEVM mainnet, and writes them to
site/tools/hedged-vault-data.json for site/tools/hedged-vault-launch.html. Sends nothing to mainnet.

The vault is five pieces, because the owner's wallet refuses HyperEVM transactions above 2,000,000 gas: four
libraries, each created on its own, and the vault, linked to them. Everything is created through the standard
CREATE2 factory, so every address is known beforehand and each piece can be linked to the ones before it here.

    python3 script/hedged-vault-data.py             build the data, with HyperEVM's own gas estimate for each step
    python3 script/hedged-vault-data.py rehearse    also start a local copy of HyperEVM (port 8598) with a stand-in
                                                    for HyperCore and write hedged-vault-data.local.json, for trying
                                                    the page with the test wallet:
        http://localhost:4174/tools/hedged-vault-launch.html?data=hedged-vault-data.local.json&devwallet=1
                                                    It keeps running (and keeps the stand-in's blocks coming) until
                                                    stopped.
    python3 script/hedged-vault-data.py exercise    with that copy running and the seven steps sent on it: put money
                                                    in, put it to work, hedge, take half out, claim, and check it all
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
os.environ["PATH"] = os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"]
RPC = os.environ.get("HYPEREVM_RPC", "https://rpc.hyperliquid.xyz/evm")
ELYSIUM = "https://rpc.elysium.kinetiq.xyz"
LOCAL = "http://127.0.0.1:8598"
OUT = "site/tools/hedged-vault-data.json"
OUT_LOCAL = "site/tools/hedged-vault-data.local.json"

FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37"
KEEPER = "0x0461663d46DA68264966a0670335E3ecf0b96F3C"  # the bot's wallet
POOL = "0x6c9A33E3b592C0d65B3Ba59355d5Be0d38259285"  # Project X HYPE/USDC, 0.05%
USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f"
WHYPE = "0x5555555555555555555555555555555555555555"
CORE_DEPOSIT = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24"  # Circle's CoreDepositWallet
CORE_WRITER = "0x3333333333333333333333333333333333333333"
L1_ROUTER = "0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0"  # the bridge to Elysium
VAULT_FEE_SPLIT = "0xB92c756347de468d7086a97EF112801b3371a408"  # on Elysium: 20% creator, 80% reserve
FEE_INBOX = "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c"  # on Elysium: the reserve's inbox
PERP, SZ_DECIMALS = 159, 2
WIDTH = 180  # tick spacings of 10: 1,800 ticks either side, as the live vaults
DEPOSIT_CAP = 1_000_000  # 1 USDC: nothing worth the name fits until the owner raises it
MIN_GAS, MIN_GAS_PRICE = 300_000, 500_000_000  # the bridge ticket's floors, as YieldUnstakeBridge's
GAS_LINE = 1_950_000


def sh(*args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(args[:3])} ... failed: {r.stderr.strip()[:400]}")
    return r.stdout.strip()


def rpc(url, method, params, soft=False):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "curl/8"})
    for attempt in range(6):
        try:
            j = json.load(urllib.request.urlopen(req, timeout=60))
            break
        except Exception:  # noqa: BLE001
            if attempt == 5:
                raise
            time.sleep(2 + attempt)
    if "error" in j:
        if soft:
            return None
        raise SystemExit(f"{method} failed: {json.dumps(j['error'])[:300]}")
    if "127.0.0.1" not in url:
        time.sleep(0.7)
    return j["result"]


keccak = lambda hexdata: sh("cast", "keccak", hexdata)
encode = lambda sig, *vals: sh("cast", "abi-encode", sig, *[str(v) for v in vals])
sig = lambda s: sh("cast", "sig", s)
SALT = keccak("0x" + "liquidreserve.xyz hedged vault v1".encode().hex())


def artifact(name, folder="src/hedged"):
    return json.load(open(f"out/{name}.sol/{name}.json"))


def linked(name, libs):
    """Creation code of `name` with the addresses of the libraries it calls put in."""
    art = artifact(name)
    code = art["bytecode"]["object"][2:]
    for refs in art["bytecode"].get("linkReferences", {}).values():
        for lib, spots in refs.items():
            if lib not in libs:
                raise SystemExit(f"{name} needs {lib}, which is not created before it")
            for s in spots:
                code = code[:s["start"] * 2] + libs[lib][2:].lower() + code[(s["start"] + s["length"]) * 2:]
    if "__$" in code:
        raise SystemExit(f"{name}: a library reference was left open")
    return "0x" + code


def create2(initcode):
    h = keccak("0xff" + FACTORY[2:].lower() + SALT[2:] + keccak(initcode)[2:])
    return sh("cast", "to-check-sum-address", "0x" + h[26:])


def build():
    sh("forge", "build", "-q", "--skip", "script")
    libs, steps, addr = {}, [], {}

    def step(sid, name, title, args=""):
        code = linked(name, libs) + args[2:]
        a = create2(code)
        addr[name] = a
        steps.append({"id": sid, "chainId": 999, "title": title, "to": FACTORY, "data": SALT + code[2:], "creates": a, "contract": name})
        return a

    for sid, lib, title in (("H1", "PoolLib", "The pool side (a library the vault runs)"), ("H2", "HedgeLib", "The Hyperliquid side (library)"),
                            ("H3", "FlowLib", "Deposits and withdrawals (library)"), ("H4", "KeepLib", "Upkeep (library)")):
        libs[lib] = step(sid, lib, title)
    fwd = step("H5", "FeeForwarder", "The fee forwarder: sends the vault's fees to your fee splitter on Elysium",
               encode("f(address,address,uint256,uint256)", L1_ROUTER, VAULT_FEE_SPLIT, MIN_GAS, MIN_GAS_PRICE))
    step("H6", "HedgedVault", "The vault itself",
         encode("f((address,address,address,address,address,uint32,uint8,int24,uint256))",
                f"({POOL},{CORE_DEPOSIT},{fwd},{OWNER},{KEEPER},{PERP},{SZ_DECIMALS},{WIDTH},{DEPOSIT_CAP})"))
    step("H7", "HedgedLens", "The reader the site and the bot use")
    return steps, addr


def data(url, steps, addr, core_deposit=CORE_DEPOSIT):
    return {
        "chains": {"999": {"name": "HyperEVM", "rpc": url, "explorer": "https://hyperevmscan.io"}},
        "factory": FACTORY, "salt": SALT, "owner": OWNER, "creator": CREATOR, "keeper": KEEPER,
        "pool": POOL, "usdc": USDC, "whype": WHYPE, "coreDeposit": core_deposit, "router": L1_ROUTER, "feeSplit": VAULT_FEE_SPLIT,
        "perp": PERP, "szDecimals": SZ_DECIMALS, "width": WIDTH, "depositCap": DEPOSIT_CAP,
        "vault": addr["HedgedVault"], "lens": addr["HedgedLens"], "forwarder": addr["FeeForwarder"],
        "libraries": {k: addr[k] for k in ("PoolLib", "HedgeLib", "FlowLib", "KeepLib")},
        # for the launch page and for the pilot page (site/tools/hedged-pilot.html)
        "sel": {k: sig(v) for k, v in {
            "owner": "owner()", "config": "config()", "settings": "settings()", "l2Recipient": "l2Recipient()", "gatewayRouter": "gatewayRouter()",
            "state": "state(address)", "owed": "owed(address)", "balanceOf": "balanceOf(address)", "allowance": "allowance(address,address)",
            "approve": "approve(address,uint256)", "deposit": "deposit(uint256,uint256,address)", "withdraw": "withdraw(uint256,uint256,address)",
            "claim": "claim(address)", "tend": "tend()", "harvest": "harvest()", "deploy": "deploy(int24,int24)", "rebalance": "rebalance(int24,int24)",
            "setDepositCap": "setDepositCap(uint256)", "setDepositsPaused": "setDepositsPaused(bool)", "setKeeper": "setKeeper(address)",
            "windDown": "windDown()", "nothingToDo": "NothingToDo()"}.items()},
        "steps": steps,
    }


def check_the_rule():
    """Every vault's fee goes 20% to the creator and 80% to the reserve: read the splitter on Elysium itself."""
    a = "0x" + rpc(ELYSIUM, "eth_call", [{"to": VAULT_FEE_SPLIT, "data": sig("recipientA()")}, "latest"])[-40:]
    b = "0x" + rpc(ELYSIUM, "eth_call", [{"to": VAULT_FEE_SPLIT, "data": sig("recipientB()")}, "latest"])[-40:]
    bps = int(rpc(ELYSIUM, "eth_call", [{"to": VAULT_FEE_SPLIT, "data": sig("bpsA()")}, "latest"]), 16)
    if a.lower() != CREATOR.lower() or b.lower() != FEE_INBOX.lower() or bps != 2000:
        raise SystemExit(f"the fee splitter on Elysium does not read 20% creator / 80% reserve: {a} {bps} {b}")
    print(f"fee splitter on Elysium: {bps / 100:.0f}% to {a}, the rest to the reserve's inbox {b}")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "build"
    if mode == "exercise":
        return exercise()
    steps, addr = build()
    check_the_rule()
    code = rpc(RPC, "eth_getCode", [FACTORY, "latest"])
    if len(code) < 100:
        raise SystemExit("the CREATE2 factory is not on HyperEVM")
    for s in steps:
        if len(rpc(RPC, "eth_getCode", [s["creates"], "latest"])) > 2:
            s["gasEstimate"] = 0
            print(f"{s['id']} {s['contract']:13s} {s['creates']}  already exists on HyperEVM")
            continue
        g = int(rpc(RPC, "eth_estimateGas", [{"from": CREATOR, "to": FACTORY, "data": s["data"]}]), 16)
        s["gasEstimate"] = g
        print(f"{s['id']} {s['contract']:13s} {s['creates']}  {g:>9,} gas  {'fits' if g <= GAS_LINE else 'TOO MUCH'}")
        if g > GAS_LINE:
            raise SystemExit(f"{s['contract']} needs {g:,} gas: over the {GAS_LINE:,} line of the owner's wallet")
    json.dump(data(RPC, steps, addr), open(OUT, "w"), indent=1)
    print("wrote", OUT)
    job = open("keeper/hosted/hedge.ts").read()
    for name in ("HedgedVault", "HedgedLens", "FeeForwarder"):
        if addr[name] not in job:
            print(f"NOTE: keeper/hosted/hedge.ts does not name {name} at {addr[name]}: the vault's code changed since the bot job was written. Copy the new addresses into HEDGE_CONFIG.")
    if mode == "rehearse":
        rehearse(steps, addr)


# ---------------------------------------------------------------------------------------------- the local copy

TEST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"  # anvil's first test account: the page's test wallet
OP, OP_KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # its second: runs the stand-in
GATEWAY = "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c"  # holds bridged USDC: the copy's source of test USDC


def cast_send(to, signature, *args, sender=None, value=None):
    cmd = ["cast", "send", to, signature, *[str(a) for a in args], "--rpc-url", LOCAL]
    cmd += ["--from", sender, "--unlocked"] if sender else ["--private-key", OP_KEY]
    if value:
        cmd += ["--value", str(value)]
    return sh(*cmd)


def call(to, signature, *args):
    return sh("cast", "call", to, signature, *[str(a) for a in args], "--rpc-url", LOCAL)


def rehearse(steps, addr):
    # The public RPC allows about 100 requests a minute and drops the connection of whoever asks faster: the copy
    # fetches what it needs at that pace, and tries again when a request is dropped anyway.
    anvil = subprocess.Popen(["anvil", "--fork-url", RPC, "--port", "8598", "--silent", "--compute-units-per-second", "40",
                              "--retries", "12", "--fork-retry-backoff", "3000", "--timeout", "120000"])
    try:
        for _ in range(120):
            if rpc(LOCAL, "eth_chainId", [], soft=True):
                break
            time.sleep(0.5)
        for a in (TEST, OP, OWNER, KEEPER, GATEWAY):
            if a in (TEST, OP):
                rpc(LOCAL, "anvil_setCode", [a, "0x"])
            rpc(LOCAL, "anvil_setBalance", [a, hex(100 * 10**18)])
        px = int(rpc(RPC, "eth_call", [{"to": "0x0000000000000000000000000000000000000807", "data": encode("f(uint32)", PERP)}, "latest"]), 16)

        def create(name, *args):
            out = sh("forge", "create", f"test/hedged/CoreSim.sol:{name}", "--private-key", OP_KEY, "--rpc-url", LOCAL, "--broadcast", "--constructor-args", *[str(a) for a in args])
            return re.search(r"Deployed to: (0x[0-9a-fA-F]{40})", out).group(1)

        sim = create("CoreSim", USDC, PERP, SZ_DECIMALS, px)
        wallet = create("CoreDepositWalletMock", sim, USDC)
        pre = rpc(LOCAL, "eth_getCode", [create("CorePrecompile", sim), "latest"])
        for a in ("0800", "0801", "0806", "0807", "080F"):
            rpc(LOCAL, "anvil_setCode", ["0x000000000000000000000000000000000000" + a, pre])
        rpc(LOCAL, "anvil_setCode", [CORE_WRITER, rpc(LOCAL, "eth_getCode", [create("CoreWriterMock", sim), "latest"])])
        # the stand-in takes the place of Circle's deposit wallet at its real address, so the real launch data works here
        rpc(LOCAL, "anvil_setCode", [CORE_DEPOSIT, rpc(LOCAL, "eth_getCode", [wallet, "latest"])])
        cast_send(sim, "wire(address,address)", CORE_WRITER, CORE_DEPOSIT)
        rpc(LOCAL, "anvil_impersonateAccount", [GATEWAY])
        cast_send(USDC, "transfer(address,uint256)", TEST, 10_000 * 10**6, sender=GATEWAY)
        cast_send(USDC, "transfer(address,uint256)", sim, 1_000_000 * 10**6, sender=GATEWAY)
        d = data(LOCAL, steps, addr)
        d["sim"] = sim
        json.dump(d, open(OUT_LOCAL, "w"), indent=1)
        print(f"local copy on {LOCAL}: stand-in for HyperCore at {sim} (oracle price {px}); test wallet {TEST} holds 10,000 USDC")
        print("open http://localhost:4174/tools/hedged-vault-launch.html?data=hedged-vault-data.local.json&devwallet=1", flush=True)
        while anvil.poll() is None:  # the stand-in's blocks: once a second it carries out what was sent
            subprocess.run(["cast", "send", sim, "step()", "--private-key", OP_KEY, "--rpc-url", LOCAL], capture_output=True)
            time.sleep(1)
    finally:
        anvil.terminate()


def exercise():
    d = json.load(open(OUT_LOCAL))
    vault, lens, fwd, sim = d["vault"], d["lens"], d["forwarder"], d["sim"]
    ok = lambda what, cond, more="": print(f"  {'ok  ' if cond else 'FAIL'} {what}{' ' + more if more else ''}") or (cond or sys.exit(1))
    num = lambda s: int(s.split()[0])
    for s in d["steps"]:
        ok(f"{s['contract']} exists at {s['creates']}", len(rpc(LOCAL, "eth_getCode", [s["creates"], "latest"])) > 2)
    ok("vault owner is the owner wallet", call(vault, "owner()(address)").lower() == OWNER.lower())
    cfg = call(vault, "config()((address,int24,uint24,uint32,uint8,uint16,uint16,address,address,address,address))")
    ok("vault config names the pool, USDC, Circle's wallet and the forwarder", all(x.lower() in cfg.lower() for x in (POOL, USDC, WHYPE, CORE_DEPOSIT, fwd)), cfg)
    st = call(vault, "settings()(address,uint16,uint16,int24,bool,bool,uint256)").split("\n")
    ok("keeper is the bot's wallet, band 5%, margin 40%, width 180, cap 1 USDC",
       st[0].lower() == KEEPER.lower() and num(st[1]) == 500 and num(st[2]) == 4000 and num(st[3]) == WIDTH and num(st[6]) == DEPOSIT_CAP, " / ".join(st))
    ok("forwarder sends to the fee splitter on Elysium, through the bridge", call(fwd, "l2Recipient()(address)").lower() == VAULT_FEE_SPLIT.lower() and call(fwd, "gatewayRouter()(address)").lower() == L1_ROUTER.lower())

    for a in (OWNER, KEEPER):
        rpc(LOCAL, "anvil_impersonateAccount", [a])
    state = lambda: [x.split()[0] for x in call(lens, "state(address)((uint256,uint256,uint256,uint160,int24,int24,int24,uint256,uint256,uint256,uint256,int256,uint256,int256,uint256,uint256,uint256,bool))", vault).strip("()").split(", ")]
    tick = lambda: num(call(POOL, "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)").split("\n")[1])
    usdc = lambda a: num(call(USDC, "balanceOf(address)(uint256)", a))
    wait = lambda n=8: time.sleep(n)  # the stand-in's blocks come once a second

    cast_send(USDC, "approve(address,uint256)", vault, 2**256 - 1, sender=TEST)
    try:
        cast_send(vault, "deposit(uint256,uint256,address)", 2_000 * 10**6, 0, TEST, sender=TEST)
        ok("a deposit above the 1 USDC cap is refused", False)
    except SystemExit:
        ok("a deposit above the 1 USDC cap is refused", True)
    cast_send(vault, "setDepositCap(uint256)", 5_000 * 10**6, sender=OWNER)
    cast_send(vault, "deposit(uint256,uint256,address)", 2_000 * 10**6, 0, TEST, sender=TEST)
    shares = num(call(vault, "balanceOf(address)(uint256)", TEST))
    ok("2,000 USDC in after the owner raised the cap", shares > 1_990 * 10**6, f"{shares / 1e6:.2f} shares")
    cast_send(vault, "deploy(int24,int24)", tick(), 0, sender=KEEPER)
    wait()
    try:
        cast_send(vault, "tend()", sender=TEST)
    except SystemExit:
        pass
    wait()
    s = state()
    value, short, target, margin = int(s[0]), -int(s[13]), int(s[14]), int(s[15])
    ok("the money is at work and hedged: short equals the HYPE held", target > 0 and abs(short - target) <= 1, f"short {short / 100} HYPE, target {target / 100}")
    ok("margin about 40% of the short", 3_700 <= margin <= 4_300, f"{margin / 100:.1f}%")
    ok("value within half a percent of what went in", abs(value - 2_000 * 10**6) < 10 * 10**6, f"{value / 1e6:.2f} USDC")

    before = usdc(TEST)
    cast_send(vault, "withdraw(uint256,uint256,address)", shares // 2, 0, TEST, sender=TEST)
    paid, owed = usdc(TEST) - before, num(call(vault, "owed(address)(uint256)", TEST))
    ok("half taken out: paid at once plus owed is about half the value", abs(paid + owed - value // 2) < 6 * 10**6, f"paid {paid / 1e6:.2f}, owed {owed / 1e6:.2f}")
    for _ in range(6):
        wait(7)
        try:
            cast_send(vault, "tend()", sender=TEST)
        except SystemExit:
            pass
        if owed and usdc(vault) >= owed:
            break
    if owed:
        cast_send(vault, "claim(address)", TEST, sender=TEST)
    ok("what was owed arrived from the stand-in and was claimed", num(call(vault, "owed(address)(uint256)", TEST)) == 0)
    wait()
    s = state()
    ok("the short shrank with the withdrawal", abs(-int(s[13]) - int(s[14])) <= max(2, int(s[14]) // 8), f"short {-int(s[13]) / 100} HYPE, target {int(s[14]) / 100}")
    rejected = num(call(sim, "transfersRejected()(uint256)"))
    ok("the stand-in refused no transfer (the float covers HyperCore's charge)", rejected == 0)
    cast_send(vault, "harvest()", sender=TEST)
    ok("harvest runs", True)
    try:
        cast_send(vault, "rebalance(int24,int24)", tick(), 0, sender=TEST)
        ok("a stranger cannot move the range", False)
    except SystemExit:
        ok("a stranger cannot move the range", True)
    print("exercise passed")


if __name__ == "__main__":
    main()
