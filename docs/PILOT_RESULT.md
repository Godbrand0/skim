# $1 mainnet pilot: result (19 October 2026)

**Outcome: passed.** A deposit of 0.8 mUSDC on Mezo produced a payout of 0.75 USDC on Base, paid from a $1 float. Everything below was verified on-chain.

## Deployed contracts

| Contract | Network | Address | Deploy tx |
|---|---|---|---|
| MezoFloat | Base (8453) | `0x4891b3f06C3b9AA33C6DBFa45CacD3C5922Ef17A` | `0xa613d8580e890be76c1f84bf06607f615eeed2abe762040c39826c5cfd1a76dc` (block 52802483) |
| MezoDeposit | Mezo (31612) | `0x7C7ad1bEa23Eea0189e94Ec42D20d3DA604DaDE6` | `0x06092cf09f57e92638829d737df7ce345bc5f0c92e33bb35c04b97124c8a8a6e` (block 12613337) |

The deployed bytecode of both contracts was compared with the tested build and matched byte for byte, outside the slots that hold constructor values.

## Roles (pilot only, all single keys)

| Role | Address |
|---|---|
| Admin and deployer (both contracts) | `0xf76B047Dfc022c8D106AdfbCC4f948b6Ee56cA61` |
| Guardian (both contracts) | `0xF1E4b4C6e6d921144980d510B1213A920Bba72F1` |
| Treasury (Mezo) | `0x25837EE4525C52BAf917e7DA84eDeE238D14F6c9` |
| Relayer (float) | `0x2A2f4B9528296AbaC439f66Ab111a691f0BE9376` |

Pilot limits: $1 per payout, $1 per recipient per day, $2 per day. mUSDC only, 0.5 to 2 per deposit.

## The test transfer

| Step | Transaction |
|---|---|
| Fund the float with 1 USDC | `0x157f2053841e2e00cfa1240059c5a362c474a4b0157b858756d5afaf416cf069` |
| Enable mUSDC (0.5 to 2) | `0xce80e1a6689fbc66e81713236fe03d71cc7b2674cf69835d40cccd69fb497503` |
| Approve 0.8 mUSDC | `0xc87443e7174071325aed46049b7d5b20c07a72efa8f44ea280b75f7bcbc8db34` |
| Deposit 0.8 mUSDC (Mezo block 12613658) | `0x6da0725f553f791b2bc7ce227103a13871334e47ad38085f8a319f946f359d74` |
| Payout of 0.75 USDC (Base) | `0x9f79e60d6680fc46fae568a0453d5249a7513b0b0142f01b63541dc2f5edb081` |

## Measured results

- Fee 0.05 (the floor, since 2% of 0.8 is 0.016), payout 0.75 USDC. Matches the relayer's quote exactly.
- Float 1.00 to 0.25 USDC. Recipient 1.00 to 1.75 USDC.
- The treasury received the 0.8 mUSDC. The deposit contract held 0 throughout.
- A simulated second payout of the same deposit reverted with `RefAlreadyUsed`.
- The relayer first ran in simulation mode and priced the deposit correctly (`payouts disabled (simulation ok)`), which also proved its key held the relayer role. With payouts enabled it sent the release 3.8 seconds after starting and it was confirmed 1.1 seconds later.
- Costs: float deploy 0.0000129 ETH, deposit-contract deploy 0.0000033 BTC, payout gas about 0.0000008 ETH.

## Second transfer: through the website with a real wallet

A deposit of 1 mUSDC from an everyday wallet, made through the frontend running locally against the live relayer (after topping the float up to $1.25).

| Step | Transaction |
|---|---|
| Deposit 1 mUSDC (Mezo block 12614156) | `0x7974b2f1b84a1c7117264d1568ffca76e7c35561437331ba05c0d548c910e2c5` |
| Payout of 0.95 USDC (Base) | `0x4c956f091f3358e0eb5dd23780b952b8042b5af114dbbe8251b19d09d5188893` |

- Fee $0.05, payout $0.95, recipient received exactly 0.95 USDC. Treasury now holds 1.8 mUSDC; float 0.30 USDC.
- **Measured end-to-end time: 32 seconds** from the deposit's Mezo block to the payout's Base block. About 27 seconds is the relayer's wait for 5 Mezo blocks; pricing and payout take under 4 seconds. One sample only.
- The frontend refused the same deposit earlier, while the float held only $0.25, with "Not enough liquidity". The low-liquidity surcharge was also visible then (fee $0.06).

## Not measured

- Rebalancing (moving collected funds back out of Mezo and refilling the float).
- The frontend on mobile or with a hardware wallet.
- A relayer restart while a deposit is mid-flight.

## Incidents during setup (for the record)

- A wallet that was first used for testing carried an EIP-7702 delegation that forwarded incoming ETH to a collector address, and its key was being watched by a bot that re-delegated it within seconds of ETH arriving. About 0.00007 ETH was lost. The assets were rescued with a single sponsor-paid transaction. The deploy scripts and the relayer now refuse any delegated account, and the pilot used only fresh keys.
