#!/bin/bash
# Builds the one-transaction vault launch for Elysium mainnet.
#
# The VaultLauncher is deployed through the standard CREATE2 factory, so the
# addresses of the fee inbox and both vaults are known before anything is sent.
# This writes them, and the exact transaction, to site/tools/launch-data.json.
# It sends nothing. With VERIFY=1 it also replays the transaction on a private
# fork of Elysium and checks the result.
#
#   bash script/launch-data.sh            # write the launch data
#   VERIFY=1 bash script/launch-data.sh   # ...and prove it on a fork
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
FACTORY_CODE=0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3
POOL_MANAGER=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
WHYPE=0xbA876237B0F021A6c6D852d6c26E107997cC5E81
USDC=0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65
KNTQ=0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0
OWNER="${OWNER:-0x822aA88543b9da39c4c3D856857379E17526C1E8}"
KEEPER="${KEEPER:-$OWNER}"
POOL_FEE=3000
TICK_SPACING=60
MAIN_WIDTH=30         # tick spacings each side: 1,800 ticks, about -16% / +20%
ALT_WIDTH=30
CAP_USDC=25000000000                  # 25,000 USDC
CAP_KNTQ=90000000000000000000000      # 90,000 KNTQ
SALT=$(cast keccak "liquidreserve.xyz vaults v1")
OUT=site/tools/launch-data.json

forge build -q
[ "$(cast code $FACTORY --rpc-url "$RPC")" = "$FACTORY_CODE" ] || { echo "CREATE2 factory code mismatch on $RPC" >&2; exit 1; }

ARGS=$(cast abi-encode "f((address,address,address,address,address,address,uint24,int24,int24,int24,uint256,uint256))" \
  "($POOL_MANAGER,$WHYPE,$USDC,$KNTQ,$OWNER,$KEEPER,$POOL_FEE,$TICK_SPACING,$MAIN_WIDTH,$ALT_WIDTH,$CAP_USDC,$CAP_KNTQ)")
INIT="$(forge inspect VaultLauncher bytecode)${ARGS:2}"
DATA="${SALT}${INIT:2}"

lower() { tr 'A-F' 'a-f'; }
HASH=$(cast keccak "0xff$(echo ${FACTORY:2} | lower)${SALT:2}$(cast keccak "$INIT" | cut -c3-)")
LAUNCHER=$(cast to-check-sum-address "0x${HASH:26}")
INBOX=$(cast compute-address "$LAUNCHER" --nonce 1 | awk '{print $NF}')
VAULT_USDC=$(cast compute-address "$LAUNCHER" --nonce 2 | awk '{print $NF}')
VAULT_KNTQ=$(cast compute-address "$LAUNCHER" --nonce 3 | awk '{print $NF}')

mkdir -p "$(dirname "$OUT")"
python3 - "$OUT" <<PY
import json, os, sys
old = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
new = {
  "chainId": 99901, "rpc": "$RPC", "explorer": "https://elyscan.live",
  "to": "$FACTORY", "data": "$DATA", "value": "0x0",
  "salt": "$SALT", "initCodeBytes": (len("$INIT") - 2) // 2,
  "launcher": "$LAUNCHER", "feeInbox": "$INBOX",
  "vaults": {"hype-usdc": "$VAULT_USDC", "hype-kntq": "$VAULT_KNTQ"},
  "owner": "$OWNER", "keeper": "$KEEPER",
  "config": {"poolManager": "$POOL_MANAGER", "whype": "$WHYPE", "usdc": "$USDC", "kntq": "$KNTQ",
             "poolFee": $POOL_FEE, "tickSpacing": $TICK_SPACING, "mainWidth": $MAIN_WIDTH, "altWidth": $ALT_WIDTH,
             "capUsdc": "$CAP_USDC", "capKntq": "$CAP_KNTQ"},
}
# keep the fork-measured gas figure while the transaction is unchanged
if old.get("data") == new["data"] and "gasEstimate" in old: new["gasEstimate"] = old["gasEstimate"]
json.dump(new, open(sys.argv[1], "w"), indent=2)
PY
echo "launcher   $LAUNCHER"
echo "fee inbox  $INBOX"
echo "HYPE-USDC  $VAULT_USDC"
echo "HYPE-KNTQ  $VAULT_KNTQ"
echo "init code  $(( (${#INIT} - 2) / 2 )) bytes (limit 49,152)"
echo "wrote $OUT"

if [ "${VERIFY:-0}" = "1" ]; then
  PORT=8599; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8   # any funded address will do; anvil's second test account
  KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  [ "$(cast code $VAULT_USDC --rpc-url $F)" = "0x" ] || { echo "already deployed" >&2; exit 1; }
  cast rpc evm_mine --rpc-url $F >/dev/null   # anvil needs one local block before it can price a transaction here
  GAS=$(cast estimate $FACTORY "$DATA" --from $SENDER --rpc-url $F)
  cast send $FACTORY "$DATA" --private-key $KEY --rpc-url $F --gas-limit $(( GAS * 12 / 10 )) >/dev/null
  check() { [ "$(echo "$2" | lower)" = "$(echo "$3" | lower)" ] && echo "  ok   $1" || { echo "  FAIL $1: got $2, want $3" >&2; exit 1; }; }
  check "launcher.hypeUsdc()"   "$(cast call $LAUNCHER 'hypeUsdc()(address)' --rpc-url $F)" "$VAULT_USDC"
  check "launcher.hypeKntq()"   "$(cast call $LAUNCHER 'hypeKntq()(address)' --rpc-url $F)" "$VAULT_KNTQ"
  check "launcher.feeInbox()"   "$(cast call $LAUNCHER 'feeInbox()(address)' --rpc-url $F)" "$INBOX"
  for V in $VAULT_USDC $VAULT_KNTQ; do
    check "$V owner"        "$(cast call $V 'owner()(address)' --rpc-url $F)" "$OWNER"
    check "$V keeper"       "$(cast call $V 'keeper()(address)' --rpc-url $F)" "$KEEPER"
    check "$V feeRecipient" "$(cast call $V 'feeRecipient()(address)' --rpc-url $F)" "$INBOX"
    check "$V token0"       "$(cast call $V 'token0()(address)' --rpc-url $F)" "$WHYPE"
  done
  check "HYPE-USDC token1" "$(cast call $VAULT_USDC 'token1()(address)' --rpc-url $F)" "$USDC"
  check "HYPE-KNTQ token1" "$(cast call $VAULT_KNTQ 'token1()(address)' --rpc-url $F)" "$KNTQ"
  check "inbox setter"     "$(cast call $INBOX 'setter()(address)' --rpc-url $F)" "$OWNER"
  python3 - "$OUT" "$GAS" <<PY
import json, sys
d = json.load(open(sys.argv[1])); d["gasEstimate"] = int(sys.argv[2]); json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  echo "gas $GAS  (about $(cast from-wei $(( GAS * $(cast gas-price --rpc-url "$RPC") ))) HYPE at the current gas price)"
  echo "verified on a fork of Elysium at block $(cast block-number --rpc-url $F)"
fi
