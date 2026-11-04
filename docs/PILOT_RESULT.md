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

## MUSD on mainnet (1 November 2026)

New contracts on Mezo, deployed by the admin in blocks 12919612 to 12919614 (total cost 0.0000098 BTC):

| Contract | Address |
|---|---|
| MusdPegGuard | `0x4891b3f06C3b9AA33C6DBFa45CacD3C5922Ef17A` |
| MezoDeposit (with peg guard) | `0xBc627912d5bed789052F81Cbe626b683905feC36` |
| MezoRebalancer | `0x693c0afE4f72F628C904E67eF0c3531FeAa0f4fb` |

The guard reads the MUSD/mUSDC pool, the MUSD/mUSDT pool, and the BTC/MUSD pool against the MUSD protocol's PriceFeed (`0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88`). Setup: MUSD enabled at 0.5 to 3 (block 12919742), guard attached (block 12919745).

| Step | Transaction |
|---|---|
| Route 3 (mUSDC to MUSD, rebalancer): 1.1 mUSDC in, 1.108861 MUSD out | `0xd5798ee511f96f4aa9d95e8b75ad4efc2eec9d95595ef26bf988f6d4396356ac` |
| Deposit 1 MUSD (Mezo block 12920204) | `0x358b2e9099020d542274fcdd8d6e44baa0f055b04fbe80651d1943391fccf077` |
| Payout of 0.94 USDC (Base block 53368820) | `0x3f037a7127e79b5310122f1a0ba61596c0f6beae6518e4178156b5fa5a8e0586` |
| Route 0 (MUSD to mUSDC, rebalancer): 1 MUSD in, 0.991582 mUSDC out (Mezo block 12920288) | `0xe962b0dd651880064da0beaa274b1ad9a82b13396cdceb33c6e9596955597495` |

- Peg guard at deposit time: mUSDC pool 0.9915, mUSDT pool 0.9979, protocol cross-check 0.9987. The relayer valued 1 MUSD at $0.99 (the pool price, capped at 0.99), fee $0.05, payout $0.94, which matched the quote.
- The relayer sent the payout 4 seconds after starting with payouts enabled. Float 3.35 to 2.41 USDC.
- The rebalancer held nothing before or after either swap.
- Local fork test beforehand: routes 0, 2 and 3, keeper-only, per-route cap, and the depeg block all behaved as designed.

Not tested on mainnet: all BTC routes, the mUSDT route, the gas-pack lane.

## mUSDC on the new deposit contract, and the reverse lane (1 and 2 November 2026)

mUSDC was enabled on the new Mezo `MezoDeposit` (0.5 to 3, block 12920715, tx `0x1ea15c4aa3d5c092b7e55e42ad8961646046708b4aaa85964738efc36c49db27`).

The reverse direction (USDC on Base to mUSDC on Mezo) was deployed with the same two contracts, mirrored:

| Contract | Network | Address |
|---|---|---|
| MezoDeposit (USDC only, 0.5 to 2 per deposit) | Base | `0xF49aFA56d6A31420856946B763b5FB8428483467` (block 53369965) |
| MezoFloat (mUSDC, $1 per payout, $2 per day) | Mezo | `0x4c28bCd5DCaDc47263354b2f37A8aA2f7E57Bc4B` (block 12920910) |

The Mezo float was funded with 1 mUSDC from the treasury (tx `0xf80bcf0c3e6bc9f8b68395887df7770174a082bd57585c3b8275704bacd2625c`).

| Step | Transaction |
|---|---|
| Deposit 0.7 USDC on Base (block 53406594) | `0x271b15224809cedce6be968eeaad77994d0be8df88e4a99012b375b9a1f191b7` |
| Payout of 0.65 mUSDC on Mezo (block 12941296) | `0x5072971eb04e090e6bb10dd3e84d7d5bdbdd3138532f320e9e054ba38d9e6c7a` |

