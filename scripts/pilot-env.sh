# Source this before running the pilot commands:  source scripts/pilot-env.sh
# Addresses only. No keys belong in this file.
export PATH="$HOME/.foundry/bin:$PATH"
export BASE_RPC=https://mainnet.base.org
export MEZO_RPC_URL=https://mainnet.mezo.public.validationcloud.io

export ADMIN=0xf76B047Dfc022c8D106AdfbCC4f948b6Ee56cA61       # keystore: mf-sponsor (admin, deployer, test depositor)
export GUARDIAN=0xF1E4b4C6e6d921144980d510B1213A920Bba72F1     # can only pause
export TREASURY=0x25837EE4525C52BAf917e7DA84eDeE238D14F6c9     # receives the deposited mUSDC on Mezo
export RELAYER=0x2A2f4B9528296AbaC439f66Ab111a691f0BE9376      # release-only hot key (its private key goes in relayer/.env)

# Pilot limits (USDC, 6 decimals): $1 per payout, $1 per address per day, $2 per day
export MAX_PER_TX=1000000 MAX_PER_ADDRESS_PER_DAY=1000000 MAX_GLOBAL_PER_DAY=2000000

export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export MUSDC=0x04671C72Aab5AC02A03c1098314b1BB6B560c197

# Deployed 2026-10-19 on Base (block 52802483)
export FLOAT=0x4891b3f06C3b9AA33C6DBFa45CacD3C5922Ef17A

# Deployed 2026-10-19 on Mezo (block 12613337)
export DEPOSIT=0x7C7ad1bEa23Eea0189e94Ec42D20d3DA604DaDE6
export DEPOSIT_START_BLOCK=12613337

# Reverse direction (fill these in after deploying, see docs/PILOT_ENTER.md)
# export ENTER_DEPOSIT=0x...        # MezoDeposit on Base
# export ENTER_FLOAT=0x...          # MezoFloat (mUSDC) on Mezo
