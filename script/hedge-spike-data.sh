#!/bin/bash
# Builds what site/tools/hedge-spike.html needs to create and drive CoreSpike on HyperEVM mainnet: the
# small contract that finds out, with a few dollars of the owner's own money, how HyperCore treats a
# contract's account. Writes site/tools/hedge-spike-data.json. Sends nothing.
#
#   bash script/hedge-spike-data.sh             build the data
#   REHEARSE=1 bash script/hedge-spike-data.sh  also start a local copy of HyperEVM (port 8598) with a
#                                               stand-in for HyperCore, and write hedge-spike-data.local.json
#                                               for trying the page with the test wallet:
#                                               http://localhost:4174/tools/hedge-spike.html?data=hedge-spike-data.local.json&devwallet=1
#                                               (it keeps running until this script is stopped)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${HYPEREVM_RPC:-https://rpc.hyperliquid.xyz/evm}"
USDC=0xb88339CB7199b77E23DB6E890353E22632Ba630f
CORE_DEPOSIT=0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24
PERP=159; SZ_DECIMALS=2
OUT=site/tools/hedge-spike-data.json
forge build -q --skip script
CODE=$(forge inspect src/hedged/CoreSpike.sol:CoreSpike bytecode)
write() { # file rpc coreDeposit gas
python3 - "$1" "$2" "$3" "$4" <<PY
import json, subprocess, sys
sig = lambda s: subprocess.run(["cast", "sig", s], capture_output=True, text=True).stdout.strip()
args = subprocess.run(["cast", "abi-encode", "f(address,address,uint32,uint8)", "$USDC", sys.argv[3], "$PERP", "$SZ_DECIMALS"], capture_output=True, text=True).stdout.strip()
json.dump({
    "chainId": 999, "rpc": sys.argv[2], "explorer": "https://hyperevmscan.io", "initcode": "$CODE" + args[2:], "gasCreate": int(sys.argv[4]),
    "usdc": "$USDC", "coreDeposit": sys.argv[3], "perp": $PERP, "szDecimals": $SZ_DECIMALS,
    "sel": {k: sig(v) for k, v in {
        "fund": "fund(uint256,bool)", "fundHype": "fundHype()", "order": "order(bool,uint256,uint256,bool)", "perpToSpot": "perpToSpot(uint256)",
        "spotToEvm": "spotToEvm(uint256)", "sweep": "sweep(address)", "read": "read()", "owner": "owner()",
        "approve": "approve(address,uint256)", "allowance": "allowance(address,address)", "balanceOf": "balanceOf(address)"}.items()},
}, open(sys.argv[1], "w"), indent=2)
PY
}
ARGS=$(cast abi-encode "f(address,address,uint32,uint8)" $USDC $CORE_DEPOSIT $PERP $SZ_DECIMALS)
GAS=$(cast estimate --from 0x9324605c9C707b2F805CCF2AC099fCA5d561DC37 --rpc-url "$RPC" --create "${CODE}${ARGS:2}")
[ "$GAS" -le 1950000 ] || { echo "creating CoreSpike needs $GAS gas: over the wallet's limit" >&2; exit 1; }
write "$OUT" "$RPC" "$CORE_DEPOSIT" "$GAS"
echo "wrote $OUT (creation: $GAS gas)"

if [ "${REHEARSE:-0}" = "1" ]; then
  PORT=8598; F=http://127.0.0.1:$PORT
  anvil --fork-url "$RPC" --port $PORT --silent & PID=$!
  trap 'kill $PID 2>/dev/null' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url $F >/dev/null 2>&1 && break; sleep 0.5; done
  # anvil's first test account is the page's test wallet; its second one runs the stand-in
  ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  OP=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  for a in $ME $OP; do cast rpc anvil_setCode $a 0x --rpc-url $F >/dev/null; cast rpc anvil_setBalance $a 0x56BC75E2D63100000 --rpc-url $F >/dev/null; done
  create() { local c=$1; shift; forge create "$c" --private-key $KEY --rpc-url $F --broadcast --constructor-args "$@" 2>/dev/null | awk '/Deployed to:/ {print $3}'; }
  PX=$(cast call 0x0000000000000000000000000000000000000807 $(cast abi-encode "f(uint32)" $PERP) --rpc-url "$RPC" | cast to-dec)
  SIM=$(create test/hedged/CoreSim.sol:CoreSim $USDC $PERP $SZ_DECIMALS $PX)
  WALLET=$(create test/hedged/CoreSim.sol:CoreDepositWalletMock $SIM $USDC)
  PRE=$(create test/hedged/CoreSim.sol:CorePrecompile $SIM)
  WRITER=$(create test/hedged/CoreSim.sol:CoreWriterMock $SIM)
  [ -n "$SIM" ] && [ -n "$WALLET" ] && [ -n "$PRE" ] && [ -n "$WRITER" ] || { echo "could not create the stand-in on the local copy" >&2; exit 1; }
  for a in 0800 0801 0806 0807 080F; do cast rpc anvil_setCode 0x000000000000000000000000000000000000$a $(cast code $PRE --rpc-url $F) --rpc-url $F >/dev/null; done
  cast rpc anvil_setCode 0x3333333333333333333333333333333333333333 $(cast code $WRITER --rpc-url $F) --rpc-url $F >/dev/null
  cast send $SIM "wire(address,address)" 0x3333333333333333333333333333333333333333 $WALLET --private-key $KEY --rpc-url $F >/dev/null
  # test USDC for the wallet and for the stand-in, taken from the bridge's escrow on this copy
  GATEWAY=0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c
  cast rpc anvil_impersonateAccount $GATEWAY --rpc-url $F >/dev/null; cast rpc anvil_setBalance $GATEWAY 0x56BC75E2D63100000 --rpc-url $F >/dev/null
  cast send $USDC "transfer(address,uint256)" $ME 200000000 --from $GATEWAY --unlocked --rpc-url $F >/dev/null
  cast send $USDC "transfer(address,uint256)" $SIM 100000000000 --from $GATEWAY --unlocked --rpc-url $F >/dev/null
  write site/tools/hedge-spike-data.local.json "$F" "$WALLET" "$GAS"
  echo "local copy on $F: stand-in for HyperCore at $SIM (oracle price $PX), test wallet $ME holds 200 USDC"
  echo "open http://localhost:4174/tools/hedge-spike.html?data=hedge-spike-data.local.json&devwallet=1"
  # the stand-in's blocks: once a second it carries out what was sent, as HyperCore would
  while kill -0 $PID 2>/dev/null; do cast send $SIM "step()" --private-key $KEY --rpc-url $F >/dev/null 2>&1 || true; sleep 1; done
fi
