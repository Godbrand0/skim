#!/usr/bin/env bash
# End-to-end test on local chains: a Base mainnet fork (real USDC) plus a local chain posing as Mezo.
# Proves, in both directions:
#   exit lane:  deposit mUSDC/MUSD/BTC on "Mezo" -> relayer ingests -> USDC released from the float on "Base"
#   enter lane: deposit USDC on "Base"            -> relayer ingests -> mUSDC released from the float on "Mezo"
# Usage: BASE_RPC_URL=https://mainnet.base.org ./scripts/e2e-local.sh
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

: "${BASE_RPC_URL:=https://mainnet.base.org}"
LOG=${E2E_LOG_DIR:-/tmp/mezo-float-e2e}; mkdir -p "$LOG"; rm -f "$LOG"/*.log "$LOG"/*.sqlite*
MEZO=http://127.0.0.1:8546; BASE=http://127.0.0.1:8547
# Well-known public anvil test keys. Never use these for anything real.
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # admin / deployer
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # relayer
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6   # user
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; A3=0x90F79bf6EB2c4f870365E785982E1f101E93b906
RECIPIENT=0xc0ffee0000000000000000000000000000000001
PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

anvil --chain-id 31612 --port 8546 --silent & PIDS+=($!)
anvil --fork-url "$BASE_RPC_URL" --port 8547 --silent & PIDS+=($!)
for i in $(seq 1 40); do cast chain-id --rpc-url $MEZO >/dev/null 2>&1 && cast chain-id --rpc-url $BASE >/dev/null 2>&1 && break; sleep 0.5; done
[ "$(cast chain-id --rpc-url $BASE)" = 8453 ] || { echo "Base fork is not chain 8453"; exit 1; }

# Anvil's public test accounts are swept on the real chain, and bots leave EIP-7702 delegations on them. Those
# carry over into a fork, and the relayer rightly refuses a delegated key. Reset them on this local fork only.
for a in $A0 $A1 $A2 $A3 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; do
  if [ "$(cast code $a --rpc-url $BASE)" != "0x" ]; then echo "   (resetting a delegation that the real chain has on test account $a)"; cast rpc anvil_setCode $a 0x --rpc-url $BASE >/dev/null; fi
done

echo "== deploy mocks on local Mezo at the real token and oracle addresses"
forge build -q
deploy_to(){ local rpc=$1; shift; local out; out=$(forge create --rpc-url "$rpc" --private-key $K0 --broadcast "$@" 2>&1) || { echo "$out" >&2; return 1; }; echo "$out" | awk '/Deployed to:/{print $3}'; }
deploy(){ deploy_to $MEZO "$@"; }
T18=$(deploy test/mocks/E2EMocks.sol:E2EToken --constructor-args 18)
T6=$(deploy test/mocks/E2EMocks.sol:E2EToken --constructor-args 6)
OR=$(deploy test/mocks/E2EMocks.sol:E2EOracle)
setcode(){ cast rpc anvil_setCode "$2" "$(cast code "$1" --rpc-url $MEZO)" --rpc-url $MEZO >/dev/null; }
MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186; MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
setcode $T18 $MUSD; setcode $T6 $MUSDC; setcode $OR 0x7b7c000000000000000000000000000000000015
cast send $MUSDC "mint(address,uint256)" $A3 100000000 --rpc-url $MEZO --private-key $K0 >/dev/null
cast send $MUSD  "mint(address,uint256)" $A3 100000000000000000000 --rpc-url $MEZO --private-key $K0 >/dev/null

echo "== deploy MezoDeposit on local Mezo"
DEP=$(deploy src/MezoDeposit.sol:MezoDeposit --constructor-args $A0 172800 $A2 $A0)   # treasury = admin acct for the test
cast send $DEP "setTokenConfig(address,bool,uint256,uint256)" $MUSDC true 1000000 25000000 --rpc-url $MEZO --private-key $K0 >/dev/null
cast send $DEP "setTokenConfig(address,bool,uint256,uint256)" $MUSD  true 1000000000000000000 25000000000000000000 --rpc-url $MEZO --private-key $K0 >/dev/null
cast send $DEP "setTokenConfig(address,bool,uint256,uint256)" 0x0000000000000000000000000000000000000000 true 10000000000000 300000000000000 --rpc-url $MEZO --private-key $K0 >/dev/null

echo "== deploy MezoFloat on the Base fork and fund it with real USDC"
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
FLOAT=$(deploy_to $BASE src/MezoFloat.sol:MezoFloat --constructor-args $USDC $A0 172800 $A1 $A2 25000000 50000000 300000000)
SLOT=$(cast index address "$FLOAT" 9)   # Circle FiatToken: balanceAndBlacklistStates at slot 9
cast rpc anvil_setStorageAt $USDC "$SLOT" "$(cast to-uint256 300000000)" --rpc-url $BASE >/dev/null
echo "float balance: $(cast call $FLOAT 'floatBalance()(uint256)' --rpc-url $BASE)  (expected 300000000)"
[ "$(cast call $FLOAT 'floatBalance()(uint256)' --rpc-url $BASE | awk '{print $1}')" = 300000000 ] || { echo "USDC funding failed"; exit 1; }

echo "== deploy the reverse lane: MezoDeposit on the Base fork (USDC in) and MezoFloat on local Mezo (mUSDC out)"
BTREASURY=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65   # anvil account #4 stands in for the Base treasury
EDEP_START=$(cast block-number --rpc-url $BASE)
EDEP=$(deploy_to $BASE src/MezoDeposit.sol:MezoDeposit --constructor-args $A0 172800 $A2 $BTREASURY)
cast send $EDEP "setTokenConfig(address,bool,uint256,uint256)" $USDC true 500000 2000000 --rpc-url $BASE --private-key $K0 >/dev/null
EFLOAT=$(deploy src/MezoFloat.sol:MezoFloat --constructor-args $MUSDC $A0 172800 $A1 $A2 25000000 50000000 300000000)
cast send $MUSDC "mint(address,uint256)" $EFLOAT 100000000 --rpc-url $MEZO --private-key $K0 >/dev/null   # a 100 mUSDC float on Mezo
cast rpc anvil_setStorageAt $USDC "$(cast index address "$A3" 9)" "$(cast to-uint256 10000000)" --rpc-url $BASE >/dev/null   # the user holds 10 USDC on Base
echo "reverse float (mUSDC on Mezo): $(cast call $EFLOAT 'floatBalance()(uint256)' --rpc-url $MEZO | awk '{print $1}')   user USDC on Base: $(cast call $USDC 'balanceOf(address)(uint256)' $A3 --rpc-url $BASE | awk '{print $1}')"

echo "== start relayer (both lanes)"
export MEZO_RPC_URL=$MEZO BASE_RPC_URL=$BASE FLOAT_ADDRESS=$FLOAT DEPOSIT_ADDRESS=$DEP DEPOSIT_START_BLOCK=0 \
  CONFIRMATIONS=1 POLL_MS=1000 DB_PATH=$LOG/relayer.sqlite PORT=8799 ENABLE_PAYOUTS=true RELAYER_PRIVATE_KEY=$K1 TREASURY_ADDRESS=$A0 \
  ENTER_DEPOSIT_ADDRESS=$EDEP ENTER_DEPOSIT_START_BLOCK=$EDEP_START ENTER_FLOAT_ADDRESS=$EFLOAT ENTER_CONFIRMATIONS=1 BASE_TREASURY_ADDRESS=$BTREASURY
start_relayer(){ (cd relayer && exec node src/index.ts >>"$LOG/relayer.log" 2>&1) & RPID=$!; PIDS+=($RPID); }
start_relayer
sleep 3

raw_balance(){ cast call $USDC "balanceOf(address)(uint256)" $RECIPIENT --rpc-url $BASE | awk '{print $1}'; }
BASE0=$(raw_balance)
recipient_balance(){ echo $(( $(raw_balance) - BASE0 )); }
wait_for(){ local want=$1; for i in $(seq 1 40); do cast rpc anvil_mine 2 --rpc-url $MEZO >/dev/null; [ "$(recipient_balance)" = "$want" ] && return 0; sleep 1; done; echo "TIMEOUT waiting for balance $want, got $(recipient_balance)"; tail -20 "$LOG/relayer.log"; exit 1; }

echo "== 1) deposit 10 mUSDC"
cast send $MUSDC "approve(address,uint256)" $DEP 10000000 --rpc-url $MEZO --private-key $K3 >/dev/null
OUT=$(cast send $DEP "deposit(address,uint256,address)" $MUSDC 10000000 $RECIPIENT --rpc-url $MEZO --private-key $K3 --json 2>&1) || { echo "deposit failed: $OUT"; exit 1; }
TX=$(echo "$OUT" | jq -r '.transactionHash // empty'); [ -n "$TX" ] || { echo "no tx hash in: $OUT" | head -c 800; exit 1; }
wait_for 9800000
echo "   OK: recipient got 9.80 USDC (10.00 minus 2% fee)"
echo "   API status: $(curl -s localhost:8799/api/deposit/$TX | jq -c '.deposits[0] | {status,payoutUsdc,feeUsdc}')"

echo "== 2) deposit 5 MUSD (valued at 0.99, 2% fee => 4.8510)"
cast send $MUSD "approve(address,uint256)" $DEP 5000000000000000000 --rpc-url $MEZO --private-key $K3 >/dev/null
cast send $DEP "deposit(address,uint256,address)" $MUSD 5000000000000000000 $RECIPIENT --rpc-url $MEZO --private-key $K3 >/dev/null
wait_for 14651000
echo "   OK: cumulative 14.651000 USDC"

echo "== 3) deposit native BTC: 10000 sats = 0.0001 BTC at \$83,000 less 0.5% spread = 8.2585, 2% fee => 8.093330"
cast send $DEP "depositNative(address)" $RECIPIENT --value 100000000000000 --rpc-url $MEZO --private-key $K3 >/dev/null
wait_for 22744330
echo "   OK: cumulative 22.744330 USDC"

echo "== 3b) REVERSE LANE: deposit 1 USDC on Base, receive mUSDC on Mezo (fee floor 0.05 => 0.95)"
ERECIP=0xc0ffee0000000000000000000000000000000002
eraw(){ cast call $MUSDC "balanceOf(address)(uint256)" $ERECIP --rpc-url $MEZO | awk '{print $1}'; }
EM0=$(eraw); ET0=$(cast call $USDC "balanceOf(address)(uint256)" $BTREASURY --rpc-url $BASE | awk '{print $1}')
cast send $USDC "approve(address,uint256)" $EDEP 1000000 --rpc-url $BASE --private-key $K3 >/dev/null
EOUT=$(cast send $EDEP "deposit(address,uint256,address)" $USDC 1000000 $ERECIP --rpc-url $BASE --private-key $K3 --json 2>&1) || { echo "enter deposit failed: $EOUT"; exit 1; }
ETX=$(echo "$EOUT" | jq -r '.transactionHash // empty'); [ -n "$ETX" ] || { echo "no tx hash in: $EOUT" | head -c 800; exit 1; }
for i in $(seq 1 40); do cast rpc anvil_mine 2 --rpc-url $BASE >/dev/null; [ $(( $(eraw) - EM0 )) = 950000 ] && break; sleep 1; done
[ $(( $(eraw) - EM0 )) = 950000 ] || { echo "TIMEOUT: reverse payout is $(( $(eraw) - EM0 )) not 950000"; tail -20 "$LOG/relayer.log"; exit 1; }
echo "   OK: recipient got 0.95 mUSDC on Mezo"
[ $(( $(cast call $USDC "balanceOf(address)(uint256)" $BTREASURY --rpc-url $BASE | awk '{print $1}') - ET0 )) = 1000000 ] || { echo "Base treasury did not receive the 1 USDC"; exit 1; }
[ "$(cast call $USDC "balanceOf(address)(uint256)" $EDEP --rpc-url $BASE | awk '{print $1}')" = 0 ] || { echo "the Base deposit contract is holding funds"; exit 1; }
echo "   OK: the 1 USDC went to the Base treasury and the deposit contract holds 0"
echo "   API status: $(curl -s localhost:8799/api/deposit/$ETX | jq -c '.deposits[0] | {lane,status,payoutUsdc,payoutToken,feeUsdc}')"
if cast send $EDEP "deposit(address,uint256,address)" $USDC 400000 $ERECIP --rpc-url $BASE --private-key $K3 >/dev/null 2>&1; then echo "FAIL: below-minimum USDC deposit accepted"; exit 1; else echo "   OK: a 0.4 USDC deposit is rejected on-chain"; fi
[ "$(cast call $EFLOAT 'refUsed(bytes32)(bool)' $(cast keccak $(cast abi-encode 'f(uint256,address,uint256)' 8453 $EDEP 0)) --rpc-url $MEZO)" = true ] || { echo "reference not marked used"; exit 1; }
echo "   OK: the payout reference is marked used on the Mezo float"

echo "== 4) restart relayer: no double payout in either direction"
kill $RPID; sleep 1; start_relayer; sleep 6; cast rpc anvil_mine 3 --rpc-url $MEZO >/dev/null; sleep 4
[ "$(recipient_balance)" = 22744330 ] || { echo "DOUBLE PAYOUT DETECTED: $(recipient_balance)"; exit 1; }
[ $(( $(eraw) - EM0 )) = 950000 ] || { echo "REVERSE DOUBLE PAYOUT DETECTED: $(( $(eraw) - EM0 ))"; exit 1; }
echo "   OK: both balances unchanged after restart"

echo "== 4b) FREE-HOST SCENARIO: the database is wiped and the relayer restarts (look-back on, proxy trusted)"
kill $RPID; sleep 1; rm -f "$LOG"/relayer.sqlite*
export LOOKBACK_HOURS=100000 TRUST_PROXY=true
start_relayer; sleep 6
for i in 1 2 3; do cast rpc anvil_mine 2 --rpc-url $MEZO >/dev/null; cast rpc anvil_mine 2 --rpc-url $BASE >/dev/null; sleep 2; done; sleep 4
[ "$(recipient_balance)" = 22744330 ] || { echo "DOUBLE PAYOUT after a database wipe (exit lane): $(recipient_balance)"; exit 1; }
[ $(( $(eraw) - EM0 )) = 950000 ] || { echo "DOUBLE PAYOUT after a database wipe (enter lane): $(( $(eraw) - EM0 ))"; exit 1; }
COUNTS=$(curl -s localhost:8799/api/health | jq -c .counts)
[ "$COUNTS" = '{"paid":4}' ] || { echo "expected all 4 old deposits re-read and marked paid, got $COUNTS"; tail -15 "$LOG/relayer.log"; exit 1; }
echo "   OK: the wiped database was rebuilt from the chain (4 deposits re-read, all marked paid) and nothing was paid twice"
[ "$(curl -s localhost:8799/healthz)" = "ok" ] || { echo "/healthz is not ok"; exit 1; }
echo "   OK: /healthz answers without touching the chains"

echo "== 4c) rate limit counts the real client behind a proxy"
URL="localhost:8799/api/deposit/0x$(printf '%064x' 1)"
SAME=0; for i in $(seq 1 100); do [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 203.0.113.9' $URL)" = 429 ] && SAME=$((SAME+1)); done
VARIED=0; for i in $(seq 1 100); do [ "$(curl -s -o /dev/null -w '%{http_code}' -H "CF-Connecting-IP: 198.51.100.$i" $URL)" = 429 ] && VARIED=$((VARIED+1)); done
[ "$SAME" -ge 5 ] || { echo "one noisy client was not limited (got $SAME limited)"; exit 1; }
[ "$VARIED" = 0 ] || { echo "different clients wrongly shared one limit ($VARIED limited)"; exit 1; }
echo "   OK: one client hammering got limited ($SAME of 100), 100 different clients were not"

echo "== 5) below-minimum deposit is rejected on-chain"
if cast send $DEP "deposit(address,uint256,address)" $MUSDC 500000 $RECIPIENT --rpc-url $MEZO --private-key $K3 >/dev/null 2>&1; then echo "FAIL: dust deposit accepted"; exit 1; else echo "   OK: reverted"; fi

echo "== 6) API"
curl -s "localhost:8799/api/quote?asset=musdc&amount=2" | jq -c '{payoutUsdc,feeUsdc,canFulfill}'
curl -s "localhost:8799/api/health" | jq -c '{floatUsdc,counts}'
CFG=$(curl -s -D "$LOG/hdr.txt" localhost:8799/api/config)
[ "$(echo "$CFG" | jq '.assets | map(select(.enabled)) | length')" = 3 ] || { echo "config: expected 3 enabled assets: $CFG"; exit 1; }
grep -qi "access-control-allow-origin: http://localhost:5173" "$LOG/hdr.txt" || { echo "CORS header missing"; exit 1; }
echo "$CFG" | jq -c '{assets: [.assets[] | {key,min,max}], fee, floatAvailableUsdc}'
[ "$(curl -s -o /dev/null -w '%{http_code}' 'localhost:8799/api/quote?asset=musdc&amount=0.5')" = 200 ] && curl -s 'localhost:8799/api/quote?asset=musdc&amount=0.5' | jq -e '.canFulfill == false' >/dev/null || { echo "dust quote should be unfulfillable"; exit 1; }
curl -s 'localhost:8799/api/quote?asset=musdc&amount=abc' | jq -e '.error == "invalid amount"' >/dev/null || { echo "bad amount not rejected"; exit 1; }
curl -s localhost:8799/api/deposit/0x123 | jq -e '.error' >/dev/null || { echo "bad tx hash not rejected"; exit 1; }
[ "$(echo "$CFG" | jq '.enter.asset.enabled')" = true ] || { echo "config: enter lane missing: $CFG"; exit 1; }
echo "$CFG" | jq -c '{enter: {contracts: .enter.contracts, asset: {key: .enter.asset.key, min: .enter.asset.min, max: .enter.asset.max}, payoutToken: .enter.payoutToken, floatAvailable: .enter.floatAvailable}}'
curl -s "localhost:8799/api/quote?lane=enter&asset=usdc&amount=1" | jq -e '.payoutUsdc == "0.950000" and .payoutToken == "mUSDC" and .canFulfill == true' >/dev/null || { echo "enter quote wrong"; exit 1; }
curl -s "localhost:8799/api/quote?lane=enter&asset=musdc&amount=1" | jq -e '.error == "unknown asset"' >/dev/null || { echo "enter lane accepted an exit-lane asset"; exit 1; }
curl -s "localhost:8799/api/quote?lane=nope&asset=usdc&amount=1" | jq -e '.error == "unknown lane"' >/dev/null || { echo "unknown lane not rejected"; exit 1; }
curl -s localhost:8799/api/health | jq -e '.lanes.exit and .lanes.enter and .relayerGas.mezoBtc' >/dev/null || { echo "health missing lanes"; exit 1; }
echo "   OK: config, CORS, lane quotes and input validation"

echo "== 7) monitor"
(cd relayer && node src/monitor.ts)

echo; echo "ALL E2E CHECKS PASSED"
