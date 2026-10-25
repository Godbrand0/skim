# Deploying on Render (free plan)

Two services from one repository, described by `render.yaml`:

| Service | Type | What it is |
|---|---|---|
| `skim-relayer` | Web service, **free** | The relayer and its API |
| `skim-app` | Static site, free | The website and docs page |

## Read this first: what the free plan does to a payout service

From Render's own documentation:

- A free web service **sleeps after 15 minutes without incoming requests**, and takes about a minute to wake. While it sleeps, nothing is watching for deposits.
- It has **no persistent disk**. The relayer's database is wiped on every sleep, restart and redeploy.
- Render **may restart it at any time**, and each workspace gets 750 free instance hours a month.

What that means in practice:

| Situation | What happens |
|---|---|
| A visitor opens the website | The first call wakes the relayer (about a minute). The page says "Starting the service…" and waits. |
| A user deposits through the website | The page polls the relayer every 3 seconds, which keeps it awake until the payout lands. |
| A user deposits and closes the page, or deposits directly on-chain | If the relayer is asleep, the deposit waits until something wakes it. It is **not lost**. |
| The database is wiped | On restart the relayer re-reads recent deposits from the chain (`LOOKBACK_HOURS`). It checks the contract before paying, so it **cannot pay twice**. Only old statistics are lost. |
| Render restarts the relayer mid-payout | A second attempt is rejected by the contract. The result is a wasted fee of a fraction of a cent, never a double payment. |

All of this was tested, including a wiped-database restart with all four old deposits re-read and nothing paid twice. But the free plan means **delays, not lost money**. It suits a demo or a pilot, not real users. See "Moving to a paid plan" at the end.

## Before you start

- [ ] The code is pushed to your GitHub repository (Render deploys from it).
- [ ] You have the relayer's private key (the one in your local `relayer/.env`). It only controls a few cents of gas and the `release` role.
- [ ] A Render account, connected to GitHub with access to the `skim` repository. Render's GitHub app asks which repositories it may read, so allow this one.

## Steps

### 1. Create the services from the Blueprint

In Render: **New**, then **Blueprint**, then pick the `skim` repository. Render reads `render.yaml` and lists the two services. It will ask for the values that aren't stored in the file:

| Variable | Service | Enter |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | skim-relayer | the relayer's private key |
| `ENABLE_PAYOUTS` | skim-relayer | `false` for now. You turn it on in step 5, after a dry run. |
| `CORS_ORIGIN` | skim-relayer | `https://example.com` for now. You fix it in step 3. |
| `VITE_API_URL` | skim-app | `https://example.com` for now. You fix it in step 3. |

Paste the key only into Render's field. Never put it in the repository or in chat.

Everything else (the chains, the live contract addresses, the float target, `NODE_VERSION=24`, the proxy and look-back settings) is already in `render.yaml`. The addresses in it are public.

### 2. Wait for the first deploy

The relayer's build is `npm ci` and its start command is `npm start`. Watch the logs. A healthy start prints:

```
payouts DISABLED (simulation only). Set ENABLE_PAYOUTS=true to send. Lanes: exit
API listening on 0.0.0.0:10000
```

If it exits with "Missing required env var" or "No contract code", an address in `render.yaml` is wrong. If it says the relayer is an "EIP-7702 delegated account", the key is not a plain account and must be replaced.

### 3. Point the two services at each other

Each service gets an address like `https://skim-relayer.onrender.com` (yours may have a suffix). Then:

1. On `skim-app`, set `VITE_API_URL` to the **relayer's** address (no trailing slash) and let it redeploy.
2. On `skim-relayer`, set `CORS_ORIGIN` to the **website's** exact address (for example `https://skim-app.onrender.com`) and let it restart.

### 4. Check it

```shell
curl https://<relayer address>/healthz            # ok
curl https://<relayer address>/api/health         # float balance, lanes, relayer gas
curl "https://<relayer address>/api/quote?asset=musdc&amount=1" # a quote
```

Open the website. If the relayer was asleep it shows "Starting the service…" for up to a minute, then loads. Make a small deposit and look for `payouts disabled (simulation ok)` in the relayer's log and `waiting` in the tracker. That proves the whole path without sending money.

### 5. Turn payouts on

Set `ENABLE_PAYOUTS` to `true` on `skim-relayer`. It restarts and prints `payouts ENABLED, relayer 0x2A2f...`. Check that the address matches the relayer you expect. The waiting deposit is paid within seconds.

### 6. Optional: keep the relayer awake

A free uptime monitor (for example UptimeRobot) that requests `https://<relayer address>/healthz` every 5 minutes keeps the relayer from sleeping. `/healthz` makes no chain calls, so it costs nothing in RPC use.

Caveats: this uses about 744 of your 750 free hours in a 31-day month, and those hours are shared with any other free service in the workspace. Render can still restart the service at any time, and nothing here is guaranteed. If Render objects to this use, stop doing it.

### 7. Adding the reverse direction later

After the reverse-direction pilot (`docs/PILOT_ENTER.md`), add these to `skim-relayer` in the dashboard (not in `render.yaml`, so they can be changed without a Blueprint sync):

```
ENTER_DEPOSIT_ADDRESS, ENTER_DEPOSIT_START_BLOCK, ENTER_FLOAT_ADDRESS, ENTER_FLOAT_TARGET_MICRO, BASE_TREASURY_ADDRESS
```

The relayer's wallet also needs a little BTC on Mezo to pay for those payouts.

## Things to know

- **Use better RPC URLs for anything real.** The public ones in `render.yaml` rate-limit. Replace `MEZO_RPC_URL` and `BASE_RPC_URL` in the dashboard with private ones.
- **The hot key lives in Render's environment.** Keep its gas small, give it only the relayer role (it can't withdraw), and if it leaks, revoke the role from the admin and replace it.
- **Monitor stats reset** after a wipe, because they are built from the database. The chain is unaffected.
- **A deposit made while the relayer sleeps** is picked up on wake if it's within `LOOKBACK_HOURS` (48). Anything older needs `DEPOSIT_START_BLOCK` moved earlier by hand.
- **Redeploys cost a few seconds of downtime.**

## Moving to a paid plan

When this carries real users, change `plan: free` to a paid instance in `render.yaml` (or the dashboard). That removes the sleeping, and a disk can then be attached:

1. Add a disk (for example mount path `/var/data`, 1 GB).
2. Set `DB_PATH=/var/data/relayer.sqlite`.
3. Set `LOOKBACK_HOURS=0` so a restart continues from its saved position.

A service with a disk can't run more than one instance, which is what we want.
