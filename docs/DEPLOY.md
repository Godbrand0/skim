# Mainnet deployment guide

Nothing here broadcasts for you. Every transaction is signed by your own wallets. Never put a private key on a command line or in git. Use Foundry keystores (`cast wallet import <name> --interactive`) and `--account <name>`.

## 0. Before you start
- [ ] **Admin multisig on Base** (for `MezoFloat`) and an **admin on Mezo** (for `MezoDeposit`). A multisig is strongly recommended. Safe is available on Mezo at safe.mezo.org, so create one there and confirm it works before deploying.
- [ ] **Three different addresses** per contract: admin, relayer (hot key, release-only), guardian (pause-only). The deploy script refuses duplicates.
- [ ] **Treasury address on Mezo** (a multisig or hardware wallet). Deposits are forwarded there immediately.
- [ ] Relayer wallet funded with about 0.001 ETH on Base.
- [ ] A security review of both contracts if you plan to hold more than a trivial float. They have not been audited.
- [ ] Legal check for operating the service where you are (it holds user value in transit).
- [ ] The $25 validation test from the README has been done, and the numbers in `relayer/.env.example` reflect it.

## 1. Pre-flight (free)
```shell
export PATH="$HOME/.foundry/bin:$PATH"
forge test                                   # 33 unit tests
BASE_RPC_URL=https://mainnet.base.org forge test --match-path "test/fork/*"
BASE_RPC_URL=https://mainnet.base.org ./scripts/e2e-local.sh   # full flow on local chains
```

## 2. Deploy MezoFloat on Base
```shell
export ADMIN=0x... RELAYER=0x... GUARDIAN=0x...
export MAX_PER_TX=25000000 MAX_PER_ADDRESS_PER_DAY=50000000 MAX_GLOBAL_PER_DAY=300000000   # optional, USDC micro
# 1) Dry run against the live chain (no broadcast):
forge script script/DeployFloat.s.sol --rpc-url https://mainnet.base.org
# 2) Real deploy:
forge script script/DeployFloat.s.sol --rpc-url https://mainnet.base.org --account deployer --broadcast
```
Deploy cost is about 0.00003 ETH. Verify the source on Basescan (`forge verify-contract`, needs an API key).

## 3. Deploy MezoDeposit on Mezo
```shell
export ADMIN=0x... GUARDIAN=0x... TREASURY=0x...
forge script script/DeployDeposit.s.sol --rpc-url https://mainnet.mezo.public.validationcloud.io                      # dry run
forge script script/DeployDeposit.s.sol --rpc-url https://mainnet.mezo.public.validationcloud.io --account deployer --broadcast
```
Verify on Blockscout: `forge verify-contract <addr> src/MezoDeposit.sol:MezoDeposit --verifier blockscout --verifier-url https://explorer.mezo.org/api`.

Then the **admin** enables the tokens. For a multisig, print calldata and submit it as transactions to the deposit contract:
```shell
DEPOSIT=0x... ./scripts/configure-deposit.sh calldata          # multisig admin
DEPOSIT=0x... MEZO_RPC_URL=... ACCOUNT=admin ./scripts/configure-deposit.sh send   # EOA admin
```
Defaults: MUSD and mUSDC from 1 to 25, BTC from 0.00001 to 0.0003 per deposit.

Note the block number the deposit contract was deployed in. It is `DEPOSIT_START_BLOCK`.

## 4. Fund the float
Start small ($50 to $100), then grow. Send USDC (Base native, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) directly to the `MezoFloat` address. Check `floatBalance()`.

## 5. Run the relayer
```shell
cd relayer && cp .env.example .env     # fill in addresses and the relayer key (secret manager preferred)
npm install
npm run start                           # starts in SIMULATION mode (ENABLE_PAYOUTS=false)
```
- Make a small real deposit yourself and confirm the logs show `payouts disabled (simulation ok)`.
- Then set `ENABLE_PAYOUTS=true` and make another small deposit. Confirm the USDC arrives and `/api/health` looks right.
- Run it under a supervisor (systemd or similar) with the database on persistent disk and backups of `relayer.sqlite`.
- Put the API behind HTTPS (a reverse proxy) and set `CORS_ORIGIN` to the exact frontend origin.

## 6. Frontend
```shell
cd frontend && cp .env.example .env     # set VITE_API_URL to the public API URL
npm install && npm run build            # output in frontend/dist, host on any static host over HTTPS
```
The build produces two pages, the bridge (`index.html`) and the docs (`docs.html`), so host the whole `dist` folder. The frontend reads the contract addresses from the API and links them to the explorers so users can verify. Test the whole flow in a browser with a real wallet and a tiny amount before announcing. The page was checked in headless Chrome with a mock wallet (connect, balances, token dropdown, quote, approve step), but no real wallet transaction has been sent through it.

## 7. First-week checklist
- [ ] First real deposits for each asset (mUSDC, MUSD, BTC) paid the expected amount.
- [ ] A restart of the relayer caused no double payout.
- [ ] Monitor run daily. First batch (see RUNBOOK) done as a 20 mUSDC test before a larger one.
- [ ] Alerts on relayer down, float low, and `waiting` items older than an hour.
- [ ] Raise limits and the float only after a clean week.
