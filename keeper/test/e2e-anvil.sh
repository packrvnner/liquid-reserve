#!/usr/bin/env bash
# End-to-end: deploys Liquid Reserve on local anvil forks of Elysium and HyperEVM
# mainnet, then drives it with the real keeper. Nothing touches the real chains
# except read-only state fetching by anvil.
#
#   bash keeper/test/e2e-anvil.sh
#
# Uses anvil's built-in, publicly known test account (local forks only).
set -euo pipefail
export PATH="$HOME/.foundry/bin:$HOME/.nodejs/bin:$PATH"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil test account #0
ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
E=http://127.0.0.1:8545
H=http://127.0.0.1:8546

KNTQ_E=0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0
KNTQ_H=0x000000000000780555bD0BCA3791f89f9542c2d6
SKNTQ=0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F
POOL_MANAGER=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1 # holds KNTQ on Elysium
L1_GATEWAY=0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c   # holds KNTQ on HyperEVM
COIN=0x75E2fF9730AC84eb995D7733971821E9125c7f38         # Ascend coin standing in for \$liquid

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
gt0() { [ "$(python3 -c "print(int('$1'.split()[0]) > 0)")" = "True" ]; }

step "Starting anvil forks (Elysium :8545, HyperEVM :8546)"
anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8545 --silent &
EPID=$!
anvil --fork-url https://rpc.hyperliquid.xyz/evm --port 8546 --gas-limit 30000000 --silent &
HPID=$!
if [ "${KEEP_FORKS:-0}" = "1" ]; then
  trap 'rm -rf "$WORK"' EXIT # leave the forks running for the dashboard
else
  trap 'kill $EPID $HPID 2>/dev/null; rm -rf "$WORK"' EXIT
fi
for url in $E $H; do for _ in $(seq 60); do cast chain-id --rpc-url $url >/dev/null 2>&1 && break; sleep 1; done; done
echo "  Elysium chain $(cast chain-id --rpc-url $E), HyperEVM chain $(cast chain-id --rpc-url $H)"

addr_of() { # broadcast json, contract name -> address
  python3 -c "import json,sys; t=[x for x in json.load(open('$1'))['transactions'] if x.get('contractName')=='$2' and x.get('transactionType')=='CREATE']; print(t[0]['contractAddress'])"
}

step "Deploying the HyperEVM side"
cd "$ROOT"
H_START=$(cast block-number --rpc-url $H)
forge script script/Deploy.s.sol:DeployHyperEvm --rpc-url $H --broadcast --private-key $KEY --sender $ADDR --slow -q >/dev/null
HB=broadcast/Deploy.s.sol/999/run-latest.json
SAL=$(addr_of $HB StakeAndLock); HRES=$(addr_of $HB LockedReserve); YB=$(addr_of $HB YieldUnstakeBridge)
echo "  StakeAndLock $SAL, reserve $HRES, YieldUnstakeBridge $YB"

step "Deploying the Elysium side (FeeInbox + system; Ascend coin as \$liquid)"
E_START=$(cast block-number --rpc-url $E)
HYPEREVM_STAKE_AND_LOCK=$SAL forge script script/Deploy.s.sol:SimulateOnFork --rpc-url $E --broadcast --private-key $KEY --sender $ADDR --slow -q >/dev/null
EB=broadcast/Deploy.s.sol/99901/run-latest.json
ORACLE=$(addr_of $EB V4TwapOracle); INBOX=$(addr_of $EB FeeInbox); FEEROUTER=$(addr_of $EB FeeSplitter)
ALLOC=$(addr_of $EB InflowAllocator); PAYOUT=$(addr_of $EB CreatorPayout); YR=$(addr_of $EB YieldRouter)
ERES=$(addr_of $EB LockedReserve); BOUT=$(addr_of $EB BridgeOut); STAKING=$(addr_of $EB LiquidReserveStaking)
read VAULT_USDC VAULT_KNTQ < <(python3 -c "import json; t=[x['contractAddress'] for x in json.load(open('$EB'))['transactions'] if x.get('contractName')=='LiquidityVault' and x.get('transactionType')=='CREATE']; print(*t)")
echo "  vaults HYPE-USDC $VAULT_USDC, HYPE-KNTQ $VAULT_KNTQ"
echo "  oracle $ORACLE, reserve $ERES, bridgeOut $BOUT, yieldRouter $YR"
cast send $YB "setL2Recipient(address)" $YR --private-key $KEY --rpc-url $H >/dev/null

