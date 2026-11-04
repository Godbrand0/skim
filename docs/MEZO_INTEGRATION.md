# How Skim uses MUSD and Mezo on-chain

Skim's contracts act on Mezo's own contracts. Each item below is enforced by a contract, not by the relayer, and is tested against Mezo mainnet state (`test/fork/MezoPrimitivesFork.t.sol`).

| What | Mezo primitive it reads or calls | Where it is enforced |
|---|---|---|
| MUSD deposits stop when MUSD loses its peg | MUSD/mUSDC stable pool, MUSD/mUSDT stable pool, MUSD/BTC pool reserves, and the MUSD protocol `PriceFeed.fetchPrice()` (BTC/USD) | `MezoDeposit.deposit` reverts with `MusdDepegged` when `MusdPegGuard.isHealthy()` is false |
| Treasury MUSD becomes mUSDC | MUSD/mUSDC pool `swap` | `MezoRebalancer.rebalance(MusdToMusdc, ...)` |
| Treasury BTC becomes MUSD | BTC/MUSD pool `swap`, floored by `PriceFeed` | `rebalance(BtcToMusd, ...)` |
| Treasury mUSDT becomes MUSD | MUSD/mUSDT pool `swap` | `rebalance(MusdtToMusd, ...)` |
| Treasury mUSDC becomes MUSD, then BTC (for gas packs) | MUSD/mUSDC pool, then BTC/MUSD pool, floored by `PriceFeed` | `rebalance(MusdcToMusd, ...)` then `rebalance(MusdToBtc, ...)`. Keeper calls only; the relayer does not trigger these yet. `rebalanceMusdcToBtc(musdcIn, minBtcOut)` does both in one transaction |
| MUSD payouts are priced at what the pool pays | MUSD/mUSDC pool | Relayer: `min(0.99, pool price)`; payouts are held while the guard reports a depeg |

All three pools are therefore used: the two stable pools and the BTC pool are read by the guard on every MUSD deposit, and each is also a swap route. BTC to mUSDC is two calls (BTC to MUSD, then MUSD to mUSDC); the relayer runs the legs in that order.

## MusdPegGuard

Three independent readings of MUSD's price, in basis points of $1:

1. **mUSDC pool.** What 1 MUSD sells for in mUSDC. Unhealthy below `10000 - maxStableDeviationBps` (default 2%).
2. **mUSDT pool.** Same, in mUSDT, same threshold.
3. **Protocol cross-check.** The BTC/MUSD pool gives MUSD per BTC; the protocol's `PriceFeed` gives USD per BTC; dividing gives MUSD's implied USD value. Unhealthy below `10000 - maxBtcDeviationBps` (default 5%, looser because a volatile pool lags the oracle).

All must pass. Any failed read (oracle stale, pool call reverts, empty pool) counts as unhealthy. Spot prices can be pushed inside one transaction, but that can only trip the guard (pausing MUSD intake), not make a depegged MUSD look healthy.

Readings on Mezo mainnet when this was written: mUSDC pool 0.9904, mUSDT pool 0.9979, protocol cross-check 0.9985.

## MezoRebalancer

Not a custodian: it holds nothing. The treasury approves it for MUSD, mUSDT and BTC; `rebalance(route, amountIn, minOut)` (keeper role only) moves that token into the route's pool and the pool pays the output token straight back to the treasury. A compromised keeper can only: run these three swaps, for this one treasury, up to each route's cap, while MUSD is healthy, at a price no worse than the route's on-chain floor (par for the stable routes, `PriceFeed` for BTC) whatever `minOut` it passes. The goal is to reach the Native Bridge's 20 mUSDC minimum.

Fork-test results against the real pools: 10 MUSD gave 9.903101 mUSDC; 10 mUSDC gave 10.0909 MUSD; 10 mUSDT gave 10.016218 MUSD. MUSD to BTC: 38 MUSD buys 0.00048782 BTC against a PriceFeed value of 0.00049032 (0.5% under). For BTC, the pool pays 38.6587 MUSD for 0.0005 BTC against a PriceFeed fair value of 38.75 (0.24% under).

