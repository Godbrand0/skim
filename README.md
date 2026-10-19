# Skim

> Working name until the rename is finished: the app, docs and contract names still say "Mezo Float".

A small-amount exit bridge for the Mezo ecosystem. It lets users withdraw sub-minimum amounts (about $1 to $19) of MUSD, mUSDC, or sats from Mezo as USDC on Base, instantly, by paying out of a pre-funded USDC float and refilling that float later in batches.

Status: **built and tested locally, not deployed.** Both contracts, the relayer service, the frontend and the deploy scripts exist and pass their tests. Nothing has been broadcast to mainnet and the contracts have not been audited. Items marked **[VERIFY]** are unconfirmed.

| Part | Where | State |
|---|---|---|
| Base float contract | `src/MezoFloat.sol` | 17 tests pass |
| Mezo deposit contract | `src/MezoDeposit.sol` | 16 tests pass |
| Fork tests on real Base USDC | `test/fork/` | 3 pass |
| Relayer, API and monitor | `relayer/` | 10 unit tests pass, typechecks |
| Frontend | `frontend/` | bridge-style UI (From/To token dropdowns, route details, balances). Typechecks, builds, and was driven in headless Chrome with a mock wallet against real chain reads. Real wallet transactions not yet tested |
| Local end-to-end test | `scripts/e2e-local.sh` | passes (all 3 assets, restart safety, dust rejection) |
| Deploy scripts | `script/Deploy*.s.sol` | dry-run against live Base and Mezo succeeds |
| Ops docs | `docs/PILOT.md` ($1 mainnet pilot), `docs/PILOT_RESULT.md` (pilot passed 19 Oct 2026), `docs/DEPLOY.md`, `docs/RUNBOOK.md` | written |
| Mainnet pilot | contracts live on Base and Mezo with a $1 float | **passed**: 0.8 mUSDC in, 0.75 USDC out; see `docs/PILOT_RESULT.md` |
| Public docs page | `frontend/docs.html` (served at `/docs.html`) | user guide, fees, trust model, contracts, API reference, operations, FAQ; live limits and addresses come from the relayer API |

---

## 1. Problem

Mezo's native exit has a high minimum and a fixed fee, which shuts out small balances.

| Fact | Value | Source |
|---|---|---|
| Minimum withdrawal, USD tokens via Native Bridge (mUSDC, mUSDT, mDAI, mUSDe) | 20 tokens | Mezo docs, Mainnet Bridges |
| Native Bridge service fee to Ethereum | about $3 flat plus gas | Mezo docs |
| Native Bridge time to Ethereum | 30 to 60 minutes | Mezo docs |
| Minimum BTC withdrawal to Ethereum | 0.0002 BTC | Mezo docs |
| Minimum BTC withdrawal to Bitcoin L1 | 0.01 BTC | Mezo docs |
| Gas on Mezo | paid in BTC (18 decimals), chain ID 31612 | Mezo docs |

A user with $2 of MUSD or a few thousand sats cannot exit at all, and a $3 fixed fee would be 150% of a $2 withdrawal anyway. Some users also hold no BTC for gas, so they cannot transact at all.

Reference: https://mezo.org/docs/users/mainnet/bridges/

## 2. Solution

Run a liquidity float on Base and settle with Mezo later.

1. A contract on Base holds a USDC float (start with about $300).
2. A user requests a withdrawal of MUSD, mUSDC, or sats. The amount is converted to USD at a locked quote.
3. The float pays USDC on Base immediately, minus a fee.
4. The Mezo-side treasury collects the user's asset. When the accumulated amount is large enough (target $200 to $500), the treasury converts it to mUSDC, withdraws it through Mezo's Native Bridge, and refills the Base float.

Each user pays a small percentage fee. The batch absorbs the fixed $3 and the 20-token minimum. The loop repeats.

## 3. Route

```
USER (small amount)
   |  request, quote locked
   v
Base Float contract (USDC)  --->  USDC to user wallet (instant)

Later, batched:
Mezo treasury
   BTC  --(BTC/MUSD pool)-->  MUSD  --(MUSD/mUSDC pool)-->  mUSDC
   mUSDC --(Mezo Native Bridge, min 20, about $3)--> USDC
   USDC on Ethereum --(Circle CCTP)--> USDC on Base --> Base Float (refill)
```

Wormhole is explicitly out of scope. The only exit is the Native Bridge.

