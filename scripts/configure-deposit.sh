#!/usr/bin/env bash
# Enables MUSD, mUSDC and native BTC on a deployed MezoDeposit (Mezo mainnet).
# Usage:
#   DEPOSIT=0x... ./script/configure-deposit.sh calldata     # print calldata for a multisig to execute
#   DEPOSIT=0x... MEZO_RPC_URL=... ACCOUNT=<keystore> ./script/configure-deposit.sh send   # admin EOA only
# Limits are per deposit, in each token's own units. Override with env if needed.
# TOKENS selects which tokens to enable (comma list of musd, musdc, btc). Default: all three.
#   e.g. pilot: TOKENS=musdc MUSDC_MIN=500000 MUSDC_MAX=2000000
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

: "${DEPOSIT:?set DEPOSIT to the MezoDeposit address}"
MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
NATIVE=0x0000000000000000000000000000000000000000
SIG="setTokenConfig(address,bool,uint256,uint256)"

MUSD_MIN=${MUSD_MIN:-1000000000000000000};   MUSD_MAX=${MUSD_MAX:-25000000000000000000}
MUSDC_MIN=${MUSDC_MIN:-1000000};              MUSDC_MAX=${MUSDC_MAX:-25000000}
BTC_MIN=${BTC_MIN_WEI:-10000000000000};       BTC_MAX=${BTC_MAX_WEI:-300000000000000}

TOKENS=${TOKENS:-musd,musdc,btc}
mode=${1:-calldata}
cfgs=()
[[ ",$TOKENS," == *",musd,"* ]]  && cfgs+=("$MUSD $MUSD_MIN $MUSD_MAX")
[[ ",$TOKENS," == *",musdc,"* ]] && cfgs+=("$MUSDC $MUSDC_MIN $MUSDC_MAX")
[[ ",$TOKENS," == *",btc,"* ]]   && cfgs+=("$NATIVE $BTC_MIN $BTC_MAX")
[ "${#cfgs[@]}" -gt 0 ] || { echo "TOKENS matched nothing (use musd, musdc, btc)"; exit 1; }
for cfg in "${cfgs[@]}"; do
  set -- $cfg
  if [ "$mode" = "send" ]; then
    : "${MEZO_RPC_URL:?}"; : "${ACCOUNT:?}"
    cast send "$DEPOSIT" "$SIG" "$1" true "$2" "$3" --rpc-url "$MEZO_RPC_URL" --account "$ACCOUNT"
  else
    echo "to: $DEPOSIT  token: $1"
    cast calldata "$SIG" "$1" true "$2" "$3"
  fi
done