cat > "$WORK/keeper.config.json" <<JSON
{
  "elysium": {
    "rpc": "$E", "deployBlock": $E_START,
    "oracle": "$ORACLE", "feeInbox": "$INBOX", "feeRouter": "$FEEROUTER", "allocator": "$ALLOC",
    "creatorPayout": "$PAYOUT", "yieldRouter": "$YR", "reserve": "$ERES", "bridgeOut": "$BOUT", "staking": "$STAKING",
    "tokens": {
      "KNTQ": "$KNTQ_E", "kHYPE": "0x248888D396A546A69A188f3Deb476964e581E9d0",
      "WHYPE": "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", "USDC": "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
      "liquidreserve": "$COIN"
    }
  },
  "hyperevm": {
    "rpc": "$H", "deployBlock": $H_START,
    "stakeAndLock": "$SAL", "reserve": "$HRES", "yieldUnstakeBridge": "$YB",
    "inbox": "0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff", "minYieldToHarvest": "1"
  }
}
JSON
export KEEPER_CONFIG="$WORK/keeper.config.json" KEEPER_STATE="$WORK/keeper.state.json" KEEPER_PRIVATE_KEY=$KEY
keeper() { (cd "$ROOT/keeper" && npx tsx src/index.ts "$@" 2>&1 | sed 's/^/    /'); }
warp() { cast rpc evm_increaseTime "$2" --rpc-url "$1" >/dev/null; cast rpc evm_mine --rpc-url "$1" >/dev/null; }

step "Ascend creator fees arrive: 1,000 KNTQ into the FeeInbox"
cast rpc anvil_impersonateAccount $POOL_MANAGER --rpc-url $E >/dev/null
cast rpc anvil_setBalance $POOL_MANAGER 0xde0b6b3a7640000 --rpc-url $E >/dev/null
cast send $KNTQ_E "transfer(address,uint256)" $INBOX 1000000000000000000000 --from $POOL_MANAGER --unlocked --rpc-url $E >/dev/null

step "Keeper warms the oracle (31 pokes, one per minute)"
for i in $(seq 31); do warp $E 60; keeper --task pokeOracle | grep -v "INFO.*keeper 0x" | grep -E "WARN|ERROR|ALERT" || true; done
echo "  31 pokes done"

step "Keeper runs every task once"
keeper --once | grep -v "INFO.*keeper 0x"

step "Keeper keeps processing, 10 minutes apart"
for i in $(seq 6); do
  warp $E 600; keeper --task pokeOracle >/dev/null
  keeper --task processSwaps | grep -E "sent|WARN|ERROR" || true
done

step "Checking Elysium results"
KH_P=$(cast call $ERES "principal(address)(uint256)" 0x248888D396A546A69A188f3Deb476964e581E9d0 --rpc-url $E)
LR_P=$(cast call $ERES "principal(address)(uint256)" $COIN --rpc-url $E)
BO=$(cast call $KNTQ_E "balanceOf(address)(uint256)" $BOUT --rpc-url $E)
ALLOC_LEFT=$(cast call $KNTQ_E "balanceOf(address)(uint256)" $ALLOC --rpc-url $E)
PAYOUT_ADDR=$(cast call $PAYOUT "payoutAddress()(address)" --rpc-url $E)
USDC_OUT=$(cast call 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65 "balanceOf(address)(uint256)" $PAYOUT_ADDR --rpc-url $E)
echo "  reserve kHYPE principal: $KH_P"; echo "  reserve \$liquid principal:    $LR_P"
echo "  KNTQ in BridgeOut:       $BO"; echo "  KNTQ left in allocator:  $ALLOC_LEFT"; echo "  creator USDC:            $USDC_OUT"
gt0 "$KH_P" && pass "kHYPE locked in the Elysium reserve" || fail "no kHYPE principal"
gt0 "$LR_P" && pass "\$liquid locked in the Elysium reserve" || fail "no \$liquid principal"
gt0 "$BO" && pass "KNTQ bucket waiting in BridgeOut for HyperEVM" || fail "BridgeOut empty"
gt0 "$USDC_OUT" && pass "creator paid in USDC" || fail "creator not paid"