**Verified on-chain:** the Native Bridge's bridge-out chains are `[0, 1]`, which is Ethereum and Bitcoin. **Base is not supported**, so the refill path goes through Ethereum and then CCTP. The on-chain minimum for mUSDC is 20 USDC (20,000,000 raw), the outflow limit is 1,000,000 USDC, and Mezo has a native BTC/USD oracle at `0x7b7c000000000000000000000000000000000015` (18 decimals), which the relayer uses for sats. The AssetsBridge precompile is at `0x7b7c000000000000000000000000000000000012` with `bridgeOut(address token, uint256 amount, uint8 chain, bytes recipient)`. Gas on Mezo is tiny (about 0.0000002 BTC, roughly $0.00002, per deposit), so the "no gas" problem only affects wallets with zero BTC.

### Known Mezo addresses (from Mezo docs, not yet checked on the explorer) **[VERIFY]**

| Item | Address |
|---|---|
| MUSD | `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` |
| mUSDC | `0x04671C72Aab5AC02A03c1098314b1BB6B560c197` |
| MUSD/mUSDC pool | `0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356` |
| MUSD/BTC pool | `0x52e604c44417233b6CcEDDDc0d640A405Caacefb` |
| PoolFactory | `0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248` |
| BTC (tBTC) | `0x7b7C000000000000000000000000000000000000` |

Reference: https://mezo.org/docs/users/resources/contracts-reference/

## 4. Architecture

### 4.1 Base Float contract
- Holds USDC.
- `release(recipient, amount, ref)`, callable only by the relayer role.
- `ref` is single-use (replay protection).
- Limits: per-transaction cap, per-address daily cap, global daily cap.
- Pause switch.
- Owner is a multisig. The relayer key can release only and cannot withdraw.
- Owner can top up and withdraw the float.
- Use audited libraries (OpenZeppelin AccessControl, SafeERC20). Build with Foundry.

### 4.2 Quote and payout service (off-chain)
- Accepts withdrawal requests, locks a USD quote for a few minutes, applies fee and spread, and calls `release`.
- Tracks every request in a ledger so the treasury knows what it is owed.
- Rate limits per address and enforces the minimum.

### 4.3 Mezo treasury
- A multisig on Mezo holding BTC (for gas and as received sats) and MUSD or mUSDC.
- Receives user assets (see section 4.5 for how).
- **[VERIFY]** whether Safe or another multisig exists on Mezo.

### 4.4 Rebalancer (batch job)
- Checks the float level and the treasury balance.
- Triggers when the treasury holds at least $200 to $300, or when the float falls below its low threshold.
- Steps: swap BTC to MUSD, swap MUSD to mUSDC, withdraw at least 20 mUSDC through the Native Bridge, then refill the float.
- Must keep working when bridge-out is paused: the float keeps paying, and the rebalancer retries.

### 4.5 How the treasury receives the user's asset
Two modes:
- **Direct deposit (public bridge):** a Mezo contract receives MUSD, mUSDC, or BTC and emits `Deposit(id, sender, token, amount, destChain, recipient)`. The relayer waits for finality, then calls `release` on Base.
- **Integrator mode:** an application that already custodies balances for its users calls the payout service directly and settles with the treasury on its own schedule.

Build direct deposit first for the public bridge. Integrator mode is an option for later partners.

### 4.6 Sats withdrawals
- Users withdraw earned sats as USDC on Base.
- The minimum is set in USD (start at about $1) and displayed in sats from a live price.
- Price source **[VERIFY]**: the BTC/MUSD pool price, Mezo's own oracle, or an external feed (Chainlink or Pyth). Take a spread (for example 0.5%) to cover BTC movement.
- The treasury converts received BTC within a day or less to limit BTC price exposure.
- Lightning is not part of version 1. Mezo shows no live Lightning withdrawal path, and the swap providers I found are unsettled (Boltz suspended swaps on August 3, 2026, and Blockstream Swaps is invite-only beta).

## 5. Fees

Formula (initial proposal, to be set from test results):

```
fee = max(floor, 1.5% to 2.0% of amount)
```

- The percentage covers the rebalance cost and a margin.
- The floor stops tiny withdrawals from costing more to process than they pay.
- Raise the fee as the Base float drops below 30%. Discount the direction that refills it.
- Minimum withdrawal: $1.

## 6. Business model and financials

### 6.1 Revenue and cost per dollar moved
- Revenue: fee on each withdrawal (1.5% to 2% to start).
- Rebalance cost per dollar of batch (the Native Bridge is a fixed $3 per batch):

