# MUSD mainnet pilot: commands, in order

Run these yourself: they spend real funds and need your keystore passwords (`--account` prompts for it).
Do one step at a time and check the result before the next. Amounts are tiny on purpose.

```shell
source scripts/pilot-env.sh        # ADMIN GUARDIAN TREASURY RELAYER, MEZO_RPC_URL, BASE_RPC
export ADMIN_ACCOUNT=mf-sponsor    # keystore of ADMIN
export TREASURY_ACCOUNT=<keystore name of the TREASURY address>
export MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
export MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
export POOL=0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356
```

## 0. Fund gas on Mezo (BTC)

Send native BTC on Mezo: about 0.00004 to ADMIN (deploy), about 0.00001 each to TREASURY and RELAYER.
Check: `cast balance $ADMIN --rpc-url $MEZO_RPC_URL --ether` (and the other two).

## 1. Deploy guard, new deposit contract, rebalancer

The relayer hot key is the keeper. Dry run first (omit `--broadcast`), then broadcast.

```shell
ADMIN=$ADMIN GUARDIAN=$GUARDIAN TREASURY=$TREASURY KEEPER=$RELAYER \
  forge script script/DeployMezoV2.s.sol --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT --broadcast
```

Note the three printed addresses and the deploy block, then:

```shell
export GUARD=0x... DEPOSIT2=0x... REBALANCER=0x...
cast block-number --rpc-url $MEZO_RPC_URL          # use as DEPOSIT_START_BLOCK (a little lower is fine)
cast call $GUARD "status()(bool,uint256,uint256,uint256)" --rpc-url $MEZO_RPC_URL   # expect true, ~9900, ~9980, ~9980
```

## 2. Admin: enable MUSD (pilot range 0.5 to 3) and attach the guard

```shell
cast send $DEPOSIT2 "setTokenConfig(address,bool,uint256,uint256)" $MUSD true 500000000000000000 3000000000000000000 \
  --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT
cast send $DEPOSIT2 "setPegGuard(address)" $GUARD --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT
```

## 3. Treasury: approve the rebalancer for MUSD

```shell
cast send $MUSD "approve(address,uint256)" $REBALANCER 5000000000000000000 --rpc-url $MEZO_RPC_URL --account $TREASURY_ACCOUNT
```

(Approve mUSDT / mUSDC / BTC later, only when you test those routes.)

## 4. Get about 1.1 MUSD for the test deposit

The admin holds 1.2 mUSDC. Sell 1.1 mUSDC into the real pool (a normal pool swap, no router needed). Preview first:

```shell
cast call $POOL "getAmountOut(uint256,address)(uint256)" 1100000 $MUSDC --rpc-url $MEZO_RPC_URL     # MUSD wei out
cast send $MUSDC "transfer(address,uint256)" $POOL 1100000 --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT
cast send $POOL "swap(uint256,uint256,address,bytes)" 0 <MUSD_OUT_FROM_PREVIEW> $ADMIN 0x --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT
```

`token0` is mUSDC and `token1` is MUSD in this pool, so the MUSD amount goes in the second slot. Do both sends back to back; if the preview is stale the swap reverts and the mUSDC stays in the pool until it is skimmed, so keep the amounts small.

## 5. Point the relayer at the new deposit contract

In `relayer/.env`: `DEPOSIT_ADDRESS=$DEPOSIT2`, `DEPOSIT_START_BLOCK=<block from step 1>`, `PEG_GUARD_ADDRESS=$GUARD`,
`REBALANCER_ADDRESS=$REBALANCER`, `FLOAT_TARGET_MICRO=5000000`. Before switching, make sure the old deposit contract has no unpaid deposits
(`curl localhost:8787/api/health`), and afterwards disable mUSDC on the old one (`setTokenConfig(<mUSDC>, false, 500000, 2000000)` as admin).
Start with `ENABLE_PAYOUTS=false` and check the log says the keeper role is held; then set it to `true`.

## 6. The MUSD exit

Use the website (MUSD, 1) or:

```shell
cast send $MUSD "approve(address,uint256)" $DEPOSIT2 1000000000000000000 --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT
cast send $DEPOSIT2 "deposit(address,uint256,address)" $MUSD 1000000000000000000 <YOUR_BASE_ADDRESS> --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT
```

