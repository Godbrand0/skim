# $1 mainnet pilot: the reverse direction (USDC on Base to mUSDC on Mezo)

Same idea as the first pilot, mirrored. Deposit about 1 USDC on Base and receive about 0.95 mUSDC on Mezo, paid from a $1 mUSDC float.

**Pass:** you deposit 1 USDC on Base and 0.95 mUSDC arrives at the recipient on Mezo within a minute or two.

Why 0.95: the fee has a $0.05 floor, and 2% of 1 is only $0.02. Set `ENTER_FLOAT_TARGET_MICRO=1000000` so the low-liquidity surcharge doesn't apply.

## What gets deployed

| Contract | Network | Role |
|---|---|---|
| `MezoDeposit` | **Base** | Collects USDC from users, forwards it to the treasury, emits the deposit event. Holds nothing. |
| `MezoFloat` (holding mUSDC) | **Mezo** | The float. Pays mUSDC to the recipient when the relayer calls `release`. |

They are the same two contracts as the first pilot, deployed the other way round. They reuse your existing keys:

| Role | Address |
|---|---|
| Admin and deployer | `0xf76B047Dfc022c8D106AdfbCC4f948b6Ee56cA61` (keystore `mf-sponsor`) |
| Guardian | `0xF1E4b4C6e6d921144980d510B1213A920Bba72F1` |
| Treasury on Base (collects the USDC) | `0x25837EE4525C52BAf917e7DA84eDeE238D14F6c9` |
| Relayer (release only, on Mezo this time) | `0x2A2f4B9528296AbaC439f66Ab111a691f0BE9376` |

## Gas you need first