step "HyperEVM: KNTQ arrives from Elysium; keeper stakes and locks it"
cast rpc anvil_impersonateAccount $L1_GATEWAY --rpc-url $H >/dev/null
cast rpc anvil_setBalance $L1_GATEWAY 0xde0b6b3a7640000 --rpc-url $H >/dev/null
cast send $KNTQ_H "transfer(address,uint256)" $SAL 10000000000000000000000 --from $L1_GATEWAY --unlocked --rpc-url $H >/dev/null
keeper --task stake | grep -v "INFO.*keeper 0x"
HP=$(cast call $HRES "principal(address)(uint256)" $SKNTQ --rpc-url $H)
echo "  HyperEVM reserve principal (KNTQ): $HP"
gt0 "$HP" && pass "sKNTQ locked in the HyperEVM reserve" || fail "nothing staked"

step "Kinetiq rewards raise the sKNTQ rate; keeper harvests and starts unstaking"
cast send $KNTQ_H "transfer(address,uint256)" $SKNTQ 500000000000000000000000 --from $L1_GATEWAY --unlocked --rpc-url $H >/dev/null
warp $H 172800
keeper --task harvestHyperEvm | grep -v "INFO.*keeper 0x"
keeper --task unstakeAndBridge | grep -v "INFO.*keeper 0x"

step "7 days later: keeper confirms the unstake and bridges the KNTQ to Elysium"
ESCROW_BEFORE=$(cast call $KNTQ_H "balanceOf(address)(uint256)" $L1_GATEWAY --rpc-url $H)
warp $H 605000
keeper --task unstakeAndBridge | grep -v "INFO.*keeper 0x"
ESCROW_AFTER=$(cast call $KNTQ_H "balanceOf(address)(uint256)" $L1_GATEWAY --rpc-url $H)
BRIDGED=$(python3 -c "print(int('${ESCROW_AFTER%% *}') - int('${ESCROW_BEFORE%% *}'))")
echo "  KNTQ escrowed by the bridge for Elysium: $BRIDGED"
gt0 "$BRIDGED" && pass "yield bridged to the Elysium YieldRouter" || fail "nothing bridged"
python3 -c "import json; s=json.load(open('$WORK/keeper.state.json')); assert any(v=='PENDING' for v in s['tickets'].values()); print('  ticket recorded for watching:', list(s['tickets'])[0][:12]+'…')" && pass "keeper tracks the bridge ticket" || fail "ticket not tracked"

step "Ticket watch and status report run cleanly"
keeper --task watchTickets | grep -v "INFO.*keeper 0x" || true
(cd "$ROOT/keeper" && npx tsx src/status.ts 2>&1 | sed 's/^/    /')

if [ "${KEEP_FORKS:-0}" = "1" ]; then
  step "Writing site/deployment.local.json (forks stay up: anvil pids $EPID $HPID)"
  python3 - "$ROOT/site/deployment.json" "$ROOT/site/deployment.local.json" <<PY
import json, sys
d = json.load(open(sys.argv[1]))
d["label"] = "Local anvil forks"
d["elysium"].update(rpc="$E", deployBlock=$E_START)
d["elysium"]["contracts"].update(reserve="$ERES", feeInbox="$INBOX", feeRouter="$FEEROUTER", allocator="$ALLOC",
    creatorPayout="$PAYOUT", yieldRouter="$YR", bridgeOut="$BOUT", staking="$STAKING", oracle="$ORACLE")
d["hyperevm"].update(rpc="$H")
d["hyperevm"]["contracts"].update(reserve="$HRES", stakeAndLock="$SAL", yieldUnstakeBridge="$YB")
d["tokens"]["\$liquid"]["address"] = "$COIN"
d["pools"]["liquidReserveKntq"] = "0xb037fd6a45b19349809c1af2f869c2b302e9b4ce63e28d05f5887b85194a9cda"
d["pools"]["liquidReserveIsCurrency0"] = True
for v in d["vaults"]:
    if v["id"] == "hype-usdc": v["address"] = "$VAULT_USDC"
    if v["id"] == "hype-kntq": v["address"] = "$VAULT_KNTQ"
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
  echo "  open http://localhost:4173/?deployment=deployment.local.json&devwallet=1"
fi
printf '\n\033[32mEnd-to-end keeper test passed.\033[0m\n'
