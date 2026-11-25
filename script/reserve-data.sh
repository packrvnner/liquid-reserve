#!/bin/bash
# Builds the transactions that launch the pre-launch reserve: two on HyperEVM and
# two on Elysium through the standard CREATE2 factory (so every address is known
# beforehand), then the one permanent step that connects the live vault fee inbox.
# Writes site/tools/reserve-data.json. Sends nothing.
# VERIFY=1 also replays everything on copies of both chains and runs real fees through.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
ERPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
HRPC="${HYPEREVM_RPC:-https://rpc.hyperliquid.xyz/evm}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
OWNER=0x822aA88543b9da39c4c3D856857379E17526C1E8
BOT=0x0461663d46DA68264966a0670335E3ecf0b96F3C
VAULT_INBOX=0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c
DELAY=172800          # timelock: 48 hours
SLIPPAGE=100          # swaps may land at most 1% below the average price
BRIDGE_MIN=25000000000000000000   # 25 KNTQ per bridge batch
SALT=$(cast keccak "liquidreserve.xyz pre-launch reserve v1")
OUT=site/tools/reserve-data.json
forge build -q
lower() { tr 'A-F' 'a-f'; }
c2() { # initcode -> CREATE2 address
  local h; h=$(cast keccak "0xff$(echo ${FACTORY:2} | lower)${SALT:2}$(cast keccak "$1" | cut -c3-)")
  cast to-check-sum-address "0x${h:26}"
}
child() { cast compute-address "$1" --nonce "$2" | awk '{print $NF}'; }

INIT_A="$(forge inspect ReserveLaunchA bytecode)$(cast abi-encode 'f(address,address,uint256,uint16)' $OWNER $BOT $DELAY $SLIPPAGE | cut -c3-)"
A=$(c2 "$INIT_A")
TIMELOCK=$(child $A 1); SWAPPER=$(child $A 2); ORACLE=$(child $A 3); SWAPCONFIG=$(child $A 4); KHYPE_RATE=$(child $A 5)
CREATOR_WAIT=$(child $A 6); LIQUID_WAIT=$(child $A 7); YIELD_WAIT=$(child $A 8)

INIT_H1="$(forge inspect ReserveLaunchH1 bytecode)$(cast abi-encode 'f(address)' $YIELD_WAIT | cut -c3-)"
H1=$(c2 "$INIT_H1"); SKNTQ_RATE=$(child $H1 1); YIELD_BRIDGE=$(child $H1 2)
INIT_H2="$(forge inspect ReserveLaunchH2 bytecode)$(cast abi-encode 'f(address)' $H1 | cut -c3-)"
H2=$(c2 "$INIT_H2"); H_RESERVE=$(child $H2 1); STAKE_AND_LOCK=$(child $H2 2)

INIT_B="$(forge inspect ReserveLaunchB bytecode)$(cast abi-encode 'f(address,address,uint256)' $A $STAKE_AND_LOCK $BRIDGE_MIN | cut -c3-)"
B=$(c2 "$INIT_B"); BRIDGE_OUT=$(child $B 1); RESERVE=$(child $B 2); ALLOCATOR=$(child $B 3); SPLITTER=$(child $B 4)
CONNECT=$(cast calldata 'setTarget(address)' $SPLITTER)

export OUT ERPC HRPC FACTORY OWNER BOT VAULT_INBOX SALT A B H1 H2 CONNECT
export D_A="${SALT}${INIT_A:2}" D_B="${SALT}${INIT_B:2}" D_H1="${SALT}${INIT_H1:2}" D_H2="${SALT}${INIT_H2:2}"
export TIMELOCK SWAPPER ORACLE SWAPCONFIG KHYPE_RATE CREATOR_WAIT LIQUID_WAIT YIELD_WAIT SKNTQ_RATE YIELD_BRIDGE H_RESERVE STAKE_AND_LOCK BRIDGE_OUT RESERVE ALLOCATOR SPLITTER
python3 - <<'PY'
import json, os
E = os.environ
out = E["OUT"]
old = json.load(open(out)) if os.path.exists(out) else {}
oldsteps = {s["id"]: s for s in old.get("steps", [])}
def step(id, chain, title, to, data, frm=None):
    s = {"id": id, "chainId": chain, "title": title, "to": to, "data": data, "value": "0x0"}
    if frm: s["from"] = frm
    o = oldsteps.get(id)
    if o and o.get("data") == data and "gasEstimate" in o: s["gasEstimate"] = o["gasEstimate"]
    return s