Expect about 0.94 USDC on Base within a minute (1 MUSD valued at the pool's price, capped at 0.99, less the $0.05 fee floor). Record both transactions.

## 7. The rebalance

The deposited MUSD sits in the treasury. Either wait for the relayer's interval (it only acts above `REBALANCE_MIN_MUSD`, default 5, so lower it to 1 for this test) or run it by hand as the keeper:

```shell
cast send $REBALANCER "rebalance(uint8,uint256,uint256)" 0 1000000000000000000 0 --rpc-url $MEZO_RPC_URL --account <keeper keystore>
```

Check the treasury's mUSDC went up by about 0.99. Record the transaction.

## 8. Then

Update `docs/PILOT_RESULT.md` with the transaction hashes, and run `scripts/verify-contracts.sh` for each new contract.
Leave every BTC route alone until a separate tiny BTC test.

---

# USDC on Base to MUSD on Mezo

A third lane (`musd`): the user deposits USDC on Base and is paid MUSD on Mezo from a MUSD float. It needs its own Base deposit contract (the relayer decides the payout by which contract the deposit came to) and a second `MezoFloat` that holds MUSD. Nothing already deployed changes.

The relayer sizes the payout at the MUSD/mUSDC pool's price: $0.70 of USDC less the $0.05 fee is $0.65, which is about 0.657 MUSD while MUSD sells at $0.99. It holds the payout while the peg guard reports a depeg. The float is refilled with rebalancer route 3 (mUSDC to MUSD), which already ran on mainnet.

```shell
source scripts/pilot-env.sh        # ADMIN GUARDIAN TREASURY RELAYER, MEZO_RPC_URL, BASE_RPC
export ADMIN_ACCOUNT=mf-sponsor TREASURY_ACCOUNT=mf-treasury
export MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
export REBALANCER=0x693c0afE4f72F628C904E67eF0c3531FeAa0f4fb
```

## 1. Deploy the MUSD float on Mezo (limits in MUSD, 18 decimals)

`pilot-env.sh` exports mUSDC-sized limits (6 decimals). The script refuses those for MUSD, so override all three:

```shell
PAYOUT_TOKEN=$MUSD MAX_PER_TX=1000000000000000000 MAX_PER_ADDRESS_PER_DAY=1000000000000000000 MAX_GLOBAL_PER_DAY=2000000000000000000 \
  forge script script/DeployFloatMezo.s.sol --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT --with-gas-price 2000000 --slow --broadcast
export MUSD_FLOAT=0x...            # printed: "MezoFloat (MUSD, on Mezo)"
```

## 2. Deploy a second MezoDeposit on Base and enable USDC (0.5 to 2)

```shell
ADMIN=$ADMIN GUARDIAN=$GUARDIAN TREASURY=<BASE_TREASURY> \
  forge script script/DeployDepositBase.s.sol --rpc-url $BASE_RPC --account $ADMIN_ACCOUNT --broadcast
export MUSD_DEPOSIT=0x...          # printed
cast block-number --rpc-url $BASE_RPC     # use as MUSD_DEPOSIT_START_BLOCK
DEPOSIT=$MUSD_DEPOSIT TOKENS=usdc RPC_URL=$BASE_RPC USDC_MIN=500000 USDC_MAX=2000000 ACCOUNT=$ADMIN_ACCOUNT ./scripts/configure-deposit.sh send
```

`<BASE_TREASURY>` is the same Base address the first Base deposit contract forwards to (`BASE_TREASURY_ADDRESS` in `relayer/.env`).

## 3. Fund the MUSD float with about 1.1 MUSD

The Mezo treasury holds mUSDC. Approve the rebalancer, buy MUSD through the pool with route 3 (keeper only), then move it to the float:

```shell
cast send $MUSDC "approve(address,uint256)" $REBALANCER 1100000 --rpc-url $MEZO_RPC_URL --account $TREASURY_ACCOUNT \
  --gas-limit 200000 --gas-price 2000000 --priority-gas-price 1
cast send $REBALANCER "rebalance(uint8,uint256,uint256)" 3 1100000 0 --rpc-url $MEZO_RPC_URL --account <keeper keystore> \
  --gas-limit 600000 --gas-price 2000000 --priority-gas-price 1
cast call $MUSD "balanceOf(address)(uint256)" $TREASURY --rpc-url $MEZO_RPC_URL      # about 1.108e18
cast send $MUSD "transfer(address,uint256)" $MUSD_FLOAT <that balance> --rpc-url $MEZO_RPC_URL --account $TREASURY_ACCOUNT \
  --gas-limit 200000 --gas-price 2000000 --priority-gas-price 1
```

## 4. Point the relayer at it

Add to `relayer/.env` (a restart is needed: stop the running relayer first, then `npm start`):

```
MUSD_DEPOSIT_ADDRESS=<MUSD_DEPOSIT>
MUSD_DEPOSIT_START_BLOCK=<Base block from step 2>
MUSD_FLOAT_ADDRESS=<MUSD_FLOAT>
MUSD_FLOAT_TARGET_MICRO=1000000
```

The log should list `lanes: exit, enter, musd`. Check `curl localhost:8787/api/config`: `enterMusd` should show the float balance (about 1.1) and the peg state.

## 5. Test

On the site choose From USDC, To MUSD, send 0.7 USDC. Expect about 0.657 MUSD on Mezo (the exact amount depends on the pool price at that moment). Record both transactions in `PILOT_RESULT.md`.

Limits: the Base deposit contract takes 0.5 to 2 USDC per deposit; the MUSD float pays at most 1 MUSD per payout and 1 MUSD per address per day.

---

# Automatic float refills (MezoFloatRefiller)

Without this, every Mezo-side float is topped up by hand. `MezoFloatRefiller` lets the relayer (the keeper) move tokens from the treasury into the floats, and only the floats the admin has listed, for the token each float pays, up to a per-call cap and the treasury's allowance. It never holds funds. On its 10-minute timer the relayer then:

1. tops up the **mUSDC float** from the treasury's mUSDC (deposited mUSDC pays the next Base-to-Mezo user, no bridge needed);
2. tops up the **MUSD float** from the treasury's MUSD (deposited MUSD pays the next one);
3. if the MUSD float is still short and the treasury has no MUSD, buys just the shortfall with spare mUSDC through the pool (rebalancer route 3), then tops up. It skips this while the peg guard reports a depeg;
4. only then runs the usual MUSD to mUSDC rebalance, so MUSD a float needs is not sold first.

A float is refilled when it falls under its low level (30% of its target: `ENTER_FLOAT_TARGET_MICRO`, `MUSD_FLOAT_TARGET_MICRO`), up to the target. The USDC float on Base is not covered; it still needs the bridge and CCTP.

Tested on a fork of Mezo mainnet: a low mUSDC float and a low MUSD float were both topped up from the treasury; with no treasury MUSD, 1.0 mUSDC bought 1.010006 MUSD and the float was refilled to its exact target.

## Mainnet steps

```shell
source scripts/pilot-env.sh
export ADMIN_ACCOUNT=mf-sponsor TREASURY_ACCOUNT=mf-treasury
export MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197
export ENTER_FLOAT=0x4c28bCd5DCaDc47263354b2f37A8aA2f7E57Bc4B MUSD_FLOAT=0xb8558A04475e87057e5F8B596A1b4c076a8B6614
```

**1. Deploy and list both floats** (ADMIN must broadcast, because listing is an admin call; KEEPER is the relayer address):

```shell
ADMIN=$ADMIN KEEPER=$RELAYER TREASURY=$TREASURY ENTER_FLOAT=$ENTER_FLOAT MUSD_FLOAT=$MUSD_FLOAT \
  forge script script/DeployRefiller.s.sol --rpc-url $MEZO_RPC_URL --account $ADMIN_ACCOUNT --with-gas-price 2000000 --slow --broadcast
export REFILLER=0x...       # printed
```

**2. The treasury approves the refiller** for what it may move, and the rebalancer for mUSDC (route 3, used to buy MUSD):

```shell
GAS="--gas-limit 120000 --gas-price 1600000 --priority-gas-price 1"
cast send $MUSDC "approve(address,uint256)" $REFILLER 5000000 --rpc-url $MEZO_RPC_URL --account $TREASURY_ACCOUNT $GAS
cast send $MUSD  "approve(address,uint256)" $REFILLER 5000000000000000000 --rpc-url $MEZO_RPC_URL --account $TREASURY_ACCOUNT $GAS
cast send $MUSDC "approve(address,uint256)" 0x693c0afE4f72F628C904E67eF0c3531FeAa0f4fb 5000000 --rpc-url $MEZO_RPC_URL --account $TREASURY_ACCOUNT $GAS
```

The approvals are the limit of what a compromised keeper could ever move. Re-approve when they run low. The MUSD to mUSDC rebalance also needs its own MUSD approval; the allowance left on it is under 1 MUSD, so re-approve MUSD for `0x693c…f4fb` as well if you want that route to keep running.

**3. Turn it on.** Add `REFILLER_ADDRESS=$REFILLER` to `relayer/.env`, stop the running relayer and start it. The log should show `float refills ENABLED`. Verify the contract with `./scripts/verify-contracts.sh refiller $REFILLER <admin> 172800 <relayer> <treasury>`.