- Fee $0.05, payout 0.65 mUSDC, matching the quote. Mezo float 1.00 to 0.35 mUSDC. The Base treasury collected the 0.7 USDC.
- A 0.5 USDC deposit would pay only 0.45 after the fee floor, below the relayer's $0.50 minimum payout, so it would be held for review. The practical minimum deposit is 0.55 USDC.
- Two RPC problems came up and were fixed: the public Base RPC (`mainnet.base.org`) returned HTTP 429 on log queries, so the relayer now uses `base-rpc.publicnode.com`; and the Mezo RPC host `mainnet.mezo.public.validationcloud.io` stopped resolving, so everything now uses `rpc-http.mezo.boar.network`. The deposit waited in the `waiting` state and was paid on its own once the RPC was changed.

## MUSD exit through the website (3 November 2026)

A second MUSD exit, made from the website with a browser wallet (not from `cast`), against the final deployed contracts.

| Step | Transaction |
|---|---|
| Deposit 1 MUSD on Mezo (block 12968419) | [`0xbe14fda8b2895fc4bd3d60c9be0bfadd5c4d97acb28c1ec06b2531fe51a2364b`](https://explorer.mezo.org/tx/0xbe14fda8b2895fc4bd3d60c9be0bfadd5c4d97acb28c1ec06b2531fe51a2364b) |
| Payout of 0.9396 USDC on Base (block 53455483) | [`0xaa05ca14e68b01cd04681e7b6b2dd4baa064e58fea0d2c49e1b335b901b0ad2b`](https://basescan.org/tx/0xaa05ca14e68b01cd04681e7b6b2dd4baa064e58fea0d2c49e1b335b901b0ad2b) |

- Checked on-chain: the deposit moved exactly 1 MUSD (1e18) into the new `MezoDeposit` and emitted its Deposit event. The Base payout was 939600 micro-USDC from the float to the recipient, sent by the relayer.
- 1 MUSD was valued at the live pool price (about $0.9896, below the $0.99 cap), less the $0.05 fee floor, giving $0.9396. This is the pool-price valuation working as designed: the payout follows what MUSD actually sells for rather than a fixed $1.

## USDC on Base to MUSD on Mezo, and automatic float refills: deployment (3 November 2026)

New contracts, all with the existing admin, guardian and relayer keys:

| Contract | Network | Address | Deploy tx |
|---|---|---|---|
| MezoFloat (MUSD, 1 MUSD per payout, 2 per day) | Mezo | `0xb8558A04475e87057e5F8B596A1b4c076a8B6614` (block 12969087) | `0x86a7e01dc3f87c0b6b0d55f5acef66f743da900d25fcb9214c1825e979eb3ae6` |
| MezoDeposit (USDC only, 0.5 to 2) | Base | `0x4c28bCd5DCaDc47263354b2f37A8aA2f7E57Bc4B` (block 53456708) | `0x77b7aff456dccddf2ca56cd3db157a3c0e861af6383059c9ea45e3a8e18c2886` |
| MezoFloatRefiller | Mezo | `0x7B0118a6cc78512B210dBC4d7eA86a84857f140C` (block 12978941, verified on explorer.mezo.org) | `0x3983ef513d09ae8592e5341d0c7840832bb36dfd9e3d1845015353bdfd958cae` |

- USDC enabled on the new Base deposit (0.5 to 2): `0x5ac78c086699c7ca7b0f1e7bec18700cfced6acef8500c13d07d3de63f7f3851`.
- The refiller lists the mUSDC float and the MUSD float (caps 5 per call): `0xe7bd87dc94ef20f2303c46a0fd43b1e2976687705ece1ef967fc01f0c4fe69fd`, `0x4a03876b4b4947de713a9f60d40a260d8c11f48d357766792d79e683b0aa651f`.
- The MUSD float was funded by the keeper buying MUSD with 1.1 mUSDC through the rebalancer's route 3 (1.111042 MUSD, tx `0x4f185bc138dc7903b59403a4d06c93a51882484627784eef4bf660a9d7cbb6c9`) and the treasury moving it into the float (tx `0x4a8de87dbf81cba0b3e755782c7655f80f7aa445691803c17f57d3a9ea16c6f9`).
- Treasury approvals: mUSDC and MUSD to the refiller (`0xe55f9ab2…c671b`, `0x003ebc0d…b776`), mUSDC to the rebalancer (`0xe69da849…f5861a`).
- The relayer now runs four jobs: the exit lane, the enter lane (mUSDC), the MUSD lane, and a 10-minute timer that refills the Mezo floats from the treasury and then rebalances.

The first automatic refill is recorded in the next section. The refill logic was also tested on a fork of Mezo mainnet.

### USDC on Base to MUSD on Mezo: first mainnet deposit

| Step | Transaction |
|---|---|
| Deposit 0.7 USDC on Base (block 53474876) | [`0x234756847b1cd6657f2beef45a7ba71fa9383c45c85b5caae48650ba292537ca`](https://basescan.org/tx/0x234756847b1cd6657f2beef45a7ba71fa9383c45c85b5caae48650ba292537ca) |
| Payout of 0.657296 MUSD on Mezo (block 12979182) | [`0xe87e6c29d3f2f5acb616f4cee83cf0770df89b3ccc7340c660cf5404dc8d37e3`](https://explorer.mezo.org/tx/0xe87e6c29d3f2f5acb616f4cee83cf0770df89b3ccc7340c660cf5404dc8d37e3) |

- Checked on-chain: the deposit moved exactly 700000 micro-USDC from the sender to the Base treasury and emitted its Deposit event (nonce 0 on the new contract). The Mezo payout was 657295985438365861 wei of MUSD from the MUSD float to the same address, sent by the relayer. The MUSD float went from 1.111042 to 0.453746.
- $0.70 less the $0.05 fee is $0.65. The relayer sized the payout at the MUSD/mUSDC pool's price at that moment, about $0.9889, so the user received 0.657296 MUSD for $0.65 of value (the quote a few minutes earlier, at a pool price of $0.9896, was 0.656831). The peg guard was healthy.
- This is the first MUSD payout on Mezo; together with the 1 MUSD exit it means MUSD moves in both directions on mainnet.

## First automatic float refill (3 November 2026)

After the 0.7 USDC deposit above, the MUSD float held 0.453746 MUSD, less than one maximum payout (1 MUSD), so any further deposit would have had to wait. The treasury was topped up with mUSDC (to 1.59 mUSDC, no MUSD) and on its next 10-minute tick the relayer, with no manual step:

| Step | Transaction |
|---|---|
| Bought MUSD for the shortfall: 0.546254 mUSDC in, 0.552143 MUSD out, through the MUSD/mUSDC pool (rebalancer route 3, block 12979407) | [`0x10846c92bc3799608ea6117bbc282c0527628c2c41842a53ea03a2230d1796aa`](https://explorer.mezo.org/tx/0x10846c92bc3799608ea6117bbc282c0527628c2c41842a53ea03a2230d1796aa) |
| Refilled the MUSD float with 0.546253 MUSD through the refiller (block 12979409) | [`0x4d7acdcfd0bbb1b7647c5786697a5112ec644ed564dfb18acac9fa5ab0dce789`](https://explorer.mezo.org/tx/0x4d7acdcfd0bbb1b7647c5786697a5112ec644ed564dfb18acac9fa5ab0dce789) |

- Checked on-chain: both transactions were sent by the relayer (keeper) address. The MUSD float is exactly 1.0 MUSD, its target. The rebalancer and the refiller both hold nothing.
- The relayer bought only what the float needed, since the treasury had no MUSD, and left the rest of the treasury's mUSDC (1.04) alone.
- A gap found and fixed on the way: a float is now also treated as low when it cannot cover one maximum payout, not only below 30% of its target. Before, a float of 0.45 MUSD sat above its 0.3 low level, but a deposit needing about 0.5 MUSD would have waited with nothing to trigger a refill.