**Not verified on mainnet:** the transfer leg of both BTC routes (BTC to MUSD and MUSD to BTC). The BTC token (`0x7b7C…0000`) is backed by a Mezo precompile that forge cannot run, so only a mock token covers it in tests. Do a tiny BTC rebalance first (set `MAX_SWAP_BTC_WEI` low) and check the result before relying on it.

Not automated yet: the bridge-out itself (mUSDC to Ethereum, then CCTP to Base). That is still a manual step through `scripts/bridge-out-calldata.sh`.

## Going live (needs the admin and treasury keys)

```shell
export PATH="$HOME/.foundry/bin:$PATH"
# 1. deploy guard, new MezoDeposit, rebalancer (dry run first, then add --account <keystore> --broadcast)
ADMIN=0x.. GUARDIAN=0x.. TREASURY=0x.. KEEPER=0x.. forge script script/DeployMezoV2.s.sol --rpc-url $MEZO_RPC_URL
# 2. admin: enable MUSD + mUSDC on the new deposit contract and attach the guard
DEPOSIT=0x.. GUARD=0x.. REBALANCER=0x.. MEZO_RPC_URL=.. ACCOUNT=<admin keystore> ./scripts/wire-mezo-v2.sh send
# 3. treasury: approve the rebalancer for MUSD, mUSDT and BTC
DEPOSIT=0x.. GUARD=0x.. REBALANCER=0x.. MEZO_RPC_URL=.. TREASURY_ACCOUNT=<treasury keystore> ./scripts/wire-mezo-v2.sh approve
# 4. relayer env: DEPOSIT_ADDRESS, DEPOSIT_START_BLOCK (new contract), PEG_GUARD_ADDRESS, REBALANCER_ADDRESS; the relayer key needs KEEPER_ROLE
# 5. verify every contract on its explorer (see the header of scripts/verify-contracts.sh)
```

The new `MezoDeposit` has a new address, so the frontend and relayer must point at it. The old pilot contract keeps working for mUSDC but cannot take a peg guard. After step 2, do a real MUSD deposit (1 to 2 MUSD), then let the relayer run a real `rebalance`, and record both transaction hashes in `docs/PILOT_RESULT.md`.

## Submission checklist (Wave 2 feedback)

- [ ] Redeploy as above and run a real MUSD exit and a real rebalance on mainnet. Link the transactions.
- [ ] Verify all contracts: MezoFloat on Basescan, MezoDeposit / MusdPegGuard / MezoRebalancer on explorer.mezo.org.
- [ ] AKINDO name field: `Skim`.
- [ ] Deck.
- [ ] Video under 2:15.

## BTC and USDC in both directions

| Direction | How |
|---|---|
| BTC on Mezo to USDC on Base (cash out) | The exit lane already takes native BTC deposits (sats) and pays USDC on Base. Treasury side: `rebalanceBtcToMusdc` turns collected BTC into mUSDC in one call, ready for the Native Bridge |
| USDC on Base to BTC on Mezo (gas pack) | The `gas` lane: deposit USDC on a second Base `MezoDeposit`, receive native BTC from `MezoBtcFloat` on Mezo, priced from Mezo's oracle with a 0.5% spread and the usual 2% fee (min $0.05) |
| Refilling the BTC float | `rebalanceMusdcToBtc` turns treasury mUSDC (from reverse-lane deposits) into BTC; send it to the float |

Set up the gas lane: `script/DeployBtcFloat.s.sol` on Mezo, `script/DeployDepositBase.s.sol` again on Base (USDC only, `scripts/configure-deposit.sh` with `TOKENS=usdc`), send BTC to the float, then set `GAS_DEPOSIT_ADDRESS`, `GAS_DEPOSIT_START_BLOCK`, `GAS_FLOAT_ADDRESS` in the relayer `.env` (see `.env.example`). The relayer key needs `RELAYER_ROLE` on the BTC float. `GET /api/quote?lane=gas&asset=usdc&amount=5` returns `payoutSats`.

Not done: the website has no gas-pack option yet, and the lane has not been run end to end (no local test, no mainnet run). It is covered by contract tests and pricing unit tests only.
