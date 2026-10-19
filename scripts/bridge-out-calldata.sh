#!/usr/bin/env bash
# Prints the call for Mezo's bridge-out of mUSDC to Ethereum (chain 0). Does NOT send anything.
# Usage: ./scripts/bridge-out-calldata.sh <amount_in_mUSDC e.g. 250.5> <ethereum_recipient_0x...>
# The minimum on-chain is 20 mUSDC (verified via getMinBridgeOutAmount). Test with exactly 20 first.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
AMOUNT=${1:?amount in mUSDC}; RECIPIENT=${2:?ethereum recipient}
MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
BRIDGE=0x7b7c000000000000000000000000000000000012     # AssetsBridge precompile
RAW=$(cast to-unit "${AMOUNT}e6" 0 2>/dev/null || python3 -c "from decimal import Decimal; print(int(Decimal('$AMOUNT')*10**6))")
[ "$RAW" -ge 20000000 ] || { echo "below the 20 mUSDC minimum"; exit 1; }
cast to-check-sum-address "$RECIPIENT" >/dev/null
echo "to:        $BRIDGE   (AssetsBridge precompile)"
echo "function:  bridgeOut(address,uint256,uint8,bytes)  args: $MUSDC $RAW 0 $RECIPIENT"
echo "calldata:  $(cast calldata 'bridgeOut(address,uint256,uint8,bytes)' $MUSDC "$RAW" 0 "$RECIPIENT")"
echo "approval:  you may first need: mUSDC.approve($BRIDGE, $RAW)  [VERIFY on a 20 mUSDC test]"
