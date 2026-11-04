#!/usr/bin/env bash
# After script/DeployMezoV2.s.sol: prints (or sends) the calls that switch the MUSD integration on.
#   DEPOSIT=0x.. GUARD=0x.. REBALANCER=0x.. ./scripts/wire-mezo-v2.sh calldata
#   ... MEZO_RPC_URL=.. ACCOUNT=<admin keystore> ./scripts/wire-mezo-v2.sh send        (admin EOA only)
# Then the TREASURY must approve the rebalancer once:  scripts/wire-mezo-v2.sh approve  (TREASURY_ACCOUNT=<treasury keystore>)
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
: "${DEPOSIT:?}"; : "${GUARD:?}"; : "${REBALANCER:?}"
MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
mode=${1:-calldata}
TOKENS=${TOKENS:-musd,musdc} DEPOSIT=$DEPOSIT MEZO_RPC_URL=${MEZO_RPC_URL:-} ACCOUNT=${ACCOUNT:-} "$(dirname "$0")/configure-deposit.sh" "$mode"
if [ "$mode" = "send" ]; then
  cast send "$DEPOSIT" "setPegGuard(address)" "$GUARD" --rpc-url "$MEZO_RPC_URL" --account "$ACCOUNT"
elif [ "$mode" = "approve" ]; then
  : "${MEZO_RPC_URL:?}"; : "${TREASURY_ACCOUNT:?}"
  MUSDT=0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E; BTC=0x7b7C000000000000000000000000000000000000
  for t in "$MUSD:${APPROVE_MUSD:-1000000000000000000000}" "$MUSDT:${APPROVE_MUSDT:-1000000000}" "$BTC:${APPROVE_BTC_WEI:-10000000000000000}"; do
    cast send "${t%%:*}" "approve(address,uint256)" "$REBALANCER" "${t##*:}" --rpc-url "$MEZO_RPC_URL" --account "$TREASURY_ACCOUNT"
  done
else
  echo "to: $DEPOSIT  setPegGuard($GUARD)  calldata: $(cast calldata 'setPegGuard(address)' "$GUARD")"
  echo "treasury approvals: from the TREASURY account, approve $REBALANCER for MUSD, mUSDT and BTC (run '$0 approve')"
fi
