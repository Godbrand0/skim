## What it does

Skim lets people withdraw small amounts from Mezo as USDC on Base, including amounts below Mezo's own withdrawal minimum.

A user deposits mUSDC on Mezo and names a Base address. The deposit contract forwards the funds straight to the treasury and records the deposit. A relayer waits for 5 confirmations, prices the deposit, and pays USDC on Base from a pre-funded float, minus a 2% fee (at least $0.05). A measured transfer took 32 seconds from the Mezo deposit to the USDC landing on Base.

Behind that is a bridge-style website (From and To token dropdowns, live quote, wallet balances including gas, a progress tracker) and a documentation page. Code paths for MUSD and sats are built and tested, but only mUSDC is switched on in the live pilot.

**Status:** a pilot on Mezo and Base mainnet with a $1 float and tiny limits. Contracts are not externally audited, and the pilot admin is a single key.

## The problem it solves

Mezo's native bridge is built for large amounts. Withdrawing mUSDC needs at least 20 tokens and costs a flat fee of about $3, and it only goes to Ethereum, not Base. Withdrawing BTC to Bitcoin needs 0.01 BTC. Lolli's daily sats can only be moved to Mezo in lots of 30,000 sats (about $25).

So someone holding $2 to $15, such as people farming sats or earning cents from bounties, cannot get their money out at all. A $3 fee would be 150% of a $2 withdrawal even if the minimum were lifted.

## Challenges I ran into

- **The docs and the chain disagreed.** The docs and the app suggested a $10 minimum, but reading Mezo's bridge precompile on-chain showed 20 mUSDC, and that Base isn't a supported destination at all (only Ethereum and Bitcoin). That forced a different refill design: batches go mUSDC, then USDC on Ethereum, then Circle CCTP to Base.
- **The security climate.** Mezo's veBTC exploit happened during the build. That pushed the design away from pooled-fund contracts: the deposit contract never holds funds, the relayer key can only call `release`, payouts have hard per-transfer and daily caps, and every payout reference works only once.
- **A wallet that quietly stole gas.** While funding the pilot, a test wallet turned out to carry an EIP-7702 delegation that forwarded every incoming ETH payment to a collector address, and a bot re-delegated it within seconds of each attempt to revoke it. I lost about $0.17, traced the transactions on-chain, and rescued the remaining tokens with a single sponsor-paid transaction rehearsed on a local chain first. The deploy scripts and the relayer now refuse any delegated account.
- **Thin liquidity.** Mezo's MUSD/mUSDC pool holds only a few thousand dollars, which caps how large a rebalancing batch can be.

## Technologies I used

- **Contracts:** Solidity 0.8.24, Foundry (forge, cast, anvil), OpenZeppelin 5 (`AccessControlDefaultAdminRules`, `Pausable`, `ReentrancyGuard`, `SafeERC20`)
- **Relayer and API:** TypeScript on Node 24, viem, built-in SQLite
- **Frontend and docs:** Vite, TypeScript, viem, a self-hosted variable font
- **Chains and protocols:** Mezo (its price-oracle and asset-bridge precompiles), Base, Circle's native USDC; Circle CCTP and Mezo's native bridge for rebalancing
- **Testing:** 33 contract tests including fuzz tests, 3 fork tests against real Base USDC, 10 relayer unit tests, and a local end-to-end script on a Base fork

## How we built it

1. **Research on-chain first.** Verified token addresses, pool depth, the bridge's supported chains and minimums, and Mezo's own BTC price oracle before writing code.
2. **Two small contracts.** `MezoFloat` on Base holds the USDC float and pays out through a relayer-only `release` with limits, pause and single-use references. `MezoDeposit` on Mezo forwards deposits to the treasury and emits an event. Roles are separate (admin, relayer, guardian), with a two-step delayed admin transfer.
3. **A relayer** that watches deposits, waits for confirmations, prices them (fixed values for stablecoins, Mezo's oracle for BTC), checks the float's limits and balance, simulates, then pays. It checks the chain before every payout so a restart can never pay twice.
4. **A local end-to-end test** (a Base fork with real USDC plus a local Mezo-like chain) that deposits every asset type and checks the exact payout.
5. **The website and docs**, designed as a bridge with live limits and addresses read from the relayer.
6. **A $1 mainnet pilot.** Deployed both contracts, confirmed the deployed bytecode matches the tested build byte for byte, enabled mUSDC only, and ran it. 0.8 mUSDC in gave 0.75 USDC out, a second transfer through the website (1 mUSDC) gave 0.95 USDC, and a simulated second payout of the same deposit reverted on-chain.

Contracts: [MezoFloat on Base](https://basescan.org/address/0x4891b3f06C3b9AA33C6DBFa45CacD3C5922Ef17A), [MezoDeposit on Mezo](https://explorer.mezo.org/address/0x7C7ad1bEa23Eea0189e94Ec42D20d3DA604DaDE6).

## What we learned

- **Verify on-chain, not in the docs.** The real minimum and the missing Base route only showed up by querying the contracts.
- **Fees behave differently at small sizes.** A $0.05 floor turns a 0.8 deposit into 0.75, so the fee design matters more than the percentage.
- **Batching is what makes small amounts possible.** The fixed cost of Mezo's bridge is paid once per batch instead of once per user, and two-way flows can cancel each other out on each side.
- **Refusing is a feature.** The website blocks a deposit the float can't pay, and charges a little more when the float is low.
- **Wallet hygiene is part of security.** A single leftover smart-account delegation was the only thing that cost us money.
- **Measure, don't guess.** The 32-second figure replaced my estimate of "a few minutes".

## What's next for Skim

- **The reverse direction (USDC on Base to mUSDC on Mezo).** The same two contracts work unchanged, deployed the other way round. Each direction's deposits refill the other's float on its own chain, so only the imbalance needs Mezo's bridge.
- **A real rebalancing run** through Mezo's bridge and CCTP, to set the fee and batch size from measured costs.
- **A multisig admin, an external security review, and a legal check** before raising limits or the float.
- **Turning on MUSD and sats**, plus a small BTC top-up for new arrivals, so someone with only stablecoins can transact on Mezo.
- **A depeg circuit-breaker** that pauses deposits if mUSDC drifts from $1.
- **Closer ties to Mezo's onboarding paths,** such as Lolli's daily sats, and a conversation with the Mezo team about their planned small-amount bridge.
