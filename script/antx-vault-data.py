#!/usr/bin/env python3
"""Builds what is needed to open the wANTx-USDC vault on Elysium: four transactions.

wANTx is "Wrapped Anthropic xStock" on HyperEVM (0xabec...2649; Hyperliquid's spot token ANTX is linked to it).
On Elysium it is the token the canonical bridge makes for it, which does not exist until something is bridged.
The vault is the same contract as the HYPE-USDC and HYPE-KNTQ vaults (LiquidityVaultV2, frozen source), on a new
hookless 0.3% pool of USDC and wANTx in which the vault is the only liquidity to begin with.

  H1  HyperEVM  bridge message with amount 0: makes the bridge create wANTx on Elysium (any wallet; no wANTx needed)
  E1  Elysium   EmptyPoolPrice: a helper anyone can use to put an EMPTY pool at a price (any wallet)
  E2  Elysium   open the pool at the market price, through E1 (any wallet; price read from Hyperliquid's ANTX/USDC book)
  E3  Elysium   the vault (any wallet): fee recipient VaultFeeSplit, owner and keeper as the other vaults

E1 and E3 go through the standard CREATE2 factory, so their addresses are known beforehand; their data is fixed
and is written here. H1 and E2 depend on the moment they are sent (bridge fees, the price), so the launch page
builds them from the pieces written here. This script builds the same two the same way for the rehearsal.

  python3 script/antx-vault-data.py             writes site/tools/antx-vault-data.json and the deployment record
  python3 script/antx-vault-data.py --local     the same for local forks (Elysium on 8597, HyperEVM on 8598)
  python3 script/antx-vault-data.py --verify    replays all four on FRESH forks on those ports, reads everything
                                                back, records the gas, and makes a first deposit
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
E_REAL, H_REAL = "https://rpc.elysium.kinetiq.xyz", "https://rpc.hyperliquid.xyz/evm"
E_FORK, H_FORK = "http://127.0.0.1:8597", "http://127.0.0.1:8598"


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
FEE_TO = "0xB92c756347de468d7086a97EF112801b3371a408"    # VaultFeeSplit: 20% creator wallet, 80% vault fee inbox
FEE_INBOX = "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c"
L2_ROUTER = "0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17"
L2_GATEWAY = "0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f"
RETRYABLE = "0x000000000000000000000000000000000000006E"
# HyperEVM
WANTX_L1 = "0xabec6AeAb037b77c09a2a99264F9C81a35B02649"
L1_ROUTER = "0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0"
L1_GATEWAY = "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c"
INBOX = "0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff"
HL_COIN = "@1192"                                        # ANTX/USDC on Hyperliquid's spot market
# the vault
FEE, SPACING = 3000, 60                                  # 0.30%
MAIN, ALT = 30, 30                                       # half-widths in tick spacings, as the other vaults
CAP = 300 * 10**18                                       # wANTx of total value (about $26,000 at $87), to start with
NAME, SYMBOL = "Liquid Reserve Vault wANTx-USDC v2", "lrvwANTx-USDC-2"
TICKET_GAS = 1_000_000                                   # for the bridge to create the token on Elysium (about 490,000 used)

sh("forge", "build", "--silent")
WANTX = sh("cast", "call", L2_ROUTER, "calculateL2TokenAddress(address)(address)", WANTX_L1, "--rpc-url", E_REAL)
assert int(USDC, 16) < int(WANTX, 16), "USDC must sort before wANTx"
KEY = f"({USDC},{WANTX},{FEE},{SPACING},{Z})"
POOL_ID = sh("cast", "keccak", sh("cast", "abi-encode", "f(address,address,uint24,int24,address)", USDC, WANTX, str(FEE), str(SPACING), Z))


def c2(contract, salt_text, types, values):
    """(address, transaction data, constructor args) of a CREATE2 deployment through the standard factory."""
    salt = sh("cast", "keccak", salt_text)
    args = sh("cast", "abi-encode", f"f({types})", *values)
    init = sh("forge", "inspect", contract, "bytecode") + args[2:]
    addr = sh("cast", "to-check-sum-address", "0x" + sh("cast", "keccak", "0xff" + FACTORY[2:] + salt[2:] + sh("cast", "keccak", init)[2:])[-40:])
    return addr, salt + init[2:], args


setter, d_setter, a_setter = c2("EmptyPoolPrice", "liquidreserve.xyz EmptyPoolPrice v1", "address", [PM])
vault, d_vault, a_vault = c2(
    "LiquidityVaultV2", "liquidreserve.xyz wANTx-USDC vault v2",
    "((address,address,uint24,int24,address),address,address,address,address,address,string,string,int24,int24,uint256)",
    [f"({KEY},{PM},{FEE_TO},{WHYPE},{OWNER},{BOT},{NAME},{SYMBOL},{MAIN},{ALT},{CAP})"])

SEL = {k: sh("cast", "sig", v) for k, v in {
    "outboundTransferCustomRefund": "outboundTransferCustomRefund(address,address,address,uint256,uint256,uint256,bytes)",
    "calculateRetryableSubmissionFee": "calculateRetryableSubmissionFee(uint256,uint256)",
    "set": "set((address,address,uint24,int24,address),uint160)",
    "redeem": "redeem(bytes32)",
    "getSlot0": "getSlot0(bytes32)",
    "getLiquidity": "getLiquidity(bytes32)",
}.items()}
TOPIC = {"TicketCreated": sh("cast", "keccak", "TicketCreated(bytes32)")}


# ---- the two transactions that depend on the moment, built as the launch page builds them
def h1(sender, h_rpc, e_rpc):
    """Bridge 0 wANTx from HyperEVM: the bridge then creates the token on Elysium. Returns (to, data, value)."""
    base_fee = int(json.loads(sh("cast", "rpc", "eth_getBlockByNumber", "latest", "false", "--rpc-url", h_rpc))["baseFeePerGas"], 16)
    assert base_fee > 0, "could not read HyperEVM's base fee"
    fee = int(sh("cast", "call", INBOX, "calculateRetryableSubmissionFee(uint256,uint256)(uint256)", "1000", str(base_fee), "--rpc-url", h_rpc).split()[0])
    assert fee > 0, "the bridge quoted no submission fee"
    max_submission = fee * 3   # what is not used comes back on Elysium
    bid = max(int(sh("cast", "gas-price", "--rpc-url", e_rpc)) * 2, 10**9)
    extra = sh("cast", "abi-encode", "f(uint256,bytes)", str(max_submission), "0x")
    data = sh("cast", "calldata", "outboundTransferCustomRefund(address,address,address,uint256,uint256,uint256,bytes)",
              WANTX_L1, sender, sender, "0", str(TICKET_GAS), str(bid), extra)
    return L1_ROUTER, data, max_submission + TICKET_GAS * bid


def sqrt_price(dollars):
    """sqrtPriceX96 of the pool (raw wANTx per raw USDC) for a wANTx worth `dollars`."""
    return math.isqrt((10**12 << 192) * 10**8 // int(round(dollars * 10**8)))


def e2(dollars):
    return setter, sh("cast", "calldata", "set((address,address,uint24,int24,address),uint160)", KEY, str(sqrt_price(dollars)))


def hl_mid():
    req = urllib.request.Request("https://api.hyperliquid.xyz/info", data=json.dumps({"type": "l2Book", "coin": HL_COIN}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        bids, asks = json.load(r)["levels"]
    return (float(bids[0]["px"]) + float(asks[0]["px"])) / 2


def write(local, gas=None):
    old_path = os.path.join(ROOT, "site", "tools", "antx-vault-data.json")
    old = {s["id"]: s for s in json.load(open(old_path)).get("steps", [])} if os.path.exists(old_path) else {}
    gas = gas or {i: s.get("gasEstimate") for i, s in old.items() if s.get("gasEstimate")}

    def step(i, chain, title, **kw):
        s = {"id": i, "chainId": chain, "title": title, **kw}
        if gas.get(i):
            s["gasEstimate"] = int(gas[i])
        return s

    data = {
        "chains": {"99901": {"name": "Elysium", "rpc": E_FORK if local else E_REAL, "explorer": "https://elyscan.live"},
                   "999": {"name": "HyperEVM", "rpc": H_FORK if local else H_REAL, "explorer": "https://hyperevmscan.io"}},
        "owner": OWNER, "keeper": BOT, "creator": CREATOR, "factory": FACTORY, "multicall": MULTICALL3,
        "feeTo": FEE_TO, "feeInbox": FEE_INBOX, "name": NAME, "symbol": SYMBOL, "cap": str(CAP), "mainWidth": MAIN, "altWidth": ALT,
        "hyperliquid": {"api": "https://api.hyperliquid.xyz/info", "coin": HL_COIN},
        "hyperevm": {"wantx": WANTX_L1, "router": L1_ROUTER, "gateway": L1_GATEWAY, "inbox": INBOX, "ticketGas": TICKET_GAS},
        "elysium": {"wantx": WANTX, "usdc": USDC, "poolManager": PM, "stateView": STATE_VIEW, "gateway": L2_GATEWAY, "retryable": RETRYABLE,
                    "priceSetter": setter, "vault": vault, "pool": POOL_ID,
                    "key": {"currency0": USDC, "currency1": WANTX, "fee": FEE, "tickSpacing": SPACING, "hooks": Z}},
        "sel": SEL, "topic": TOPIC,
        "steps": [
            step("H1", 999, "HyperEVM: have the bridge create wANTx on Elysium", build="bridge"),
            step("E1", 99901, "Elysium: the helper that sets an empty pool's price", to=FACTORY, data=d_setter, value="0x0", creates=setter),
            step("E2", 99901, "Elysium: open the wANTx-USDC pool at the market price", build="price"),
            step("E3", 99901, "Elysium: the vault", to=FACTORY, data=d_vault, value="0x0", creates=vault),
        ],
    }
    out = os.path.join(ROOT, "site", "tools", "antx-vault-data.local.json" if local else "antx-vault-data.json")
    json.dump(data, open(out, "w"), indent=2)
    if not local:
        record = {**data, "constructorArgs": {"EmptyPoolPrice": a_setter, "LiquidityVaultV2": a_vault}}
        json.dump(record, open(os.path.join(ROOT, "deployments", "elysium-99901", "antx-vault-launch-data.json"), "w"), indent=2)
    return out


for k, v in [("wANTx on Elysium", WANTX), ("pool id", POOL_ID), ("price helper", setter), ("vault", vault)]:
    print(f"{k:<18}{v}")
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

    call = lambda rpc, to, sig, *a: sh("cast", "call", to, sig, *a, "--rpc-url", rpc)
    code = lambda rpc, a: sh("cast", "code", a, "--rpc-url", rpc)
    WHO = "0x00000000000000000000000000000000000A11ce"   # any wallet: holds no wANTx
    for rpc in (E_FORK, H_FORK):
        sh("cast", "rpc", "anvil_autoImpersonateAccount", "true", "--rpc-url", rpc)
        sh("cast", "rpc", "anvil_setBalance", WHO, hex(10**20), "--rpc-url", rpc)
    sh("cast", "rpc", "anvil_mine", "0x1", "--rpc-url", E_FORK)
    check("fresh fork: wANTx is not on Elysium yet", code(E_FORK, WANTX), "0x")
    check("fresh fork: the vault is not there yet", code(E_FORK, vault), "0x")
    gas = {}

    def send(rpc, to, data, value=0, sender=WHO, limit=None):
        est = int(sh("cast", "estimate", "--from", sender, to, data, "--value", str(value), "--rpc-url", rpc))
        r = json.loads(sh("cast", "send", "--unlocked", "--from", sender, to, data, "--value", str(value), "--gas-limit", str(limit or est * 12 // 10), "--rpc-url", rpc, "--json"))
        return est, r

    # H1 on HyperEVM, then what the bridge does with it on Elysium
    to, data, value = h1(WHO, H_FORK, E_REAL)
    gas["H1"], r = send(H_FORK, to, data, value)
    check(f"H1 sent from a wallet with no wANTx (estimate {gas['H1']:,} gas, {value / 1e18:.5f} HYPE for the bridge)", r["status"], "0x1")
    topic = sh("cast", "keccak", "InboxMessageDelivered(uint256,bytes)")
    log = next(l for l in r["logs"] if l["address"].lower() == INBOX.lower() and l["topics"][0] == topic)
    d = sh("cast", "abi-decode", "f()(bytes)", log["data"])[2:]
    word = lambda i: d[i * 64:(i + 1) * 64]
    retry_to, retry_data = "0x" + word(0)[24:], "0x" + d[9 * 64: 9 * 64 + int(word(8), 16) * 2]
    check("the ticket goes to Elysium's token gateway", retry_to, L2_GATEWAY)
    check("with the gas asked for", int(word(6), 16), TICKET_GAS)
    alias = sh("cast", "to-check-sum-address", hex((int(L1_GATEWAY, 16) + 0x1111000000000000000000000000000000001111) % 2**160))
    sh("cast", "rpc", "anvil_setBalance", alias, hex(10**19), "--rpc-url", E_FORK)
    r = json.loads(sh("cast", "send", "--unlocked", "--from", alias, retry_to, retry_data, "--gas-limit", str(TICKET_GAS), "--rpc-url", E_FORK, "--json"))
    check(f"the bridge creates the token within the ticket's gas (used {int(r['gasUsed'], 16):,} of {TICKET_GAS:,})", r["status"], "0x1")
    check("wANTx exists on Elysium", code(E_FORK, WANTX) != "0x")
    check("its name", call(E_FORK, WANTX, "name()(string)"), '"Wrapped Anthropic xStock"')
    check("its symbol", call(E_FORK, WANTX, "symbol()(string)"), '"wANTx"')
    check("its decimals", call(E_FORK, WANTX, "decimals()(uint8)"), 18)
    check("it points back at wANTx on HyperEVM", call(E_FORK, WANTX, "l1Address()(address)"), WANTX_L1)

    # E1
    gas["E1"], r = send(E_FORK, FACTORY, d_setter)
    check(f"E1 the price helper is created at {setter} (estimate {gas['E1']:,})", code(E_FORK, setter) != "0x")
    check("it is bound to the pool manager", call(E_FORK, setter, "poolManager()(address)"), PM)
    # E2
    px = hl_mid()
    to, data = e2(px)
    gas["E2"], r = send(E_FORK, to, data)
    slot0 = call(E_FORK, STATE_VIEW, "getSlot0(bytes32)(uint160,int24,uint24,uint24)", POOL_ID).split("\n")
    got = 10**12 / (int(slot0[0].split()[0]) / 2**96) ** 2
    check(f"E2 the pool opens at ${got:.2f} (Hyperliquid mid ${px:.2f}; estimate {gas['E2']:,})", abs(got / px - 1) < 0.0001)
    check("the pool's fee is 0.30%", slot0[3].split()[0], FEE)
    # E3
    gas["E3"], r = send(E_FORK, FACTORY, d_vault)
    check(f"E3 the vault is created at {vault} (estimate {gas['E3']:,})", code(E_FORK, vault) != "0x")
    check("fee recipient = VaultFeeSplit", call(E_FORK, vault, "feeRecipient()(address)"), FEE_TO)
    check("VaultFeeSplit pays 20% to the creator wallet", call(E_FORK, FEE_TO, "recipientA()(address)") + " " + call(E_FORK, FEE_TO, "bpsA()(uint16)"), CREATOR + " 2000")
    check("and the rest to the vault fee inbox", call(E_FORK, FEE_TO, "recipientB()(address)"), FEE_INBOX)
    check("owner = owner wallet", call(E_FORK, vault, "owner()(address)"), OWNER)
    check("keeper = the bot", call(E_FORK, vault, "keeper()(address)"), BOT)
    check("token0 = USDC", call(E_FORK, vault, "token0()(address)"), USDC)
    check("token1 = wANTx", call(E_FORK, vault, "token1()(address)"), WANTX)
    check("pool id", call(E_FORK, vault, "poolId()(bytes32)"), POOL_ID)
    check("not a HYPE pool", call(E_FORK, vault, "nativePool()(bool)"), "false")
    check("performance fee 20%", call(E_FORK, vault, "PERFORMANCE_FEE_BPS()(uint256)").split()[0], 2000)
    check("range widths 30 / 30", call(E_FORK, vault, "mainWidth()(int24)") + "/" + call(E_FORK, vault, "altWidth()(int24)"), f"{MAIN}/{ALT}")
    check("cap 300 wANTx of value", call(E_FORK, vault, "depositCap()(uint256)").split()[0], CAP)
    check("name", call(E_FORK, vault, "name()(string)"), f'"{NAME}"')
    check("symbol", call(E_FORK, vault, "symbol()(string)"), f'"{SYMBOL}"')

    if "--no-deposit" in sys.argv:   # leave the vault empty (for trying a first deposit through the site)
        print("gas:", gas)
        write(False, gas)
        write(True, gas)
        print("ALL GOOD (no deposit made)" if bad == 0 else f"{bad} FAILED")
        sys.exit(1 if bad else 0)
    # a first deposit of both tokens, by someone who bridged wANTx in
    USER = "0x00000000000000000000000000000000000B0b01"
    sh("cast", "rpc", "anvil_setBalance", USER, hex(10**20), "--rpc-url", E_FORK)
    mint = sh("cast", "calldata", "finalizeInboundTransfer(address,address,address,uint256,bytes)", WANTX_L1, USER, USER, str(5 * 10**18),
              "0x" + retry_data[2:][8 + 4 * 64 + 64 + 64:])  # the same token info the real message carried
    json.loads(sh("cast", "send", "--unlocked", "--from", alias, L2_GATEWAY, mint, "--gas-limit", "600000", "--rpc-url", E_FORK, "--json"))
    sh("cast", "rpc", "anvil_setBalance", PM, hex(10**19), "--rpc-url", E_FORK)
    usdc_in = int(round(5 * px * 10**6))
    sh("cast", "send", "--unlocked", "--from", PM, USDC, "transfer(address,uint256)", USER, str(usdc_in), "--rpc-url", E_FORK)
    for t in (USDC, WANTX):
        sh("cast", "send", "--unlocked", "--from", USER, t, "approve(address,uint256)", vault, str(2**255), "--rpc-url", E_FORK)
    r = json.loads(sh("cast", "send", "--unlocked", "--from", USER, vault, "deposit(uint256,uint256,uint256,address)", "1", str(usdc_in), str(5 * 10**18), USER,
                      "--gas-limit", "2000000", "--rpc-url", E_FORK, "--json"))
    check(f"a first deposit of 5 wANTx and {usdc_in / 1e6:.2f} USDC goes in ({int(r['gasUsed'], 16):,} gas)", r["status"], "0x1")
    main = call(E_FORK, vault, "main()(int24,int24,uint128)").split("\n")
    check("the main range holds liquidity", int(main[2].split()[0]) > 0)
    check("the helper now refuses to move the price", sh("cast", "call", setter, "set((address,address,uint24,int24,address),uint160)", KEY, str(sqrt_price(50)), "--rpc-url", E_FORK, ok=False).startswith("ERR"))
    print("gas:", gas)
    write(False, gas)
    write(True, gas)
    print("ALL GOOD" if bad == 0 else f"{bad} FAILED")
    sys.exit(1 if bad else 0)
