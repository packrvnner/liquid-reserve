#!/bin/bash
# Builds the one transaction that opens the 0.5% HYPE / $liquid vault on Elysium mainnet
# through the standard CREATE2 factory, so its addresses are known beforehand.
# Writes site/tools/liquid-vault2-data.json. Sends nothing. VERIFY=1 replays it on a fork.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
PM=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
WHYPE=0xbA876237B0F021A6c6D852d6c26E107997cC5E81
LIQUID=0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6
ASCEND_POOL=0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c
FEE_INBOX=0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c
OWNER=0x822aA88543b9da39c4c3D856857379E17526C1E8
BOT=0x0461663d46DA68264966a0670335E3ecf0b96F3C
CAP=300000000000000000000000000   # 300,000,000 $liquid, measured on the vault's whole value
SALT=$(cast keccak "liquidreserve.xyz HYPE-liquid 0.5% vault v1")
OUT=site/tools/liquid-vault2-data.json
forge build -q
FEE=5000; SPACING=100; WIDTH=60
ARGS=$(cast abi-encode "f((address,address,address,bytes32,uint24,int24,int24,address,address,address,uint256,string,string))" "($PM,$WHYPE,$LIQUID,$ASCEND_POOL,$FEE,$SPACING,$WIDTH,$FEE_INBOX,$OWNER,$BOT,$CAP,\"Liquid Reserve Vault HYPE-liquid 0.5%\",\"lrvHYPE-LIQUID-05\")")
INIT="$(forge inspect LiquidVaultLaunch2 bytecode)${ARGS:2}"
DATA="${SALT}${INIT:2}"
lower() { tr 'A-F' 'a-f'; }
HASH=$(cast keccak "0xff$(echo ${FACTORY:2} | lower)${SALT:2}$(cast keccak "$INIT" | cut -c3-)")
LAUNCH=$(cast to-check-sum-address "0x${HASH:26}")
VAULT=$(cast compute-address $LAUNCH --nonce 1 | awk '{print $NF}')
POOL=$(cast keccak $(cast abi-encode "f(address,address,uint24,int24,address)" 0x0000000000000000000000000000000000000000 $LIQUID 5000 100 0x0000000000000000000000000000000000000000))
export OUT RPC FACTORY DATA SALT LAUNCH VAULT POOL OWNER BOT LIQUID
python3 - <<'PY'
import json, os
E = os.environ; out = E["OUT"]
old = json.load(open(out)) if os.path.exists(out) else {}
new = {"chainId": 99901, "rpc": E["RPC"], "explorer": "https://elyscan.live", "to": E["FACTORY"], "data": E["DATA"], "value": "0x0", "salt": E["SALT"],
       "launch": E["LAUNCH"], "vault": E["VAULT"], "poolId": E["POOL"], "owner": E["OWNER"], "keeper": E["BOT"], "liquid": E["LIQUID"],
       "feeText": "0.5%", "rangeText": "about 45% below to 82% above the price", "siteName": "HYPE-$liquid 0.5%"}
if old.get("data") == new["data"] and "gasEstimate" in old: new["gasEstimate"] = old["gasEstimate"]
json.dump(new, open(out, "w"), indent=2)
PY
echo "launch $LAUNCH"; echo "vault  $VAULT"; echo "pool   $POOL"; echo "wrote $OUT"
if [ "${VERIFY:-0}" = "1" ]; then
  PORT=8599; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1" >&2; exit 1; }
  eq() { [ "$(echo "$2" | lower)" = "$(echo "$3" | lower)" ] && ok "$1" || bad "$1: got $2, expected $3"; }
  [ "$(cast code $LAUNCH --rpc-url $F)" = "0x" ] || bad "already deployed"
  cast rpc evm_mine --rpc-url $F >/dev/null
  GAS=$(cast estimate $FACTORY "$DATA" --from $SENDER --rpc-url $F)
  cast send $FACTORY "$DATA" --private-key $KEY --rpc-url $F --gas-limit $(( GAS * 12 / 10 )) >/dev/null
  eq "launch.vault()"  "$(cast call $LAUNCH 'vault()(address)' --rpc-url $F)" $VAULT
  eq "launch.poolId()" "$(cast call $LAUNCH 'poolId()(bytes32)' --rpc-url $F)" $POOL
  eq "vault owner"     "$(cast call $VAULT 'owner()(address)' --rpc-url $F)" $OWNER
  eq "vault keeper"    "$(cast call $VAULT 'keeper()(address)' --rpc-url $F)" $BOT
  eq "vault token1"    "$(cast call $VAULT 'token1()(address)' --rpc-url $F)" $LIQUID
  eq "vault fee recipient" "$(cast call $VAULT 'feeRecipient()(address)' --rpc-url $F)" $FEE_INBOX
  eq "pool created by the launch" "$(cast call $LAUNCH 'createdPool()(bool)' --rpc-url $F)" true
  python3 - "$OUT" "$GAS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["gasEstimate"] = int(sys.argv[2]); json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  echo "gas $GAS  (about $(cast from-wei $(( GAS * $(cast gas-price --rpc-url "$RPC") ))) HYPE)"
fi
