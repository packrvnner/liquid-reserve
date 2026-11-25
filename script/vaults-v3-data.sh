#!/bin/bash
# Builds the three transactions that open self-balancing replacements for the HYPE-KNTQ vault
# (LiquidityVaultV2, swaps in its own pool) and both HYPE-$liquid vaults (LiquidityVaultV3,
# swap in Ascend's $liquid pool, where the other liquidity is). Each goes through the standard
# CREATE2 factory, so every address is known beforehand. Same pools, widths and caps as the vaults
# they replace. Their fee cut goes to VaultFeeSplit (FeeSplitter: 20% to the creator wallet, 80% to the
# vault fee inbox, which ends up in the reserve; created by step 1 of site/tools/creator-share.html).
# Writes site/tools/vaults-v3-data.json. Sends nothing.
# VERIFY=1 replays on a fork: creates the splitter first (if missing), then all three vaults, and makes a
# one-token first deposit into each.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
PM=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
WHYPE=0xbA876237B0F021A6c6D852d6c26E107997cC5E81
KNTQ=0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0
LIQUID=0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6
LAUNCHPAD=0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC
FEE_TO=0xB92c756347de468d7086a97EF112801b3371a408   # VaultFeeSplit: 20% creator 0x9324...1DC37, 80% fee inbox 0x2AfD...3a5c
OWNER=0x822aA88543b9da39c4c3D856857379E17526C1E8
BOT=0x0461663d46DA68264966a0670335E3ecf0b96F3C
Z=0x0000000000000000000000000000000000000000
ASCEND="($LIQUID,$WHYPE,8388608,200,$LAUNCHPAD)"
OUT=site/tools/vaults-v3-data.json
forge build -q
lower() { tr 'A-F' 'a-f'; }
c2() { local h; h=$(cast keccak "0xff$(echo ${FACTORY:2} | lower)${2:2}$(cast keccak "$1" | cut -c3-)"); cast to-check-sum-address "0x${h:26}"; }
V2T="f(((address,address,uint24,int24,address),address,address,address,address,address,string,string,int24,int24,uint256))"
V3T="f(((address,address,uint24,int24,address),address,address,address,address,address,string,string,int24,int24,uint256,(address,address,uint24,int24,address),uint24))"
S1=$(cast keccak "liquidreserve.xyz HYPE-KNTQ vault v2")
I1="$(forge inspect LiquidityVaultV2 bytecode)$(cast abi-encode "$V2T" "(($Z,$KNTQ,3000,60,$Z),$PM,$FEE_TO,$WHYPE,$OWNER,$BOT,Liquid Reserve Vault HYPE-KNTQ v2,lrvHYPE-KNTQ-2,30,30,90000000000000000000000)" | cut -c3-)"
S2=$(cast keccak "liquidreserve.xyz HYPE-liquid vault v3")
I2="$(forge inspect LiquidityVaultV3 bytecode)$(cast abi-encode "$V3T" "(($Z,$LIQUID,20000,200,$Z),$PM,$FEE_TO,$WHYPE,$OWNER,$BOT,Liquid Reserve Vault HYPE-liquid v3,lrvHYPE-LIQUID-3,30,30,300000000000000000000000000,$ASCEND,20000)" | cut -c3-)"
S3=$(cast keccak "liquidreserve.xyz HYPE-liquid 0.5% vault v3")
I3="$(forge inspect LiquidityVaultV3 bytecode)$(cast abi-encode "$V3T" "(($Z,$LIQUID,5000,100,$Z),$PM,$FEE_TO,$WHYPE,$OWNER,$BOT,Liquid Reserve Vault HYPE-liquid 0.5% v3,lrvHYPE-LIQUID-05-3,60,60,300000000000000000000000000,$ASCEND,20000)" | cut -c3-)"
A1=$(c2 "$I1" "$S1"); A2=$(c2 "$I2" "$S2"); A3=$(c2 "$I3" "$S3")
export OUT RPC FACTORY OWNER BOT FEE_TO A1 A2 A3 D1="${S1}${I1:2}" D2="${S2}${I2:2}" D3="${S3}${I3:2}"
python3 - <<'PY'
import json, os
E = os.environ; out = E["OUT"]
old = {s["id"]: s for s in (json.load(open(out)).get("steps", []) if os.path.exists(out) else [])}
def step(i, title, vault, data, contract):
    s = {"id": i, "title": title, "vault": vault, "to": E["FACTORY"], "data": data, "value": "0x0", "contract": contract}
    if old.get(i, {}).get("data") == data and "gasEstimate" in old[i]: s["gasEstimate"] = old[i]["gasEstimate"]
    return s