| Wallet | Network | About | For |
|---|---|---|---|
| Sponsor (admin) | Mezo | **0.00001 BTC** | deploying the float (the script's gas check wants about 0.0000083 BTC in the wallet at the maximum fee; the real cost is about 0.0000033) and one transfer |
| Sponsor (admin) | Base | about 0.00003 ETH | deploying the Base deposit contract and one config call |
| Relayer | **Mezo** | about 0.000002 BTC | paying the gas for each mUSDC payout (about 0.0000003 BTC each). The relayer already has ETH on Base from the first pilot. |

Check that the relayer address has no code on Mezo too: `cast code 0x2A2f4B9528296AbaC439f66Ab111a691f0BE9376 --rpc-url $MEZO_RPC_URL` must print `0x`. The relayer refuses to start otherwise.

## Steps

Open a terminal and load the shared settings:

```shell
cd ~/mezo-float-bridge
source scripts/pilot-env.sh
```

### 1. Deploy the deposit contract on Base

```shell
# dry run
ADMIN=$ADMIN GUARDIAN=$GUARDIAN TREASURY=$TREASURY forge script script/DeployDepositBase.s.sol --rpc-url $BASE_RPC
# real deploy
ADMIN=$ADMIN GUARDIAN=$GUARDIAN TREASURY=$TREASURY forge script script/DeployDepositBase.s.sol --rpc-url $BASE_RPC --account mf-sponsor --broadcast
```

Note the printed address and the block number:

```shell
export ENTER_DEPOSIT=<address printed>
cast block-number --rpc-url $BASE_RPC         # write this down: ENTER_DEPOSIT_START_BLOCK (a slightly lower number is fine)
```

### 2. Enable USDC, 0.5 to 2 per deposit

```shell
DEPOSIT=$ENTER_DEPOSIT ACCOUNT=mf-sponsor TOKENS=usdc RPC_URL=$BASE_RPC USDC_MIN=500000 USDC_MAX=2000000 ./scripts/configure-deposit.sh send
cast call $ENTER_DEPOSIT "tokenConfig(address)(bool,uint256,uint256)" $USDC --rpc-url $BASE_RPC     # expect true 500000 2000000
```

### 3. Deploy the mUSDC float on Mezo, with the pilot limits ($1 per payout, $2 per day)

```shell
# dry run
ADMIN=$ADMIN RELAYER=$RELAYER GUARDIAN=$GUARDIAN forge script script/DeployFloatMezo.s.sol --rpc-url $MEZO_RPC_URL
# real deploy
ADMIN=$ADMIN RELAYER=$RELAYER GUARDIAN=$GUARDIAN forge script script/DeployFloatMezo.s.sol --rpc-url $MEZO_RPC_URL --account mf-sponsor --broadcast
export ENTER_FLOAT=<address printed>
```

### 4. Fund the Mezo float with 1 mUSDC, and the relayer with Mezo gas

```shell
cast send $MUSDC "transfer(address,uint256)" $ENTER_FLOAT 1000000 --account mf-sponsor --rpc-url $MEZO_RPC_URL
cast call $ENTER_FLOAT "floatBalance()(uint256)" --rpc-url $MEZO_RPC_URL        # expect 1000000
cast send $RELAYER --value 0.000002ether --account mf-sponsor --rpc-url $MEZO_RPC_URL
```

(`ether` is just the unit name: Mezo's native token is BTC with 18 decimals, so this sends 0.000002 BTC.)

Tell me the three addresses and the block number and I'll verify the contracts on-chain (code matches the build, roles, limits).

### 5. Add the reverse lane to the relayer

Edit `relayer/.env` and add:

```
ENTER_DEPOSIT_ADDRESS=<ENTER_DEPOSIT>
ENTER_DEPOSIT_START_BLOCK=<the Base block number from step 1>
ENTER_FLOAT_ADDRESS=<ENTER_FLOAT>
ENTER_FLOAT_TARGET_MICRO=1000000
BASE_TREASURY_ADDRESS=0x25837EE4525C52BAf917e7DA84eDeE238D14F6c9
ENABLE_PAYOUTS=false
```

Start with `ENABLE_PAYOUTS=false`, so the first deposit is only simulated. Restart: Ctrl+C, then `npm start`. It should print `Lanes: exit, enter`. The startup checks refuse to run if any address has no code, or if the relayer key lacks the role.

### 6. Deposit 1 USDC on Base

Use the website (run it with `cd frontend && npm run dev`, open `http://localhost:5173/#enter`) or `cast`:

```shell
cast send $USDC "approve(address,uint256)" $ENTER_DEPOSIT 1000000 --account <your wallet keystore> --rpc-url $BASE_RPC
cast send $ENTER_DEPOSIT "deposit(address,uint256,address)" $USDC 1000000 <recipient on Mezo> --account <your wallet keystore> --rpc-url $BASE_RPC
```

The website needs the wallet on **Base** for this direction and asks to switch. You need a little ETH on Base for gas.

After about 20 seconds (10 Base blocks) check the relayer:

```shell
curl -s localhost:8787/api/deposit/<the deposit tx hash> | jq
```

With payouts off you expect `status: waiting`, note `payouts disabled (simulation ok)`, `payoutUsdc: 0.950000`, `payoutToken: mUSDC`.

### 7. Turn payouts on

Stop the relayer, set `ENABLE_PAYOUTS=true`, start it again. The waiting deposit is paid within seconds.

### 8. Check the result

```shell
cast call $MUSDC "balanceOf(address)(uint256)" <recipient on Mezo> --rpc-url $MEZO_RPC_URL     # up by 950000
cast call $ENTER_FLOAT "floatBalance()(uint256)" --rpc-url $MEZO_RPC_URL                       # 1000000 - 950000 = 50000
cast call $USDC "balanceOf(address)(uint256)" $TREASURY --rpc-url $BASE_RPC                    # up by 1000000
cast call $USDC "balanceOf(address)(uint256)" $ENTER_DEPOSIT --rpc-url $BASE_RPC               # 0: the deposit contract holds nothing
```

**Pass checklist**
- [ ] The recipient received 0.95 mUSDC on Mezo.
- [ ] The Mezo float went from 1.00 to 0.05 mUSDC.
- [ ] The Base treasury received the 1 USDC, and the Base deposit contract holds 0.
- [ ] A relayer restart pays nothing twice, for either direction.
- [ ] Time from the deposit to the payout. Write it down.

Note: the float will be nearly empty after this, so a second deposit needs a top-up. The mUSDC the Mezo treasury already holds (from the first pilot's exit deposits) can refill it with no bridge.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| The Mezo deploy refuses, "insufficient funds" | The sponsor has less Mezo BTC than the gas check wants (about 0.0000083). Send a little more. |
| Relayer refuses to start: "no RELAYER_ROLE" | `RELAYER` at deploy time was not the key in `relayer/.env` |
| Relayer starts but the deposit stays waiting with "error: ..." | The relayer has no BTC for gas on Mezo, or the float is empty |
| Nothing ingested | `ENTER_DEPOSIT_START_BLOCK` is after the deposit, or the Base RPC rate-limits log queries |
| Payout is 0.942, not 0.95 | `ENTER_FLOAT_TARGET_MICRO` was left at the $300 default, so the surcharge applied |