| Batch size | Bridge fee as % of batch |
|---|---|
| $100 | 3.00% |
| $200 | 1.50% |
| $300 | 1.00% |
| $500 | 0.60% |
| $1,000 | 0.30% |

- Add costs that are still unknown **[VERIFY]**: Mezo swap fees and slippage (BTC to MUSD to mUSDC), Ethereum gas plus CCTP if Base isn't supported directly, Base gas for payouts (expected to be a fraction of a cent), BTC price risk on sats, and MUSD peg drift.

### 6.2 Illustrative margin (assumptions, not measurements)
Assume a $300 batch (1.0% bridge), 0.4% for swaps and gas, and a 2.0% fee. Gross margin is 2.0% minus 1.4% = 0.6%.

| Monthly volume | Gross margin at 0.6% |
|---|---|
| $5,000 | $30 |
| $20,000 | $120 |
| $100,000 | $600 |

At this scale the project is a small utility, not a profit centre, and it will not cover audits or development time on fees alone. Revenue grows mainly by increasing batch sizes (a lower per-dollar cost) and by volume.

### 6.3 Capital
- Float: start at $300. Rule of thumb: at least twice expected daily payouts, and never below one batch.
- Gas reserve on Mezo: a small amount of BTC.
- Rule of thumb for the ceiling: with a Native Bridge delay of 30 to 60 minutes plus the batching interval, a $300 float supports roughly $300 to $500 per day of payouts.

### 6.4 Costs to plan for
- Hosting for the relayer, the rebalancer and a monitoring dashboard.
- A security review of the float contract before the float exceeds a few hundred dollars. Cost is unknown **[VERIFY]**.
- Legal review of the custody and money-transmission exposure in the operator's jurisdiction. This matters because the service holds user value in transit.

### 6.5 Strategic value
The most realistic upside is ecosystem value rather than fee income. Mezo's developer relations contact said this kind of liquidity movement "makes a lot of sense for Mezo" and that making Mezo cheaper for small users is worthwhile. That suggests exploring ecosystem funding or an official integration. Confirm whether any Mezo grant or builder program applies **[VERIFY]**.

## 7. Risks

| Risk | Mitigation |
|---|---|
| One-way flow drains the float | Dynamic fee, per-transaction cap, pause route below a floor |
| Native Bridge paused or delayed (a bridge-out vulnerability was fixed in the v8.0.0 upgrade, and bridge-out was paused for the fix) | Float keeps paying, rebalancer retries, alerts |
| Base not supported as a destination for mUSDC | Ethereum plus CCTP fallback (more cost, so larger batches) |
| Bridge-out cannot be called programmatically (RFC-5 only proposes `bridgeOut` on the AssetsBridge precompile; no shipped ABI found) | First version uses semi-manual withdrawals through the Mezo app |
| BTC price moves between payout and conversion | Quote expiry, spread, convert within a day or less |
| MUSD peg below $1 | Hold little MUSD, rebalance often, price into the fee |
| Relayer key compromise | Release-only role, daily caps, pause, multisig owner |
| Replay or double release | Single-use `ref`, wait for finality before release |
| Abuse and dust spam | $1 minimum, per-address limits |
| Regulatory exposure | Legal review before launch |
| Mezo ships its own small-amount bridge | Treat as a possible integration partner rather than a competitor |

## 8. Open questions and their status

| # | Question | Status |
|---|---|---|
| 1 | Does the Native Bridge withdraw mUSDC to Base? | **No.** On-chain bridge-out chains are Ethereum and Bitcoin only. Use Ethereum then CCTP. |
| 2 | Is the withdrawal minimum 20 or 10? | **20** on-chain (`getMinBridgeOutAmount`). Governance can change it, so re-check before each batch. |
| 3 | Can a treasury automate `bridgeOut`? | Interface confirmed in the mezod source (`scripts/bridge-out-calldata.sh`). Whether an approval is needed and exactly how a contract call behaves is **[VERIFY]** with a 20 mUSDC test. The first version is semi-manual. |
| 4 | Swap cost and depth for BTC to MUSD to mUSDC | Pools exist. The MUSD/mUSDC stable pool held only about $6.7k of mUSDC when checked, so batches should stay at or below $1,000. Slippage is **[VERIFY]** per batch in the app. |
| 5 | BTC price source | **Mezo's native oracle** at `0x7b7c...0015` (Chainlink-style interface). |
| 6 | Multisig on Mezo | **Yes.** Safe is available on Mezo at safe.mezo.org. Create one for this project and confirm it before deploying. |
| 7 | Addresses and bytecode | MUSD, mUSDC, mUSDT, tBTC and both pools were read on-chain and match the docs. Base USDC `0x8335...2913` and Chainlink BTC/USD on Base were also checked. |
| 8 | Chain parameters | Mezo mainnet chain ID 31612 confirmed on three public RPCs. Explorer is Blockscout at https://explorer.mezo.org. |
| 9 | Legal position for operating the service | **[VERIFY]**, open. |
| 10 | Mezo finality for the `CONFIRMATIONS` setting | **[VERIFY]**. Default is 5 blocks, conservative. |