new = {
  "chains": {"99901": {"name": "Elysium", "rpc": E["ERPC"], "explorer": "https://elyscan.live"},
             "999": {"name": "HyperEVM", "rpc": E["HRPC"], "explorer": "https://hyperevmscan.io"}},
  "owner": E["OWNER"], "keeper": E["BOT"], "vaultFeeInbox": E["VAULT_INBOX"], "salt": E["SALT"],
  "steps": [
    step("A", 99901, "Elysium: timelock, swaps, price oracle, waiting rooms", E["FACTORY"], E["D_A"]),
    step("H1", 999, "HyperEVM: sKNTQ rate and yield bridge", E["FACTORY"], E["D_H1"]),
    step("H2", 999, "HyperEVM: sKNTQ locked reserve and stake-and-lock", E["FACTORY"], E["D_H2"]),
    step("B", 99901, "Elysium: bridge, kHYPE locked reserve, allocator, fee splitter", E["FACTORY"], E["D_B"]),
    step("connect", 99901, "Elysium: connect the vault fee inbox to the reserve (permanent)", E["VAULT_INBOX"], E["CONNECT"], E["OWNER"]),
  ],
  "elysium": {"launchA": E["A"], "launchB": E["B"], "timelock": E["TIMELOCK"], "swapper": E["SWAPPER"], "oracle": E["ORACLE"],
              "swapConfig": E["SWAPCONFIG"], "khypeRate": E["KHYPE_RATE"], "creatorWait": E["CREATOR_WAIT"],
              "liquidWait": E["LIQUID_WAIT"], "yieldWait": E["YIELD_WAIT"], "bridgeOut": E["BRIDGE_OUT"],
              "reserve": E["RESERVE"], "allocator": E["ALLOCATOR"], "feeSplitter": E["SPLITTER"]},
  "hyperevm": {"launchH1": E["H1"], "launchH2": E["H2"], "skntqRate": E["SKNTQ_RATE"], "yieldBridge": E["YIELD_BRIDGE"],
               "reserve": E["H_RESERVE"], "stakeAndLock": E["STAKE_AND_LOCK"]},
}
json.dump(new, open(out, "w"), indent=2)
PY
echo "Elysium   A $A   B $B"
echo "          reserve $RESERVE  allocator $ALLOCATOR  splitter $SPLITTER"
echo "          creatorWait $CREATOR_WAIT  liquidWait $LIQUID_WAIT  yieldWait $YIELD_WAIT"
echo "HyperEVM  H1 $H1  H2 $H2"
echo "          reserve $H_RESERVE  stakeAndLock $STAKE_AND_LOCK  yieldBridge $YIELD_BRIDGE"
echo "wrote $OUT"

