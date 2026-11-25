#!/bin/bash
# Builds the one transaction that deploys VaultZapV2 on Elysium mainnet through the
# standard CREATE2 factory, so its address is known beforehand. Writes it to
# site/tools/zap2-data.json. Sends nothing.
#
# VaultZapV2 is the zap for a vault that is the only liquidity in its own pool (the
# wANTx-USDC vault). The first zap stays in use for the other vaults.
#
#   bash script/zap2-data.sh            build the data
#   VERIFY=1 bash script/zap2-data.sh   also replay it on a fresh local fork (port 8599) and make real
#                                       one-token deposits through it into the live vaults there
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${ELYSIUM_RPC:-https://rpc.elysium.kinetiq.xyz}"
FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
POOL_MANAGER=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
SALT=$(cast keccak "liquidreserve.xyz vault zap v2")
OUT=site/tools/zap2-data.json
forge build -q
ARGS=$(cast abi-encode "f(address)" $POOL_MANAGER)
INIT="$(forge inspect VaultZapV2 bytecode)${ARGS:2}"
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
echo "zap v2     $ZAP"
echo "wrote $OUT"
if [ "${VERIFY:-0}" = "1" ]; then
  PORT=8599; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  SENDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  USDC=0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65; WANTX=0xd7d0288Cef796cCc5752B4352f80b74aD2929334; WANTX_L1=0xabec6AeAb037b77c09a2a99264F9C81a35B02649
  GATEWAY=0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f; ALIAS=0xEa8c30de0Ba0C2eAeE942afcE77530e06c5F233d
  HYPE_USDC=0x05D6A15d864A633DF9efC082aCFf7a2AB1e44911; ANTX_VAULT=0xD14C956837b124483707170fa2775160B66FDA2E; OLD_ZAP=0x4161ec401b91653495CfE888714C51fE01988678
  num() { awk '{print $1}'; }
  ok() { echo "  ok   $1"; }
  bad() { echo "  FAIL $1" >&2; exit 1; }
  [ "$(cast code $ZAP --rpc-url $F)" = "0x" ] || { echo "already deployed" >&2; exit 1; }
  cast rpc evm_mine --rpc-url $F >/dev/null
  cast rpc anvil_setCode $SENDER 0x --rpc-url $F >/dev/null
  cast rpc anvil_setBalance $SENDER 0x56BC75E2D63100000 --rpc-url $F >/dev/null
  GAS=$(cast estimate $FACTORY "$DATA" --from $SENDER --rpc-url $F)
  cast send $FACTORY "$DATA" --private-key $KEY --rpc-url $F --gas-limit $(( GAS * 12 / 10 )) >/dev/null
  [ "$(cast call $ZAP 'poolManager()(address)' --rpc-url $F | lower)" = "$(echo $POOL_MANAGER | lower)" ] && ok "zap.poolManager()" || bad "poolManager"
  ZAPSIG="zapIn(address,bool,uint256,uint256,address)"

  # 1. a vault among other liquidity, paid in native HYPE: the live HYPE-USDC vault
  B=$(cast call $HYPE_USDC 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num)
  cast send $ZAP "$ZAPSIG" $HYPE_USDC true 100000000000000000 0 $SENDER --value 0.1ether --private-key $KEY --rpc-url $F >/dev/null
  A=$(cast call $HYPE_USDC 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num)
  [ "$A" != "$B" ] && ok "0.1 HYPE into the live HYPE-USDC vault: $A shares" || bad "HYPE-USDC zap"

  # 2. the vault that is alone in its pool: the live wANTx-USDC vault, whatever state it is in on this fork
  cast rpc anvil_autoImpersonateAccount true --rpc-url $F >/dev/null
  for a in $POOL_MANAGER $ALIAS; do cast rpc anvil_setBalance $a 0x56BC75E2D63100000 --rpc-url $F >/dev/null; done
  INFO=$(cast abi-encode "f(bytes,bytes,bytes)" $(cast abi-encode "f(string)" "Wrapped Anthropic xStock") $(cast abi-encode "f(string)" wANTx) $(cast abi-encode "f(uint8)" 18))
  cast send $GATEWAY "finalizeInboundTransfer(address,address,address,uint256,bytes)" $WANTX_L1 $SENDER $SENDER 50000000000000000000 $(cast abi-encode "f(bytes,bytes)" $INFO 0x) --from $ALIAS --unlocked --rpc-url $F >/dev/null
  cast send $USDC "transfer(address,uint256)" $SENDER 5000000000 --from $POOL_MANAGER --unlocked --rpc-url $F >/dev/null
  for t in $USDC $WANTX; do for s in $ZAP $OLD_ZAP; do cast send $t "approve(address,uint256)" $s $(cast max-uint) --private-key $KEY --rpc-url $F >/dev/null; done; done
  shares() { cast call $ANTX_VAULT 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num; }
  tick() { cast call $ANTX_VAULT 'price()(uint160,int24)' --rpc-url $F | tail -1 | num; }
  holds() { cast call $ANTX_VAULT 'balances()(uint256,uint256)' --rpc-url $F | num | tr '\n' ' '; }
  SUPPLY=$(cast call $ANTX_VAULT 'totalSupply()(uint256)' --rpc-url $F | num)
  if [ "$SUPPLY" = "0" ]; then
    T=$(tick)
    cast send $ZAP "$ZAPSIG" $ANTX_VAULT true 300000000 0 $SENDER --private-key $KEY --rpc-url $F >/dev/null
    read -r H0 H1 <<<"$(holds)"
    [ "$(shares)" != "0" ] && [ "$H1" = "0" ] && [ "$(tick)" = "$T" ] && ok "300 USDC into the empty wANTx-USDC vault: no swap, price untouched, vault holds $H0 USDC units" || bad "empty-vault zap"
    # the first zap cannot take wANTx now (the vault holds none): it must fail, and the new one must work
    if cast send $OLD_ZAP "$ZAPSIG" $ANTX_VAULT false 200000000000000000 0 $SENDER --private-key $KEY --rpc-url $F >/dev/null 2>&1; then bad "the first zap was expected to fail here"; else ok "the first zap refuses 0.2 wANTx into a vault that holds only USDC"; fi
  fi
  S0=$(shares); W0=$(cast call $WANTX 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num); U0=$(cast call $USDC 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num)
  cast send $ZAP "$ZAPSIG" $ANTX_VAULT false 200000000000000000 0 $SENDER --private-key $KEY --rpc-url $F >/dev/null
  S1=$(shares); W1=$(cast call $WANTX 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num); U1=$(cast call $USDC 'balanceOf(address)(uint256)' $SENDER --rpc-url $F | num)
  python3 - "$S0" "$S1" "$W0" "$W1" "$U0" "$U1" <<'PY' && ok "0.2 wANTx into the wANTx-USDC vault through the new zap" || bad "wANTx zap"
import sys
s0, s1, w0, w1, u0, u1 = map(int, sys.argv[1:])
paid, change = (w0 - w1) / 1e18, (u1 - u0) / 1e6
print(f"       shares +{(s1 - s0) / 1e18:.6f}; paid {paid:.6f} wANTx (the rest came back); change {change:.6f} USDC")
sys.exit(0 if s1 > s0 and paid > 0.19 and change < 0.2 else 1)
PY
  S0=$(shares)
  cast send $ZAP "$ZAPSIG" $ANTX_VAULT true 20000000 0 $SENDER --private-key $KEY --rpc-url $F >/dev/null
  [ "$(shares)" != "$S0" ] && ok "20 USDC into it as well" || bad "USDC zap"
  if cast send $ZAP "$ZAPSIG" $ANTX_VAULT false 30000000000000000000 0 $SENDER --private-key $KEY --rpc-url $F >/dev/null 2>&1; then bad "a zap far too large for the pool went through"; else ok "30 wANTx at once is refused (too much for the pool)"; fi
  for t in $USDC $WANTX; do [ "$(cast call $t 'balanceOf(address)(uint256)' $ZAP --rpc-url $F | num)" = "0" ] || bad "the zap kept tokens"; done
  ok "the zap holds nothing afterwards"
  python3 - "$OUT" "$GAS" <<PY
import json, sys
d = json.load(open(sys.argv[1])); d["gasEstimate"] = int(sys.argv[2]); json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  echo "gas $GAS  (about $(cast from-wei $(( GAS * $(cast gas-price --rpc-url "$RPC") ))) HYPE)"
fi
