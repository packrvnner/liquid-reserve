#!/usr/bin/env python3
"""Builds what is needed to open the wNVDAx-USDC vault on Elysium: two transactions.

wNVDAx is "Wrapped NVIDIA xStock" (HyperEVM 0xa8dd...50D5; Hyperliquid's spot token NVDAX is linked to it). Unlike
wANTx it is already on Elysium (0x1126...dF44, the canonical bridge's token for it) and already trades there. Its
existing USDC pool runs through a hook that its owner can change, and the vault contract takes hookless pools only,
so the vault gets a new hookless 0.3% pool of wNVDAx and USDC in which it is the only liquidity to begin with, as
the wANTx-USDC vault did. The vault is the same contract (LiquidityVaultV2, frozen source). The helper that sets an
empty pool's price (EmptyPoolPrice, 0x26D7...9548) is already live, so it is not deployed again.

  E1  Elysium   open the pool at the market price, through the live helper (any wallet; price read from
                Hyperliquid's NVDAX/USDC book)
  E2  Elysium   the vault (any wallet): fee recipient VaultFeeSplit, owner and keeper as the other vaults

E2 goes through the standard CREATE2 factory, so its address is known beforehand and its data is fixed and written
here. E1 depends on the moment it is sent (the price), so the launch page builds it from the pieces written here.
This script builds it the same way for the rehearsal.

The pool's first token is wNVDAx (its address sorts before USDC's), the other way round from the wANTx pool: the
pool quotes USDC per wNVDAx, and the vault's cap and share decimals follow USDC.

  python3 script/nvda-vault-data.py             writes site/tools/nvda-vault-data.json and the deployment record
  python3 script/nvda-vault-data.py --local     the same for a local fork of Elysium (port 8611, or --port N)
  python3 script/nvda-vault-data.py --verify    replays both on a FRESH fork on that port, reads everything back,
                                                records the gas, and makes a first deposit (--no-deposit: leaves
                                                the vault empty, for trying a first deposit through the site)
  python3 script/nvda-vault-data.py --readback  AFTER the real launch: reads the real network (or, with --port N,
                                                a fork) and checks every setting against the launch data. Reads
                                                only; writes nothing.
"""
import json
import math
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PATH": os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], "ETH_RPC_TIMEOUT": "180"}
LOCAL, VERIFY = "--local" in sys.argv, "--verify" in sys.argv
PORT = sys.argv[sys.argv.index("--port") + 1] if "--port" in sys.argv else "8611"
E_REAL, E_FORK = "https://rpc.elysium.kinetiq.xyz", f"http://127.0.0.1:{PORT}"


def sh(*args, ok=True):
    r = subprocess.run(list(args), capture_output=True, text=True, cwd=ROOT, env=ENV)
    if r.returncode != 0:
        if ok:
            raise SystemExit(f"{' '.join(args[:4])} failed: {r.stderr.strip()[:500]}")
        return "ERR " + r.stderr.strip()[:300]
    return r.stdout.strip()


Z = "0x0000000000000000000000000000000000000000"
FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"   # the standard CREATE2 factory
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
OWNER = "0x822aA88543b9da39c4c3D856857379E17526C1E8"
BOT = "0x0461663d46DA68264966a0670335E3ecf0b96F3C"
CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37"
# Elysium
PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1"
STATE_VIEW = "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE"
WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"
USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65"
WNVDAX = "0x11265018bF2d5a99fb71EFaE73aD670203C1dF44"     # Wrapped NVIDIA xStock on Elysium (the bridge's token)
FEE_TO = "0xB92c756347de468d7086a97EF112801b3371a408"    # VaultFeeSplit: 20% creator wallet, 80% vault fee inbox
FEE_INBOX = "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c"
SETTER = "0x26D7857d548EBADE54212BB5482f5770ae9d2548"    # EmptyPoolPrice, live since the wANTx vault's launch
L2_ROUTER = "0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17"
L2_GATEWAY = "0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f"
# HyperEVM
WNVDAX_L1 = "0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5"
L1_GATEWAY = "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c"
HL_COIN, HL_INDEX, HL_SZ_DECIMALS = "@702", 702, 2       # NVDAX/USDC on Hyperliquid's spot market
# the vault
FEE, SPACING = 3000, 60                                  # 0.30%
MAIN, ALT = 30, 30                                       # half-widths in tick spacings, as the other vaults
CAP = 25_000 * 10**6                                     # USDC of total value (the cap is counted in the pool's second token), to start with
NAME, SYMBOL = "Liquid Reserve Vault wNVDAx-USDC v2", "lrvwNVDAx-USDC-2"