if [ "${VERIFY:-0}" = "1" ]; then
  EP=8597; HP=8598; EF=http://127.0.0.1:$EP; HF=http://127.0.0.1:$HP
  anvil --fork-url "$ERPC" --port $EP --silent & P1=$!
  anvil --fork-url "$HRPC" --port $HP --silent & P2=$!
  trap 'kill $P1 $P2 2>/dev/null' EXIT
  for u in $EF $HF; do for _ in $(seq 1 80); do cast chain-id --rpc-url $u >/dev/null 2>&1 && break; sleep 0.5; done; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1" >&2; exit 1; }
  eq() { [ "$(echo "$2" | lower)" = "$(echo "$3" | lower)" ] && ok "$1" || bad "$1: got $2, expected $3"; }
  get() { cast call "$2" "$3" --rpc-url "$1" | awk '{print $1}'; }
  GASES=""
  deploy() { # name rpc data
    cast rpc evm_mine --rpc-url $2 >/dev/null
    local g; g=$(cast estimate $FACTORY "$3" --from $SENDER --rpc-url $2)
    cast send $FACTORY "$3" --private-key $KEY --rpc-url $2 --gas-limit $(( g * 11 / 10 )) >/dev/null
    echo "  sent $1  gas $g"; GASES="$GASES $1=$g"
  }
  cast rpc anvil_setBalance $SENDER 0x56BC75E2D63100000 --rpc-url $HF >/dev/null
  deploy A $EF "$D_A"; deploy H1 $HF "$D_H1"; deploy H2 $HF "$D_H2"; deploy B $EF "$D_B"
  eq "A.timelock"      "$(get $EF $A 'timelock()(address)')" $TIMELOCK
  eq "A.oracle"        "$(get $EF $A 'oracle()(address)')" $ORACLE
  eq "A.swapConfig"    "$(get $EF $A 'swapConfig()(address)')" $SWAPCONFIG
  eq "A.creatorWait"   "$(get $EF $A 'creatorWait()(address)')" $CREATOR_WAIT
  eq "A.liquidWait"    "$(get $EF $A 'liquidWait()(address)')" $LIQUID_WAIT
  eq "A.yieldWait"     "$(get $EF $A 'yieldWait()(address)')" $YIELD_WAIT
  eq "B.reserve"       "$(get $EF $B 'reserve()(address)')" $RESERVE
  eq "B.allocator"     "$(get $EF $B 'allocator()(address)')" $ALLOCATOR
  eq "B.feeSplitter"   "$(get $EF $B 'feeSplitter()(address)')" $SPLITTER
  eq "B.bridgeOut"     "$(get $EF $B 'bridgeOut()(address)')" $BRIDGE_OUT
  eq "bridge sends KNTQ to HyperEVM stake-and-lock" "$(get $EF $BRIDGE_OUT 'l1Recipient()(address)')" $STAKE_AND_LOCK
  eq "H2.stakeAndLock" "$(get $HF $H2 'stakeAndLock()(address)')" $STAKE_AND_LOCK
  eq "H2.reserve"      "$(get $HF $H2 'reserve()(address)')" $H_RESERVE
  eq "H1.yieldBridge"  "$(get $HF $H1 'yieldBridge()(address)')" $YIELD_BRIDGE
  eq "yield bridge pays Elysium yieldWait" "$(get $HF $YIELD_BRIDGE 'l2Recipient()(address)')" $YIELD_WAIT
  eq "HyperEVM reserve yield goes to the yield bridge" "$(get $HF $H_RESERVE 'yieldRouter()(address)')" $YIELD_BRIDGE
  eq "timelock sets liquidWait" "$(get $EF $LIQUID_WAIT 'setter()(address)')" $TIMELOCK
  eq "owner sets creatorWait"   "$(get $EF $CREATOR_WAIT 'setter()(address)')" $OWNER

  # the permanent step, as the owner wallet
  cast rpc anvil_impersonateAccount $OWNER --rpc-url $EF >/dev/null
  cast rpc anvil_setBalance $OWNER 0x56BC75E2D63100000 --rpc-url $EF >/dev/null
  cast rpc evm_mine --rpc-url $EF >/dev/null
  g=$(cast estimate $VAULT_INBOX "$CONNECT" --from $OWNER --rpc-url $EF); GASES="$GASES connect=$g"
  cast send $VAULT_INBOX "$CONNECT" --from $OWNER --unlocked --rpc-url $EF >/dev/null
  eq "vault fee inbox -> fee splitter" "$(get $EF $VAULT_INBOX 'target()(address)')" $SPLITTER

  # real fees through it: the fee tokens already sitting in the live inbox, plus 0.05 HYPE of test fees
  WHYPE=0xbA876237B0F021A6c6D852d6c26E107997cC5E81; KNTQ=0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0
  KHYPE=0x248888D396A546A69A188f3Deb476964e581E9d0; USDC=0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65
  cast send $WHYPE "deposit()" --value 0.05ether --private-key $KEY --rpc-url $EF >/dev/null
  cast send $WHYPE "transfer(address,uint256)" $VAULT_INBOX 50000000000000000 --private-key $KEY --rpc-url $EF >/dev/null
  FEEDS="[$(cast call $ORACLE 'getRoute(address,address)(bytes32[],uint24[])' $KNTQ $WHYPE --rpc-url $EF | head -1 | tr -d '[]'),$(cast call $ORACLE 'getRoute(address,address)(bytes32[],uint24[])' $WHYPE $USDC --rpc-url $EF | head -1 | tr -d '[]'),$(cast call $ORACLE 'getRoute(address,address)(bytes32[],uint24[])' $WHYPE $KHYPE --rpc-url $EF | head -1 | tr -d '[]')]"
  cast rpc anvil_impersonateAccount $BOT --rpc-url $EF >/dev/null
  cast rpc anvil_setBalance $BOT 0x56BC75E2D63100000 --rpc-url $EF >/dev/null
  for i in 1 2 3 4; do
    cast rpc evm_increaseTime 600 --rpc-url $EF >/dev/null; cast rpc evm_mine --rpc-url $EF >/dev/null
    cast send $ORACLE "poke(bytes32[])" "$FEEDS" --from $BOT --unlocked --rpc-url $EF >/dev/null
  done
  PG=$(cast estimate $ORACLE "poke(bytes32[])" "$FEEDS" --from $BOT --rpc-url $EF 2>/dev/null || echo 0)
  for t in $WHYPE $KNTQ; do
    cast send $VAULT_INBOX "forward(address)" $t --private-key $KEY --rpc-url $EF >/dev/null
    cast send $SPLITTER "distribute(address)" $t --private-key $KEY --rpc-url $EF >/dev/null
    cast send $ALLOCATOR "allocate(address)" $t --private-key $KEY --rpc-url $EF >/dev/null
  done
  bal() { cast call $1 'balanceOf(address)(uint256)' $2 --rpc-url $EF | awk '{print $1}'; }
  K=$(bal $KHYPE $RESERVE); Q=$(bal $KNTQ $BRIDGE_OUT); U=$(bal $USDC $LIQUID_WAIT); CW=$(bal $WHYPE $CREATOR_WAIT)
  [ "$K" != "0" ] && ok "kHYPE locked in the reserve: $(cast from-wei $K)" || bad "no kHYPE locked"
  [ "$Q" != "0" ] && ok "KNTQ waiting at the bridge: $(cast from-wei $Q)" || bad "no KNTQ at the bridge"
  [ "$U" != "0" ] && ok "USDC parked for the \$liquid share: $(python3 -c "print($U/1e6)")" || bad "no USDC parked"
  [ "$CW" != "0" ] && ok "creator share waiting: $(cast from-wei $CW) WHYPE" || bad "no creator share"
  export GASES PG
  python3 - <<'PY'
import json, os
out = os.environ["OUT"]; d = json.load(open(out))
g = dict(x.split("=") for x in os.environ["GASES"].split())
for s in d["steps"]: s["gasEstimate"] = int(g[s["id"]])
d["pokeGas"] = int(os.environ["PG"])
json.dump(d, open(out, "w"), indent=2)
print("gas", g, "poke", os.environ["PG"])
PY
fi
