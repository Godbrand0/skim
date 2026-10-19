# $1 mainnet pilot

Purpose: prove the whole path works with real money before anything bigger. About $1 of USDC in the Base float, and a 0.8 mUSDC deposit on Mezo.

**Pass:** you deposit 0.8 mUSDC on Mezo and the recipient receives about **0.75 USDC** on Base within a few minutes.

Why 0.75 and not 0.8: the fee has a floor of $0.05, and 2% of 0.8 is only $0.016, so the floor applies. 0.80 minus 0.05 is 0.75. (I computed this with the relayer's own pricing code.)

**What this does not test:** rebalancing (moving collected funds back out of Mezo and into the float). That comes later.

## What "$1 on both sides" means

- **Base side:** the float holds $1 of native USDC. This is the only pool of money.
- **Mezo side:** nothing needs funding. The deposit contract holds nothing; it forwards the user's mUSDC to the treasury address in the same transaction. For the pilot the treasury is just a wallet you control, and it will end up holding the 0.8 mUSDC.

## Money and wallets you need

You sign everything. Create fresh keys, separate from the Hedera keystores already on this machine. The keystore commands ask for a password:

```shell
export PATH="$HOME/.foundry/bin:$PATH"
cast wallet new mf-admin        # admin and deployer; also the treasury for the pilot
cast wallet new mf-guardian     # can only pause
cast wallet list                # shows the two keystore addresses

cast wallet new                 # the relayer's hot key: prints a private key and an address
```

The relayer's key has to sit in the relayer's `.env` file, so for it you generate a plain key instead of a keystore. Copy the address (you need it at deploy time) and the private key (for step 5), and store the key nowhere else. It only ever holds a few cents of gas and can only call `release`, within the float's limits.

Before funding any address, confirm it is a plain account with no code. A wallet that has ever been "upgraded" with an EIP-7702 delegation can forward incoming ETH away. The deploy scripts and the relayer now refuse such addresses, but check first:

```shell
cast code <address> --rpc-url https://mainnet.base.org     # must print exactly 0x
```

Fund them (all small):

| Wallet | Network | Amount | For |
|---|---|---|---|
| mf-admin | Base | about 0.0001 ETH | deploying the float (about 0.00003 ETH) |
| mf-admin | Mezo | about 0.00002 BTC | deploying the deposit contract (about 0.000009 BTC) and one config call |
| relayer address | Base | about 0.0002 ETH | gas for payouts (a fraction of a cent each) |
| any wallet | Base | **1 USDC** (native USDC, `0x8335...2913`) | the float itself |
| your test wallet | Mezo | at least **0.8 mUSDC** plus about 0.00001 BTC for gas | the deposit |

To get mUSDC, swap MUSD to mUSDC in the Mezo app. The test wallet can be your own wallet; it does not need to be one of the three keystores.

## Steps

### 1. Deploy the Base float with tiny limits

```shell
cd ~/mezo-float-bridge
export ADMIN=<mf-admin address> RELAYER=<relayer address> GUARDIAN=<mf-guardian address>
export MAX_PER_TX=1000000 MAX_PER_ADDRESS_PER_DAY=1000000 MAX_GLOBAL_PER_DAY=2000000   # $1, $1, $2

# dry run first (spends nothing):
forge script script/DeployFloat.s.sol --rpc-url https://mainnet.base.org
# then for real:
forge script script/DeployFloat.s.sol --rpc-url https://mainnet.base.org --account mf-admin --broadcast
```

The script warns that the admin is an EOA. That is fine for a $1 pilot, not for real money. Write down the printed `MezoFloat` address as `FLOAT`.

### 2. Fund the float with $1

Send 1 USDC on Base to the `FLOAT` address, then check:

```shell
cast call $FLOAT "floatBalance()(uint256)" --rpc-url https://mainnet.base.org   # expect 1000000
```

### 3. Deploy the Mezo deposit contract

```shell
export ADMIN=<mf-admin address> GUARDIAN=<mf-guardian address> TREASURY=<mf-admin address>
export MEZO_RPC_URL=https://mainnet.mezo.public.validationcloud.io
forge script script/DeployDeposit.s.sol --rpc-url $MEZO_RPC_URL                    # dry run
forge script script/DeployDeposit.s.sol --rpc-url $MEZO_RPC_URL --account mf-admin --broadcast
```

Write down the `MezoDeposit` address as `DEPOSIT`, and its deployment block as `START_BLOCK`:

```shell
cast block-number --rpc-url $MEZO_RPC_URL     # run right after deploying; a slightly lower number is fine
```

### 4. Enable only mUSDC, with a small range (0.5 to 2 mUSDC)

```shell
DEPOSIT=<DEPOSIT> MEZO_RPC_URL=$MEZO_RPC_URL ACCOUNT=mf-admin \
  TOKENS=musdc MUSDC_MIN=500000 MUSDC_MAX=2000000 ./scripts/configure-deposit.sh send
cast call $DEPOSIT "tokenConfig(address)(bool,uint256,uint256)" 0x04671C72Aab5AC02A03c1098314b1BB6B560c197 --rpc-url $MEZO_RPC_URL
# expect: true, 500000, 2000000
```

### 5. Start the relayer in simulation mode

```shell
cd relayer && cp .env.example .env && chmod 600 .env
```

Edit `.env`:

```
MEZO_RPC_URL=https://mainnet.mezo.public.validationcloud.io
BASE_RPC_URL=https://mainnet.base.org
FLOAT_ADDRESS=<FLOAT>
DEPOSIT_ADDRESS=<DEPOSIT>
DEPOSIT_START_BLOCK=<START_BLOCK>
TREASURY_ADDRESS=<mf-admin address>
ENABLE_PAYOUTS=false
RELAYER_PRIVATE_KEY=<see below>
FLOAT_TARGET_MICRO=1000000
CORS_ORIGIN=http://localhost:5173
```

`FLOAT_TARGET_MICRO=1000000` tells the relayer the float target is $1, so the low-liquidity surcharge does not trigger (otherwise the fee would be 0.058 and you would get 0.742).

Paste the relayer's private key (from the `cast wallet new` command above) into the `RELAYER_PRIVATE_KEY=` line. Keep `.env` private: it is already git-ignored, and `chmod 600` limits it to your user.

Then:

```shell
npm install && npm start
```

You should see `payouts DISABLED (simulation only)` and `API listening on :8787`. The startup checks refuse to run if a chain or address is wrong.

### 6. Make the 0.8 mUSDC deposit

Either use the frontend (`cd frontend && cp .env.example .env && npm install && npm run dev`, open http://localhost:5173, connect, pick mUSDC, enter 0.8, approve, bridge) or do it directly from the test wallet:

```shell
MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
cast send $MUSDC "approve(address,uint256)" $DEPOSIT 800000 --rpc-url $MEZO_RPC_URL --account <test-wallet-keystore>
cast send $DEPOSIT "deposit(address,uint256,address)" $MUSDC 800000 <recipient on Base> --rpc-url $MEZO_RPC_URL --account <test-wallet-keystore>
```

The relayer waits 5 Mezo blocks, then logs `ingested deposit`. In simulation mode the deposit then shows as waiting with the note `payouts disabled (simulation ok)`. That proves ingestion, pricing and the release simulation all work, without moving money:

```shell
curl -s localhost:8787/api/health | jq
curl -s localhost:8787/api/deposit/<deposit tx hash> | jq
```

Expect the status to be `waiting`, `payoutUsdc` to be `0.750000` and `feeUsdc` to be `0.050000`.

### 7. Turn payouts on

Stop the relayer, set `ENABLE_PAYOUTS=true` in `.env`, and start it again. Waiting deposits are retried automatically. Within a few seconds you should see `release sent` then `paid`.

### 8. Check the result

```shell
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "balanceOf(address)(uint256)" <recipient> --rpc-url https://mainnet.base.org
cast call $FLOAT "floatBalance()(uint256)" --rpc-url https://mainnet.base.org     # expect 250000
cast call $MUSDC "balanceOf(address)(uint256)" <treasury> --rpc-url $MEZO_RPC_URL  # expect 800000 more than before
```

**Pass checklist**
- [ ] Recipient received 750000 USDC units (0.75 USDC) on Base.
- [ ] Float went from 1.00 to 0.25 USDC.
- [ ] The treasury received 0.8 mUSDC on Mezo and the deposit contract holds 0.
- [ ] Relayer restart does not pay again (restart it and check the recipient balance is unchanged).
- [ ] Time from the deposit to the payout. Write it down.

Record the transaction hashes (approve, deposit, release) and the times. They also feed the numbers you need for the later fee and batch decisions.

## Clean up

Admin can recover the remaining float at any time:

```shell
cast send $FLOAT "withdraw(address,uint256)" <mf-admin address> 250000 --rpc-url https://mainnet.base.org --account mf-admin
```

Or leave it as the starting float for the next step. To stop everything: `cast send $FLOAT "pause()" --account mf-guardian` and the same on `$DEPOSIT` on Mezo.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| Deploy script says "roles must differ" | Two of admin, relayer and guardian share an address |
| Relayer refuses to start: not chain 8453 or 31612 | Wrong RPC URL in `.env` |
| Relayer refuses to start: no `RELAYER_ROLE` | `RELAYER` at deploy time was not the address of the key in `.env`. Admin can grant it with `grantRole` |
| `deposit` reverts with amount out of range | Token config not set, or amount outside 0.5 to 2 |
| Deposit stays `waiting` after payouts are on | Check the note: float too low, payout under $0.50, or the daily limit |
| Payout is 0.742 not 0.75 | `FLOAT_TARGET_MICRO` was left at the $300 default, so the low-liquidity surcharge applied |
| Nothing ingested | `DEPOSIT_START_BLOCK` is after the deposit, or the Mezo RPC rate-limits log queries (try another RPC) |