## 9. Validation test (do this first)

Spend about $25 of real funds by hand:
1. Swap about $22 of MUSD to mUSDC in the Mezo app.
2. Withdraw 20 or more mUSDC and record the destination networks offered, the fee, the time taken, and the amount received.
3. If Base is not offered, withdraw to Ethereum and test the CCTP leg to Base.

The results set the batch size, fee model and fallback route.

## 10. Implementation plan

1. Run the validation test (section 9) and close the section 8 questions.
2. Write the Base Float contract (Foundry), with tests for replay, caps, pause and role separation. Deploy to Base Sepolia.
3. Build the quote and payout service and the ledger.
4. Build the rebalancer, starting semi-manual if `bridgeOut` can't be automated.
5. Build the Mezo-side deposit contract and event relayer (public bridge, phase 2).
6. Security review and legal check.
7. Launch on mainnet with a $50 to $100 float, then raise to $300 as the numbers hold.
8. Add sats withdrawal once a price source is chosen.
9. Later options: more destination chains, Lightning for sats, and an integration with Mezo's own tooling if it appears.

## 11. Development

```
src/          MezoFloat.sol (Base), MezoDeposit.sol (Mezo)
test/         Foundry unit tests; test/fork/ runs against real Base USDC; test/mocks/ is local-e2e only
script/       Foundry deploy scripts (mainnet-guarded by chain ID)
scripts/      e2e-local.sh, configure-deposit.sh, bridge-out-calldata.sh
relayer/      TypeScript service (Node 24, viem): watcher, payer, API, monitor
frontend/     Vite + TypeScript + viem app: the bridge (index.html) and the docs page (docs.html)
docs/         DEPLOY.md (go-live steps), RUNBOOK.md (operations)
```

Clone with submodules (`git clone --recurse-submodules <repo>`; forge-std is a pinned submodule and OpenZeppelin 5.7.0 is vendored in `lib/`), then:

```shell
export PATH="$HOME/.foundry/bin:$PATH"
forge test                                                        # contracts
BASE_RPC_URL=https://mainnet.base.org forge test --match-path "test/fork/*"
cd relayer && npm install && npm test && npm run typecheck        # relayer
cd frontend && npm install && npm run build                       # frontend
BASE_RPC_URL=https://mainnet.base.org ./scripts/e2e-local.sh      # whole flow on local chains
```

Go-live steps are in `docs/DEPLOY.md`. Day-to-day operation and incident response are in `docs/RUNBOOK.md`.

### Fee and payout behaviour (as built)
- Fee: 2% with a $0.05 floor, plus 1% while the float is under 30% of its $300 target. MUSD is valued at $0.99, mUSDC at $1.00, BTC at the Mezo oracle price minus 0.5%.
- On-chain deposit limits: 1 to 25 MUSD or mUSDC, and 0.00001 to 0.0003 BTC per deposit. The float pays at most $25 per transfer, $50 per address per day and $300 per day.
- The quote on the website is an estimate. The relayer fixes the final amount when the deposit is confirmed.
- Deposits that cannot be paid (too small after fees, over the limit) are held for manual refund. The on-chain minimums are set so this should be rare.

## 12. Sources

- Mezo bridges overview: https://mezo.org/docs/users/mainnet/bridges/
- Mezo contract and token addresses: https://mezo.org/docs/users/resources/contracts-reference/
- MUSD redemptions: https://mezo.org/docs/developers/musd/musd-redemptions
- Keeping funds safe on Mezo: https://mezo.org/blog/keeping-funds-safe-on-mezo
- mezod RFC-5 (bridgeOut proposal): https://github.com/mezo-org/mezod/blob/main/docs/rfc/rfc-5.md
- mezod repository: https://github.com/mezo-org/mezod
- Lolli withdraw to Mezo: https://mezo.org/docs/users/integrations/lolli/withdraw/
- Blockstream Swaps: https://blog.blockstream.com/announcing-blockstream-swaps/
