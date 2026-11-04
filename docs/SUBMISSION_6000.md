## What it does

Skim moves small amounts between Mezo and Base, below Mezo's own withdrawal minimum, in both directions.

**Mezo to Base:** a user deposits MUSD or mUSDC on Mezo and names a Base address. The deposit contract forwards funds to a treasury. A relayer waits for confirmations, prices the deposit and pays USDC on Base from a pre-funded float, minus 2% (at least $0.05). One transfer took 32 seconds.

**Base to Mezo:** USDC deposited on Base is paid as mUSDC on Mezo from a Mezo-side float.

**MUSD does real work on-chain:**
- **Valuation:** MUSD is valued at the lower of $0.99 and what Mezo's MUSD/mUSDC pool pays.
- **Depeg guard:** `MusdPegGuard` reads the MUSD/mUSDC, MUSD/mUSDT and MUSD/BTC pools plus the protocol PriceFeed. `MezoDeposit` rejects MUSD while it reports a depeg, and the relayer holds payouts. It fails closed on any read error.
- **Rebalancing:** `MezoRebalancer` sells the treasury's MUSD for mUSDC through Mezo's pool. It never holds funds, is keeper-only, and has per-route caps, an on-chain price floor and a guard check.

The website has a bidirectional switch, a MUSD / mUSDC / USDC dropdown, a live quote, a live peg readout and a progress tracker.

**Status:** a mainnet pilot with a small float and tiny limits. All six contracts are verified. Not externally audited; the admin is a single key. The BTC and mUSDT rebalancer routes and the BTC gas lane are built and tested but not yet run on mainnet.

## What ran on mainnet

- MUSD exit: 1 MUSD in, 0.94 USDC out on Base
- Rebalance: 1 MUSD sold for 0.991582 mUSDC through Mezo's pool; 1.1 mUSDC bought 1.108861 MUSD
- Reverse lane: 0.7 USDC on Base, 0.65 mUSDC paid on Mezo
- Earlier mUSDC exits: 0.8 in, 0.75 out; 1 in, 0.95 out; a repeat payout reverted on-chain

Transaction hashes are in docs/PILOT_RESULT.md.

## The problem it solves

Mezo's native bridge needs at least 20 mUSDC, costs about $3 flat, and only goes to Ethereum, not Base. Withdrawing BTC needs 0.01 BTC. Lolli's daily sats move to Mezo only in lots of 30,000 sats (about $25). Someone holding $2 to $15 cannot get out at all, and a $3 fee would be 150% of a $2 withdrawal.

## Challenges I ran into

- **The docs and the chain disagreed.** The app said $10 minimum; the bridge precompile said 20 mUSDC and no Base route. That forced a refill path of mUSDC, then USDC on Ethereum, then Circle CCTP to Base.
- **MUSD had to do real work.** Wave 2 feedback called the integration cosmetic. I rebuilt it around Mezo's pools and PriceFeed, tested on a mainnet fork, then ran it on mainnet with small amounts.
- **Fork limits.** The BTC token is a precompile that reverts approve and transfer on forks, so BTC routes are mock-tested only, and I mark them unverified.
- **Infrastructure failed mid-test.** A Mezo RPC host stopped resolving and Base's public RPC rate-limited; I switched endpoints and the relayer paid the stuck deposit itself.
- **The veBTC exploit** happened during the build, so the deposit contract never holds funds, the relayer key can only call `release`, payouts are capped, and every reference works once.
- **A wallet that stole gas.** An EIP-7702 delegation forwarded incoming ETH to a collector. I lost about $0.17, traced it, and rescued the tokens in one sponsor-paid transaction. Deploy scripts and the relayer now refuse delegated accounts.

## Technologies I used

Solidity 0.8.24, Foundry, OpenZeppelin 5; TypeScript, Node 24, viem, SQLite; Vite; Mezo pools, PriceFeed, oracle and bridge precompiles; Base, Circle USDC and CCTP. Tests: 81 contract tests (with fuzz), 8 fork tests on live Mezo pools, 33 relayer tests, and a local two-direction end-to-end run.

## How we built it

1. Checked token addresses, pool depth, bridge limits and the oracle on-chain first.
2. Small contracts with separate admin, relayer/keeper and guardian roles: `MezoFloat` (limits, pause, single-use references), `MezoDeposit`, `MusdPegGuard`, `MezoRebalancer`.
3. A relayer for both directions that prices, applies the peg hold, simulates, then pays, checking the chain first so a restart never pays twice.
4. Fork end-to-end tests, then small mainnet tests step by step.

## Contracts (verified)

Mezo: [MusdPegGuard](https://explorer.mezo.org/address/0x4891b3f06C3b9AA33C6DBFa45CacD3C5922Ef17A), [MezoDeposit](https://explorer.mezo.org/address/0xBc627912d5bed789052F81Cbe626b683905feC36), [MezoRebalancer](https://explorer.mezo.org/address/0x693c0afE4f72F628C904E67eF0c3531FeAa0f4fb), [MezoFloat](https://explorer.mezo.org/address/0x4c28bCd5DCaDc47263354b2f37A8aA2f7E57Bc4B). Base: [MezoDeposit](https://repo.sourcify.dev/8453/0xF49aFA56d6A31420856946B763b5FB8428483467), [MezoFloat](https://repo.sourcify.dev/8453/0x4891b3f06C3b9AA33C6DBFa45CacD3C5922Ef17A).

## What we learned

- Verify on-chain, not in the docs.
- Integration depth means the contract acts on the protocol; reading a price is cosmetic.
- A $0.05 fee floor turns a 0.8 deposit into 0.75, so fee design matters more than the percentage.

## What's next for Skim

- Tiny mainnet tests of the BTC and mUSDT routes.
- BTC gas packs for newcomers holding only stablecoins (contract and relayer lane written, not deployed).
- Automate the bridge and CCTP refill, and add a user-facing MUSD to mUSDC swap.
- A multisig admin, external audit and legal check before raising limits.