json.dump({"chainId": 99901, "rpc": E["RPC"], "explorer": "https://elyscan.live", "owner": E["OWNER"], "keeper": E["BOT"], "feeTo": E["FEE_TO"], "steps": [
    step("hype-kntq", "HYPE-KNTQ (swaps in its own pool)", E["A1"], E["D1"], "LiquidityVaultV2"),
    step("hype-liquid", "HYPE-$liquid 2% (swaps in Ascend's pool)", E["A2"], E["D2"], "LiquidityVaultV3"),
    step("hype-liquid-05", "HYPE-$liquid 0.5% (swaps in Ascend's pool)", E["A3"], E["D3"], "LiquidityVaultV3"),
]}, open(out, "w"), indent=2)
PY
echo "HYPE-KNTQ v2        $A1"; echo "HYPE-liquid 2% v3   $A2"; echo "HYPE-liquid 0.5% v3 $A3"; echo "wrote $OUT"
if [ "${VERIFY:-0}" = "1" ]; then
  PORT=8599; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1" >&2; exit 1; }
  if [ "$(cast code $FEE_TO --rpc-url $F)" = "0x" ]; then
    cast send 0xcA11bde05977b3631167028862bE2a173976CA11 "$(python3 -c "import json;print(json.load(open('site/tools/creator-share-data.json'))['deploy'])")" --private-key $KEY --rpc-url $F >/dev/null
  fi
  [ "$(cast call $FEE_TO 'bpsA()(uint16)' --rpc-url $F)" = "2000" ] && [ "$(cast call $FEE_TO 'recipientB()(address)' --rpc-url $F | lower)" = "0x2afd3850794b84205667ce2826b09fa5bf1c3a5c" ] && ok "fee splitter $FEE_TO: 20% creator, 80% fee inbox" || bad "fee splitter missing or wrong"
  GASES=""
  for i in 1 2 3; do
    eval "D=\$D$i; A=\$A$i"
    [ "$(cast code $A --rpc-url $F)" = "0x" ] || bad "already deployed: $A"
    cast rpc evm_mine --rpc-url $F >/dev/null
    G=$(cast estimate $FACTORY "$D" --from $SENDER --rpc-url $F); GASES="$GASES $G"
    cast send $FACTORY "$D" --private-key $KEY --rpc-url $F --gas-limit $(( G * 12 / 10 )) >/dev/null
    [ "$(cast call $A 'owner()(address)' --rpc-url $F | lower)" = "$(echo $OWNER | lower)" ] && [ "$(cast call $A 'keeper()(address)' --rpc-url $F | lower)" = "$(echo $BOT | lower)" ] && [ "$(cast call $A 'feeRecipient()(address)' --rpc-url $F | lower)" = "$(echo $FEE_TO | lower)" ] || bad "settings of $A"
    cast send $A "deposit(uint256,uint256,uint256,address)" 1 50000000000000000 0 $SENDER --value 0.05ether --private-key $KEY --rpc-url $F >/dev/null
    B1=$(cast call $A 'balances()(uint256,uint256)' --rpc-url $F | sed -n 2p | awk '{print $1}')
    ML=$(cast call $A 'main()(int24,int24,uint128)' --rpc-url $F | sed -n 3p | awk '{print $1}')
    [ "$B1" != "0" ] && [ "$ML" != "0" ] && ok "vault $i opened at $A; a HYPE-only first deposit balanced itself" || bad "vault $i did not balance"
  done
  export GASES
  python3 - <<'PY'
import json, os
out = os.environ["OUT"]; d = json.load(open(out)); g = os.environ["GASES"].split()
for s, x in zip(d["steps"], g): s["gasEstimate"] = int(x)
json.dump(d, open(out, "w"), indent=2); print("gas", g)
PY
fi
