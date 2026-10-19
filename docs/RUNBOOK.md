# Operations runbook

Run `cd relayer && npm run monitor` at least daily. It reports the Base float, daily payout use, the queue, and the Mezo treasury value, and tells you when to run a batch.

## 1. When to run a rebalancing batch
- Treasury value at or above the batch threshold (default $300), or
- Base float below the low-float level (default $90, 30% of a $300 target).

Batch size guidance (from on-chain checks): the Mezo MUSD/mUSDC stable pool held only about $6.7k of mUSDC when checked, so keep a batch to $1,000 or less and split bigger ones. The bridge fee is about $3 per batch, so batches under $200 are inefficient.

## 2. Batch procedure (semi-manual)
Mezo's native bridge cannot send to Base. Its bridge-out chains are Ethereum (0) and Bitcoin (1) only, so the path is mUSDC to USDC on Ethereum, then Circle CCTP to Base.

1. **On Mezo, with the treasury wallet:** swap BTC to MUSD (pool `0x52e604c44417233b6CcEDDDc0d640A405Caacefb`) and MUSD to mUSDC (stable pool `0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356`) in the Mezo app's Swap. Keep a little BTC for gas. Check the quoted slippage before confirming.
2. **Bridge out:** withdraw mUSDC to an Ethereum wallet you control (the Mezo app's Withdraw button, destination Ethereum). The minimum is 20 mUSDC and the fee about $3, taken in the token. Time: 30 to 60 minutes.
   - To do it by contract call instead: `./scripts/bridge-out-calldata.sh <amount> <ethereum_address>` prints the call for the AssetsBridge precompile `0x7b7c000000000000000000000000000000000012`. You may need an approval first. Verify with a 20 mUSDC test before the first real batch.
3. **Ethereum to Base:** use Circle's official CCTP bridge (Circle's bridge UI or Bridge Kit) to burn USDC on Ethereum and mint on Base. Set the Base recipient to the **MezoFloat contract address** (a plain USDC transfer is all it needs) or to the admin wallet and top up in a second step. Double-check the address.
4. **Confirm:** `cast call $FLOAT "floatBalance()(uint256)" --rpc-url $BASE_RPC_URL` should have risen by about the batch amount minus fees.
5. **Record the batch** in your ledger: date, amounts swapped, bridge fee, gas, amount received on Base. The difference between USDC paid out to users since the last batch and USDC received is your running cost.

## 3. If the Mezo bridge is paused or delayed
A bridge-out vulnerability was fixed in an earlier Mezo upgrade and bridge-out was paused during the fix, so this can happen. The float keeps paying. Watch the float level. If it falls below about $50, have the guardian pause the float (section 5) rather than let it empty, and resume once refilled.

## 4. Queue states (relayer database)
| Status | Meaning | Action |
|---|---|---|
| `new` / `waiting` | Seen but not paid yet (float low, paused, daily limit, price unavailable) | Usually resolves by itself. Check the `note`. |
| `sending` | A release is in flight | Wait. On restart the relayer reconciles it. |
| `paid` | USDC released on Base | None |
| `manual_review` | Too small after fees, over the per-payout limit, unknown token or invalid recipient. The funds are already with the treasury. | Refund or pay manually, then record it. |

Inspect: `sqlite3 relayer/relayer.sqlite "select nonce,asset,amount,status,note from deposits where status in ('waiting','manual_review')"`.

## 5. Emergency actions
Use `--account <keystore>` (never a raw private key on the command line).

| Situation | Command |
|---|---|
| Stop payouts | `cast send $FLOAT "pause()" --rpc-url $BASE_RPC_URL --account guardian` |
| Stop new deposits | `cast send $DEPOSIT "pause()" --rpc-url $MEZO_RPC_URL --account guardian` |
| Resume (admin only) | `cast send $FLOAT "unpause()" ...` / `cast send $DEPOSIT "unpause()" ...` |
| Pull the float out | `cast send $FLOAT "withdraw(address,uint256)" $TO $AMOUNT_MICRO --account admin` (works while paused) |
| Relayer key compromised | pause the float, then `cast send $FLOAT "revokeRole(bytes32,address)" $(cast keccak RELAYER_ROLE) $OLD_RELAYER --account admin`, then grant a new key |
| Lower exposure | `cast send $FLOAT "setLimits(uint256,uint256,uint256)" <perTx> <perAddress> <perDay> --account admin` (all in USDC micro, ordered perTx <= perAddress <= perDay) |

## 5b. Things to watch
- Relayer ETH balance on Base (each payout costs a fraction of a cent).
- `lastIngestAt` in `/api/health` should keep moving. If it stalls, the Mezo RPC or the process is down.
- Deposits stuck in `waiting` for more than an hour.
- MUSD price. The relayer values MUSD at `MUSD_VALUE_BPS` (default 0.99). If MUSD drifts further below, raise the haircut or disable MUSD with `setTokenConfig(MUSD, false, ...)` on the deposit contract.