sh("forge", "build", "--silent")
assert int(WNVDAX, 16) < int(USDC, 16), "wNVDAx must sort before USDC"
assert sh("cast", "call", L2_ROUTER, "calculateL2TokenAddress(address)(address)", WNVDAX_L1, "--rpc-url", E_REAL).lower() == WNVDAX.lower(), "wNVDAx is not the bridge's token for its HyperEVM twin"
KEY = f"({WNVDAX},{USDC},{FEE},{SPACING},{Z})"
POOL_ID = sh("cast", "keccak", sh("cast", "abi-encode", "f(address,address,uint24,int24,address)", WNVDAX, USDC, str(FEE), str(SPACING), Z))


def c2(contract, salt_text, types, values):
    """(address, transaction data, constructor args) of a CREATE2 deployment through the standard factory."""
    salt = sh("cast", "keccak", salt_text)
    args = sh("cast", "abi-encode", f"f({types})", *values)
    init = sh("forge", "inspect", contract, "bytecode") + args[2:]
    addr = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + salt[2:] + sh("cast", "keccak", init)[2:])[-40:])
    return addr, salt + init[2:], args


vault, d_vault, a_vault = c2(
    "LiquidityVaultV2", "liquidreserve.xyz wNVDAx-USDC vault v2",
    "((address,address,uint24,int24,address),address,address,address,address,address,string,string,int24,int24,uint256)",
    [f"({KEY},{PM},{FEE_TO},{WHYPE},{OWNER},{BOT},{NAME},{SYMBOL},{MAIN},{ALT},{CAP})"])

SEL = {k: sh("cast", "sig", v) for k, v in {
    "set": "set((address,address,uint24,int24,address),uint160)",
    "getSlot0": "getSlot0(bytes32)",
    "getLiquidity": "getLiquidity(bytes32)",
}.items()}


