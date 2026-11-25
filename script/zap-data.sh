#!/bin/bash
# Builds the one transaction that deploys VaultZap on Elysium mainnet through the
# standard CREATE2 factory, so its address is known beforehand. Writes it to
# site/tools/zap-data.json. Sends nothing. VERIFY=1 also replays it on a fork.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
POOL_MANAGER=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
SALT=$(cast keccak "liquidreserve.xyz vault zap v1")
OUT=site/tools/zap-data.json
forge build -q
ARGS=$(cast abi-encode "f(address)" $POOL_MANAGER)
INIT="$(forge inspect VaultZap bytecode)${ARGS:2}"
DATA="${SALT}${INIT:2}"
lower() { tr 'A-F' 'a-f'; }
HASH=$(cast keccak "0xff$(echo ${FACTORY:2} | lower)${SALT:2}$(cast keccak "$INIT" | cut -c3-)")
ZAP=$(cast to-check-sum-address "0x${HASH:26}")
python3 - "$OUT" <<PY
import json, os, sys
old = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
new = {"chainId": 99901, "rpc": "$RPC", "explorer": "https://elyscan.live", "to": "$FACTORY", "data": "$DATA", "value": "0x0",
       "salt": "$SALT", "zap": "$ZAP", "poolManager": "$POOL_MANAGER"}
if old.get("data") == new["data"] and "gasEstimate" in old: new["gasEstimate"] = old["gasEstimate"]
json.dump(new, open(sys.argv[1], "w"), indent=2)
PY
echo "zap        $ZAP"
echo "wrote $OUT"
if [ "${VERIFY:-0}" = "1" ]; then
  PORT=8599; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  [ "$(cast code $ZAP --rpc-url $F)" = "0x" ] || { echo "already deployed" >&2; exit 1; }
  cast rpc evm_mine --rpc-url $F >/dev/null
  GAS=$(cast estimate $FACTORY "$DATA" --from $SENDER --rpc-url $F)
  cast send $FACTORY "$DATA" --private-key $KEY --rpc-url $F --gas-limit $(( GAS * 12 / 10 )) >/dev/null
  [ "$(cast call $ZAP 'poolManager()(address)' --rpc-url $F | lower)" = "$(echo $POOL_MANAGER | lower)" ] && echo "  ok   zap.poolManager()" || { echo "  FAIL" >&2; exit 1; }
  # a real one-token deposit through it, into the live HYPE-KNTQ vault
  cast send $ZAP "zapIn(address,bool,uint256,uint256,address)" 0xE78475C23691e7Fa65131C176C0D3bD5a146aDCf true 100000000000000000 0 $SENDER --value 0.1ether --private-key $KEY --rpc-url $F >/dev/null
  SH=$(cast call 0xE78475C23691e7Fa65131C176C0D3bD5a146aDCf 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | awk '{print $1}')
  [ "$SH" != "0" ] && echo "  ok   zapped 0.1 HYPE into HYPE-KNTQ: $SH shares" || { echo "  FAIL zap" >&2; exit 1; }
  python3 - "$OUT" "$GAS" <<PY
import json, sys
d = json.load(open(sys.argv[1])); d["gasEstimate"] = int(sys.argv[2]); json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  echo "gas $GAS  (about $(cast from-wei $(( GAS * $(cast gas-price --rpc-url "$RPC") ))) HYPE)"
fi
