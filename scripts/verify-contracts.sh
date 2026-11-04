#!/usr/bin/env bash
# Verifies the deployed contracts on their explorers. Mezo uses Blockscout (no key needed); Base uses Basescan (ETHERSCAN_API_KEY).
#   ./scripts/verify-contracts.sh mezo-deposit <addr> <admin> <delay> <guardian> <treasury>
#   ./scripts/verify-contracts.sh float        <addr> <usdc> <admin> <delay> <relayer> <guardian> <maxPerTx> <maxPerAddr> <maxGlobal>
#   ./scripts/verify-contracts.sh guard        <addr> <owner> <stableDev> <btcDev>
#   ./scripts/verify-contracts.sh refiller     <addr> <admin> <delay> <keeper> <treasury>
#   ./scripts/verify-contracts.sh rebalancer   <addr> <admin> <delay> <keeper> <treasury> <guard> "[maxMusd,maxBtcWei,maxMusdt,maxMusdc,maxMusdForBtc]" "[5 slippage bps, same order]"
# Constructor args must match the deployment exactly (read them from the deploy tx input if unsure).
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186; MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
STABLE=0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356; BTCPOOL=0x52e604c44417233b6CcEDDDc0d640A405Caacefb
MUSDT=0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E; USDTPOOL=0x10906a9E9215939561597b4C8e4b98F93c02031A
BTC=0x7b7C000000000000000000000000000000000000; FEED=0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88
mezo() { forge verify-contract "$1" "$2" --chain 31612 --verifier blockscout --verifier-url https://api.explorer.mezo.org/api/ --constructor-args "$3" --watch; }
what=${1:?}; addr=${2:?}; shift 2
case $what in
  mezo-deposit) mezo "$addr" src/MezoDeposit.sol:MezoDeposit "$(cast abi-encode 'c(address,uint48,address,address)' "$@")";;
  guard)        mezo "$addr" src/MusdPegGuard.sol:MusdPegGuard "$(cast abi-encode 'c(address,address[4],address[3],address,uint256,uint256)' "$1" "[$MUSD,$MUSDC,$MUSDT,$BTC]" "[$STABLE,$USDTPOOL,$BTCPOOL]" $FEED "$2" "$3")";;
  refiller)     mezo "$addr" src/MezoFloatRefiller.sol:MezoFloatRefiller "$(cast abi-encode 'c(address,uint48,address,address)' "$@")";;
  rebalancer)   mezo "$addr" src/MezoRebalancer.sol:MezoRebalancer "$(cast abi-encode 'c(address,uint48,address,address,address,address[4],address[3],uint256[5],uint256[5])' "$1" "$2" "$3" "$4" "$5" "[$MUSD,$MUSDC,$MUSDT,$BTC]" "[$STABLE,$USDTPOOL,$BTCPOOL]" "$6" "$7")";;
  float)        : "${ETHERSCAN_API_KEY:?Basescan key needed}"
                forge verify-contract "$addr" src/MezoFloat.sol:MezoFloat --chain 8453 --etherscan-api-key "$ETHERSCAN_API_KEY" \
                  --constructor-args "$(cast abi-encode 'c(address,address,uint48,address,address,uint256,uint256,uint256)' "$@")" --watch;;
  *) echo "unknown target"; exit 1;;
esac