def sqrt_price(dollars):
    """sqrtPriceX96 of the pool (raw USDC per raw wNVDAx) for a wNVDAx worth `dollars`."""
    return math.isqrt((int(round(dollars * 10**8)) << 192) // (10**12 * 10**8))


def dollars_of(sqrt_p):
    return (sqrt_p / 2**96) ** 2 * 10**12


def e1(dollars):
    return SETTER, sh("cast", "calldata", "set((address,address,uint24,int24,address),uint160)", KEY, str(sqrt_price(dollars)))


def hl_book():
    req = urllib.request.Request("https://api.hyperliquid.xyz/info", data=json.dumps({"type": "l2Book", "coin": HL_COIN}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        bids, asks = json.load(r)["levels"]
    return float(bids[0]["px"]), float(asks[0]["px"])


def write(local, gas=None):
    old_path = os.path.join(ROOT, "site", "tools", "nvda-vault-data.json")
    old = {s["id"]: s for s in json.load(open(old_path)).get("steps", [])} if os.path.exists(old_path) else {}
    gas = gas or {i: s.get("gasEstimate") for i, s in old.items() if s.get("gasEstimate")}

    def step(i, chain, title, **kw):
        s = {"id": i, "chainId": chain, "title": title, **kw}
        if gas.get(i):
            s["gasEstimate"] = int(gas[i])
        return s

    data = {
        "chains": {"99901": {"name": "Elysium", "rpc": E_FORK if local else E_REAL, "explorer": "https://elyscan.live"}},
        "owner": OWNER, "keeper": BOT, "creator": CREATOR, "factory": FACTORY, "multicall": MULTICALL3,
        "feeTo": FEE_TO, "feeInbox": FEE_INBOX, "name": NAME, "symbol": SYMBOL, "cap": str(CAP), "mainWidth": MAIN, "altWidth": ALT,
        # the outside price, read two ways: Hyperliquid's API, and the best-bid-and-ask precompile on HyperEVM
        "hyperliquid": {"api": "https://api.hyperliquid.xyz/info", "coin": HL_COIN, "index": HL_INDEX, "szDecimals": HL_SZ_DECIMALS,
                        "rpc": "https://rpc.hyperliquid.xyz/evm", "bbo": "0x000000000000000000000000000000000000080e"},
        "hyperevm": {"wnvdax": WNVDAX_L1, "explorer": "https://hyperevmscan.io"},
        "elysium": {"wnvdax": WNVDAX, "usdc": USDC, "poolManager": PM, "stateView": STATE_VIEW,
                    "priceSetter": SETTER, "vault": vault, "pool": POOL_ID,
                    "key": {"currency0": WNVDAX, "currency1": USDC, "fee": FEE, "tickSpacing": SPACING, "hooks": Z}},
        "sel": SEL,
        "steps": [
            step("E1", 99901, "Open the wNVDAx-USDC pool at the market price", build="price"),
            step("E2", 99901, "Create the vault", to=FACTORY, data=d_vault, value="0x0", creates=vault),
        ],
    }
    out = os.path.join(ROOT, "site", "tools", "nvda-vault-data.local.json" if local else "nvda-vault-data.json")
    json.dump(data, open(out, "w"), indent=2)
    if not local:
        record = {**data, "constructorArgs": {"LiquidityVaultV2": a_vault}}
        json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "nvda-vault-launch-data.json"), "w"), indent=2)
    return out


for k, v in [("wNVDAx on Elysium", WNVDAX), ("pool id", POOL_ID), ("price helper", SETTER), ("vault", vault)]:
    print(f"{k:<19}{v}")

