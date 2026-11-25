#!/bin/bash
# Builds the one transaction that opens the self-balancing HYPE-USDC vault (LiquidityVaultV2)
# on Elysium mainnet through the standard CREATE2 factory, so its address is known beforehand.
# Writes site/tools/vault-v2-data.json. Sends nothing. VERIFY=1 replays it on a fork, then makes a
# HYPE-only first deposit and checks the vault balanced itself.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
PM=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
WHYPE=0xbA876237B0F021A6c6D852d6c26E107997cC5E81
USDC=0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65
FEE_INBOX=0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c
OWNER=0x822aA88543b9da39c4c3D856857379E17526C1E8
BOT=0x0461663d46DA68264966a0670335E3ecf0b96F3C
CAP=25000000000   # 25,000 USDC of total value, as the first vault
SALT=$(cast keccak "liquidreserve.xyz HYPE-USDC vault v2")
OUT=site/tools/vault-v2-data.json
forge build -q
ARGS=$(cast abi-encode "f(((address,address,uint24,int24,address),address,address,address,address,address,string,string,int24,int24,uint256))" \
  "((0x0000000000000000000000000000000000000000,$USDC,3000,60,0x0000000000000000000000000000000000000000),$PM,$FEE_INBOX,$WHYPE,$OWNER,$BOT,Liquid Reserve Vault HYPE-USDC v2,lrvHYPE-USDC-2,30,30,$CAP)")
INIT="$(forge inspect LiquidityVaultV2 bytecode)${ARGS:2}"
DATA="${SALT}${INIT:2}"
lower() { tr 'A-F' 'a-f'; }
HASH=$(cast keccak "0xff$(echo ${FACTORY:2} | lower)${SALT:2}$(cast keccak "$INIT" | cut -c3-)")
VAULT=$(cast to-check-sum-address "0x${HASH:26}")
export OUT RPC FACTORY DATA SALT VAULT OWNER BOT
python3 - <<'PY'
import json, os
E = os.environ; out = E["OUT"]
old = json.load(open(out)) if os.path.exists(out) else {}
new = {"chainId": 99901, "rpc": E["RPC"], "explorer": "https://elyscan.live", "to": E["FACTORY"], "data": E["DATA"], "value": "0x0",
       "salt": E["SALT"], "vault": E["VAULT"], "owner": E["OWNER"], "keeper": E["BOT"]}
if old.get("data") == new["data"] and "gasEstimate" in old: new["gasEstimate"] = old["gasEstimate"]
json.dump(new, open(out, "w"), indent=2)
PY
echo "vault $VAULT"; echo "wrote $OUT ($(( (${#INIT} - 2) / 2 )) bytes of initcode)"
if [ "${VERIFY:-0}" = "1" ]; then
  PORT=8599; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1" >&2; exit 1; }
  eq() { [ "$(echo "$2" | lower)" = "$(echo "$3" | lower)" ] && ok "$1" || bad "$1: got $2, expected $3"; }
  [ "$(cast code $VAULT --rpc-url $F)" = "0x" ] || bad "already deployed"
  cast rpc evm_mine --rpc-url $F >/dev/null
  GAS=$(cast estimate $FACTORY "$DATA" --from $SENDER --rpc-url $F)
  cast send $FACTORY "$DATA" --private-key $KEY --rpc-url $F --gas-limit $(( GAS * 12 / 10 )) >/dev/null
  eq "owner"  "$(cast call $VAULT 'owner()(address)' --rpc-url $F)" $OWNER
  eq "keeper" "$(cast call $VAULT 'keeper()(address)' --rpc-url $F)" $BOT
  eq "fee recipient" "$(cast call $VAULT 'feeRecipient()(address)' --rpc-url $F)" $FEE_INBOX
  eq "token1" "$(cast call $VAULT 'token1()(address)' --rpc-url $F)" $USDC
  cast send $VAULT "deposit(uint256,uint256,uint256,address)" 1 100000000000000000 0 $SENDER --value 0.1ether --private-key $KEY --rpc-url $F >/dev/null
  B1=$(cast call $VAULT 'balances()(uint256,uint256)' --rpc-url $F | sed -n 2p | awk '{print $1}')
  ML=$(cast call $VAULT 'main()(int24,int24,uint128)' --rpc-url $F | sed -n 3p | awk '{print $1}')
  [ "$B1" != "0" ] && [ "$ML" != "0" ] && ok "a HYPE-only first deposit balanced itself: $(python3 -c "print($B1/1e6)") USDC, main range funded" || bad "did not balance"
  python3 - "$OUT" "$GAS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["gasEstimate"] = int(sys.argv[2]); json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  echo "gas $GAS  (about $(cast from-wei $(( GAS * $(cast gas-price --rpc-url "$RPC") ))) HYPE)"
fi