if "--readback" in sys.argv:
    rpc = E_FORK if "--port" in sys.argv else E_REAL
    bad = 0

    def check(label, got, want=True):
        global bad
        okay = str(got).lower() == str(want).lower()
        bad += 0 if okay else 1
        print(("  ok   " if okay else "  FAIL ") + label + ("" if okay else f": got {got}, want {want}"))

    call = lambda to, sig, *a: sh("cast", "call", to, sig, *a, "--rpc-url", rpc)
    print("reading", rpc)
    slot0 = call(STATE_VIEW, "getSlot0(bytes32)(uint160,int24,uint24,uint24)", POOL_ID).split("\n")
    sqrt_p = int(slot0[0].split()[0])
    if sqrt_p == 0 or sh("cast", "code", vault, "--rpc-url", rpc) == "0x":
        print("NOT LAUNCHED: " + ("the pool is not open" if sqrt_p == 0 else "the pool is open but the vault is not created"))
        sys.exit(2)
    bid, ask = hl_book()
    print(f"  pool at ${dollars_of(sqrt_p):.2f} a wNVDAx; Hyperliquid bid ${bid:.2f}, ask ${ask:.2f}")
    check("the pool's fee is 0.30%", slot0[3].split()[0], FEE)
    for label, got, want in [
        ("fee recipient = VaultFeeSplit", call(vault, "feeRecipient()(address)"), FEE_TO),
        ("VaultFeeSplit pays 20% to the creator wallet", call(FEE_TO, "recipientA()(address)") + " " + call(FEE_TO, "bpsA()(uint16)"), CREATOR + " 2000"),
        ("and the rest to the vault fee inbox", call(FEE_TO, "recipientB()(address)"), FEE_INBOX),
        ("owner = owner wallet", call(vault, "owner()(address)"), OWNER),
        ("no handover of ownership pending", call(vault, "pendingOwner()(address)"), Z),
        ("keeper = the bot", call(vault, "keeper()(address)"), BOT),
        ("token0 = wNVDAx", call(vault, "token0()(address)"), WNVDAX),
        ("token1 = USDC", call(vault, "token1()(address)"), USDC),
        ("pool id", call(vault, "poolId()(bytes32)"), POOL_ID),
        ("not a HYPE pool", call(vault, "nativePool()(bool)"), "false"),
        ("performance fee 20%", call(vault, "PERFORMANCE_FEE_BPS()(uint256)").split()[0], 2000),
        ("range widths 30 / 30", call(vault, "mainWidth()(int24)") + "/" + call(vault, "altWidth()(int24)"), f"{MAIN}/{ALT}"),
        ("cap 25,000 USDC of value", call(vault, "depositCap()(uint256)").split()[0], CAP),
        ("deposits open", call(vault, "depositsPaused()(bool)"), "false"),
        ("name", call(vault, "name()(string)"), f'"{NAME}"'),
        ("symbol", call(vault, "symbol()(string)"), f'"{SYMBOL}"'),
    ]:
        check(label, got, want)
    # the code itself, byte for byte, with the values fixed at creation blanked out on both sides
    art = json.load(open(os.path.join(ROOT, "out", "LiquidityVaultV2.sol", "LiquidityVaultV2.json")))["deployedBytecode"]
    live_code, local_code = bytearray.fromhex(sh("cast", "code", vault, "--rpc-url", rpc)[2:]), bytearray.fromhex(art["object"][2:])
    fixed = 0
    for places in art["immutableReferences"].values():
        for r in places:
            fixed += r["length"]
            for code in (live_code, local_code):
                if len(code) >= r["start"] + r["length"]:
                    code[r["start"]:r["start"] + r["length"]] = bytes(r["length"])
    check(f"the code on the network is the local build of the frozen source, byte for byte ({len(local_code):,} bytes; {fixed} of them are values fixed at creation and are left out)", live_code == local_code)
    print(f"  shares in issue: {int(call(vault, 'totalSupply()(uint256)').split()[0]) / 1e6:,.6f}; value ${int(call(vault, 'totalValue()(uint256)').split()[0]) / 1e6:,.2f}")
    print("ALL GOOD" if bad == 0 else f"{bad} FAILED")
    sys.exit(1 if bad else 0)

print("wrote", os.path.relpath(write(False), ROOT))
if LOCAL or VERIFY:
    print("wrote", os.path.relpath(write(True), ROOT))

if VERIFY:
    bad = 0

    def check(label, got, want=True):
        global bad
        okay = str(got).lower() == str(want).lower()
        bad += 0 if okay else 1
        print(("  ok   " if okay else "  FAIL ") + label + ("" if okay else f": got {got}, want {want}"))

    call = lambda to, sig, *a: sh("cast", "call", to, sig, *a, "--rpc-url", E_FORK)
    code = lambda a: sh("cast", "code", a, "--rpc-url", E_FORK)
    WHO = "0x00000000000000000000000000000000000A11ce"   # any wallet: holds no wNVDAx
    sh("cast", "rpc", "anvil_autoImpersonateAccount", "true", "--rpc-url", E_FORK)
    sh("cast", "rpc", "anvil_setBalance", WHO, hex(10**20), "--rpc-url", E_FORK)
    sh("cast", "rpc", "anvil_mine", "0x1", "--rpc-url", E_FORK)
    check("the fork is Elysium", sh("cast", "chain-id", "--rpc-url", E_FORK), 99901)
    check("wNVDAx is on Elysium already", code(WNVDAX) != "0x")
    check("its name", call(WNVDAX, "name()(string)"), '"Wrapped NVIDIA xStock"')
    check("its symbol", call(WNVDAX, "symbol()(string)"), '"wNVDAx"')
    check("its decimals", call(WNVDAX, "decimals()(uint8)"), 18)
    check("it points back at wNVDAx on HyperEVM", call(WNVDAX, "l1Address()(address)"), WNVDAX_L1)
    check("the price helper is live and bound to the pool manager", call(SETTER, "poolManager()(address)"), PM)
    check("fresh fork: the pool does not exist yet", call(STATE_VIEW, "getSlot0(bytes32)(uint160,int24,uint24,uint24)", POOL_ID).split("\n")[0].split()[0], 0)
    check("fresh fork: the vault is not there yet", code(vault), "0x")
    gas = {}

    def send(to, data, value=0, sender=WHO, limit=None):
        est = int(sh("cast", "estimate", "--from", sender, to, data, "--value", str(value), "--rpc-url", E_FORK))
        r = json.loads(sh("cast", "send", "--unlocked", "--from", sender, to, data, "--value", str(value), "--gas-limit", str(limit or est * 12 // 10), "--rpc-url", E_FORK, "--json"))
        return est, r

    # the vault cannot be created before its pool exists
    check("before the pool exists the vault cannot be created", sh("cast", "estimate", "--from", WHO, FACTORY, d_vault, "--rpc-url", E_FORK, ok=False).startswith("ERR"))
    # E1
    bid, ask = hl_book()
    px = (bid + ask) / 2
    to, data = e1(px)
    gas["E1"], r = send(to, data)
    slot0 = call(STATE_VIEW, "getSlot0(bytes32)(uint160,int24,uint24,uint24)", POOL_ID).split("\n")
    got = dollars_of(int(slot0[0].split()[0]))
    check(f"E1 the pool opens at ${got:.2f} (Hyperliquid bid ${bid:.2f}, ask ${ask:.2f}; estimate {gas['E1']:,})", abs(got / px - 1) < 0.0001)
    check("the pool's fee is 0.30%", slot0[3].split()[0], FEE)
    check("nothing is in the pool", call(STATE_VIEW, "getLiquidity(bytes32)(uint128)", POOL_ID).split()[0], 0)
    # E2
    gas["E2"], r = send(FACTORY, d_vault)
    check(f"E2 the vault is created at {vault} (estimate {gas['E2']:,})", code(vault) != "0x")
    check("fee recipient = VaultFeeSplit", call(vault, "feeRecipient()(address)"), FEE_TO)
    check("VaultFeeSplit pays 20% to the creator wallet", call(FEE_TO, "recipientA()(address)") + " " + call(FEE_TO, "bpsA()(uint16)"), CREATOR + " 2000")
    check("and the rest to the vault fee inbox", call(FEE_TO, "recipientB()(address)"), FEE_INBOX)
    check("owner = owner wallet", call(vault, "owner()(address)"), OWNER)
    check("no handover of ownership pending", call(vault, "pendingOwner()(address)"), Z)
    check("keeper = the bot", call(vault, "keeper()(address)"), BOT)
    check("token0 = wNVDAx", call(vault, "token0()(address)"), WNVDAX)
    check("token1 = USDC", call(vault, "token1()(address)"), USDC)
    check("pool id", call(vault, "poolId()(bytes32)"), POOL_ID)
    check("not a HYPE pool", call(vault, "nativePool()(bool)"), "false")
    check("performance fee 20%", call(vault, "PERFORMANCE_FEE_BPS()(uint256)").split()[0], 2000)
    check("range widths 30 / 30", call(vault, "mainWidth()(int24)") + "/" + call(vault, "altWidth()(int24)"), f"{MAIN}/{ALT}")
    check("cap 25,000 USDC of value", call(vault, "depositCap()(uint256)").split()[0], CAP)
    check("deposits open", call(vault, "depositsPaused()(bool)"), "false")
    check("shares have USDC's 6 decimals", call(vault, "decimals()(uint8)"), 6)
    check("name", call(vault, "name()(string)"), f'"{NAME}"')
    check("symbol", call(vault, "symbol()(string)"), f'"{SYMBOL}"')
    check("no shares in issue", call(vault, "totalSupply()(uint256)").split()[0], 0)

    if "--no-deposit" in sys.argv:   # leave the vault empty (for trying a first deposit through the site)
        print("gas:", gas)
        write(False, gas)
        write(True, gas)
        print("ALL GOOD (no deposit made)" if bad == 0 else f"{bad} FAILED")
        sys.exit(1 if bad else 0)
    # a first deposit of both tokens, by someone who bridged wNVDAx in (the bridge's gateway mints it on arrival)
    USER = "0x00000000000000000000000000000000000B0b01"
    alias = sh("cast", "to-check-sum-address", hex((int(L1_GATEWAY, 16) + 0x1111000000000000000000000000000000001111) % 2**160))
    for a in (USER, alias, PM):
        sh("cast", "rpc", "anvil_setBalance", a, hex(10**20), "--rpc-url", E_FORK)
    enc = lambda t, v: sh("cast", "abi-encode", f"f({t})", v)
    info = sh("cast", "abi-encode", "f(bytes,bytes,bytes)", enc("string", "Wrapped NVIDIA xStock"), enc("string", "wNVDAx"), enc("uint8", "18"))
    mint = sh("cast", "calldata", "finalizeInboundTransfer(address,address,address,uint256,bytes)", WNVDAX_L1, USER, USER, str(5 * 10**18),
              sh("cast", "abi-encode", "f(bytes,bytes)", info, "0x"))
    supply0 = int(call(WNVDAX, "totalSupply()(uint256)").split()[0])
    json.loads(sh("cast", "send", "--unlocked", "--from", alias, L2_GATEWAY, mint, "--gas-limit", "600000", "--rpc-url", E_FORK, "--json"))
    check("5 wNVDAx arrive over the bridge", int(call(WNVDAX, "balanceOf(address)(uint256)", USER).split()[0]), 5 * 10**18)
    check("the bridge minted them (supply up by 5)", int(call(WNVDAX, "totalSupply()(uint256)").split()[0]) - supply0, 5 * 10**18)
    usdc_in = int(round(5 * px * 10**6))
    sh("cast", "send", "--unlocked", "--from", PM, USDC, "transfer(address,uint256)", USER, str(usdc_in), "--rpc-url", E_FORK)
    for t in (USDC, WNVDAX):
        sh("cast", "send", "--unlocked", "--from", USER, t, "approve(address,uint256)", vault, str(2**255), "--rpc-url", E_FORK)
    r = json.loads(sh("cast", "send", "--unlocked", "--from", USER, vault, "deposit(uint256,uint256,uint256,address)", "1", str(5 * 10**18), str(usdc_in), USER,
                      "--gas-limit", "2000000", "--rpc-url", E_FORK, "--json"))
    check(f"a first deposit of 5 wNVDAx and {usdc_in / 1e6:.2f} USDC goes in ({int(r['gasUsed'], 16):,} gas)", r["status"], "0x1")
    main = call(vault, "main()(int24,int24,uint128)").split("\n")
    tick = int(call(vault, "price()(uint160,int24)").split("\n")[1].split()[0])
    check("the main range holds liquidity around the price", int(main[2].split()[0]) > 0 and int(main[0].split()[0]) <= tick < int(main[1].split()[0]))
    value = int(call(vault, "totalValue()(uint256)").split()[0])
    check(f"the vault counts its value in USDC (${value / 1e6:,.2f})", abs(value / (2 * usdc_in) - 1) < 0.005)
    check("the helper now refuses to move the price", sh("cast", "call", SETTER, "set((address,address,uint24,int24,address),uint160)", KEY, str(sqrt_price(100)), "--rpc-url", E_FORK, ok=False).startswith("ERR"))
    print("gas:", gas)
    write(False, gas)
    write(True, gas)
    print("ALL GOOD" if bad == 0 else f"{bad} FAILED")
    sys.exit(1 if bad else 0)
