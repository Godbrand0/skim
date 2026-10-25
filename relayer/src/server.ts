import http from "node:http";
import { formatUnits } from "viem";
import type { Address } from "viem";
import { depositAbi } from "./abi.ts";
import type { Config, Lane } from "./config.ts";
import { BASE_USDC, CHAIN_IDS, MUSD, MUSDC, NATIVE, laneById } from "./config.ts";
import { clientFor, readBtcUsd18, readFloatState } from "./chain.ts";
import type { Clients } from "./chain.ts";
import type { Store, DepositRow } from "./db.ts";
import { formatMicro, parseDecimal, quote, satsToWei, weiToSats } from "./pricing.ts";
import type { Asset } from "./pricing.ts";
import { metaKey } from "./processor.ts";
import { clientIp } from "./clientIp.ts";

interface AssetInfo {
  key: Asset;
  symbol: string;
  decimals: number;
  address: Address;
  /** For BTC the UI works in sats; otherwise in whole tokens. */
  unit: string;
}
const EXIT_ASSETS: AssetInfo[] = [
  { key: "musdc", symbol: "mUSDC", decimals: 6, address: MUSDC, unit: "mUSDC" },
  { key: "musd", symbol: "MUSD", decimals: 18, address: MUSD, unit: "MUSD" },
  { key: "btc", symbol: "BTC", decimals: 18, address: NATIVE, unit: "sats" },
];
const ENTER_ASSETS: AssetInfo[] = [{ key: "usdc", symbol: "USDC", decimals: 6, address: BASE_USDC, unit: "USDC" }];
const assetsFor = (lane: Lane): AssetInfo[] => (lane.id === "exit" ? EXIT_ASSETS : ENTER_ASSETS);
/** What the user receives on each lane. */
const PAYOUT_TOKEN: Record<Lane["id"], string> = { exit: "USDC", enter: "mUSDC" };

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

function json(res: http.ServerResponse, status: number, body: unknown, origin: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function publicRow(r: DepositRow) {
  return {
    id: r.id,
    lane: r.lane,
    nonce: r.nonce,
    asset: r.asset,
    amount: r.amount,
    recipient: r.recipient,
    status: r.status,
    payoutUsdc: r.payout_micro ? formatMicro(BigInt(r.payout_micro)) : null,
    payoutToken: PAYOUT_TOKEN[r.lane as Lane["id"]] ?? "USDC",
    feeUsdc: r.fee_micro ? formatMicro(BigInt(r.fee_micro)) : null,
    releaseTx: r.release_tx,
    note: r.status === "manual_review" || r.status === "waiting" ? r.note : null,
    updatedAt: r.updated_at,
  };
}

type TokenCfg = Record<string, { enabled: boolean; min: bigint; max: bigint }>;

export function startServer(cfg: Config, c: Clients, store: Store): http.Server {
  // tiny in-memory per-IP rate limit
  const hits = new Map<string, { n: number; reset: number }>();
  const limited = (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now > h.reset) {
      if (hits.size > 5000) hits.clear(); // bounded memory, even if a client invents addresses
      hits.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    h.n++;
    return h.n > 90;
  };

  const tokenCache = new Map<string, { at: number; value: TokenCfg }>();
  async function tokenConfigs(lane: Lane): Promise<TokenCfg> {
    const cached = tokenCache.get(lane.id);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const value: TokenCfg = {};
    for (const a of assetsFor(lane)) {
      const [enabled, min, max] = await clientFor(c, lane.src).readContract({ address: lane.depositAddress, abi: depositAbi, functionName: "tokenConfig", args: [a.address] });
      value[a.key] = { enabled, min, max };
    }
    tokenCache.set(lane.id, { at: Date.now(), value });
    return value;
  }

  let priceCache: { at: number; value?: bigint; err?: string } | undefined;
  async function btcPrice(): Promise<{ value?: bigint; err?: string }> {
    if (priceCache && Date.now() - priceCache.at < 15_000) return priceCache;
    try {
      priceCache = { at: Date.now(), value: await readBtcUsd18(c, cfg.oracleMaxAgeSec) };
    } catch (e) {
      priceCache = { at: Date.now(), err: (e as Error).message };
    }
    return priceCache;
  }

  const floatOf = (lane: Lane) => readFloatState(clientFor(c, lane.dst), lane.floatAddress);

  const server = http.createServer(async (req, res) => {
    const origin = cfg.corsOrigin;
    try {
      if (req.method === "OPTIONS") return json(res, 204, {}, origin);
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, origin);

      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // Cheap liveness check with no chain calls, for the host's health check and uptime pings.
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        return void res.end("ok");
      }

      if (limited(clientIp(req.headers, req.socket.remoteAddress, cfg.trustProxy))) return json(res, 429, { error: "rate limited" }, origin);
      const exit = laneById(cfg, "exit")!;
      const enter = laneById(cfg, "enter");

      if (path === "/api/health") {
        const lanes: Record<string, unknown> = {};
        for (const lane of cfg.lanes) {
          const fs = await floatOf(lane);
          lanes[lane.id] = {
            floatBalance: formatMicro(fs.balanceMicro),
            floatPaused: fs.paused,
            sourceHead: store.getMeta(metaKey(lane, "head_block")) ?? null,
            lastProcessedBlock: store.getMeta(metaKey(lane, "last_block")) ?? null,
            lastIngestAt: Number(store.getMeta(metaKey(lane, "last_ingest_at")) ?? 0),
            counts: store.counts(lane.id),
          };
        }
        const exitFs = await floatOf(exit);
        let relayerGas: Record<string, string> | undefined;
        if (c.account) {
          const [btc, eth] = await Promise.all([c.mezoClient.getBalance({ address: c.account.address }), c.baseClient.getBalance({ address: c.account.address })]);
          relayerGas = { mezoBtc: formatUnits(btc, 18), baseEth: formatUnits(eth, 18) };
        }
        return json(res, 200, {
          ok: true,
          payoutsEnabled: cfg.enablePayouts,
          // top-level fields describe the exit lane, as before
          floatUsdc: formatMicro(exitFs.balanceMicro),
          floatPaused: exitFs.paused,
          mezoHead: store.getMeta("head_block") ?? null,
          lastProcessedBlock: store.getMeta("last_block") ?? null,
          lastIngestAt: Number(store.getMeta("last_ingest_at") ?? 0),
          counts: store.counts(),
          lanes,
          relayerGas,
        }, origin);
      }

      if (path === "/api/config") {
        const [tc, fs, price] = await Promise.all([tokenConfigs(exit), floatOf(exit), btcPrice()]);
        let enterCfg: unknown;
        if (enter) {
          const [etc, efs] = await Promise.all([tokenConfigs(enter), floatOf(enter)]);
          const a = ENTER_ASSETS[0];
          const t = etc[a.key];
          enterCfg = {
            chains: { source: CHAIN_IDS.base, destination: CHAIN_IDS.mezo },
            contracts: { deposit: enter.depositAddress, float: enter.floatAddress },
            asset: { key: a.key, symbol: a.symbol, decimals: a.decimals, address: a.address, unit: a.unit, enabled: t.enabled, min: formatUnits(t.min, a.decimals), max: formatUnits(t.max, a.decimals) },
            payoutToken: PAYOUT_TOKEN.enter,
            floatAvailable: formatMicro(efs.balanceMicro),
            maxPayout: formatMicro(efs.maxPerTx),
            paused: efs.paused,
          };
        }
        return json(res, 200, {
          chains: { mezo: CHAIN_IDS.mezo, base: CHAIN_IDS.base },
          contracts: { deposit: exit.depositAddress, float: exit.floatAddress },
          assets: EXIT_ASSETS.map((a) => {
            const t = tc[a.key];
            const toUnit = (v: bigint) => (a.key === "btc" ? weiToSats(v).toString() : formatUnits(v, a.decimals));
            return { key: a.key, symbol: a.symbol, decimals: a.decimals, address: a.address, unit: a.unit, enabled: t.enabled, min: toUnit(t.min), max: toUnit(t.max) };
          }),
          fee: { percent: Number(cfg.pricing.feeBps) / 100, floorUsdc: formatMicro(cfg.pricing.feeFloorMicro) },
          floatAvailableUsdc: formatMicro(fs.balanceMicro),
          maxPayoutUsdc: formatMicro(fs.maxPerTx),
          paused: fs.paused,
          btcUsd: price.value !== undefined ? formatUnits(price.value, 18) : null,
          enter: enterCfg,
        }, origin);
      }

      if (path === "/api/quote") {
        const laneId = (url.searchParams.get("lane") ?? "exit") as Lane["id"];
        const lane = laneById(cfg, laneId);
        if (!lane) return json(res, 400, { error: "unknown lane" }, origin);
        const key = url.searchParams.get("asset") as Asset | null;
        const amountStr = url.searchParams.get("amount") ?? "";
        const info = assetsFor(lane).find((a) => a.key === key);
        if (!info) return json(res, 400, { error: "unknown asset" }, origin);

        let amount: bigint;
        try {
          amount = info.key === "btc" ? satsToWei(parseDecimal(amountStr, 0)) : parseDecimal(amountStr, info.decimals);
        } catch {
          return json(res, 400, { error: "invalid amount" }, origin);
        }

        const [tc, fs, price] = await Promise.all([tokenConfigs(lane), floatOf(lane), info.key === "btc" ? btcPrice() : Promise.resolve({} as { value?: bigint })]);
        const t = tc[info.key];
        const reasons: string[] = [];
        if (!t.enabled) reasons.push("This asset is not enabled right now.");
        if (amount < t.min) reasons.push("Amount is below the minimum.");
        if (amount > t.max) reasons.push("Amount is above the maximum.");
        if (info.key === "btc" && price.value === undefined) reasons.push("BTC price is temporarily unavailable.");

        const q = quote(info.key, amount, price.value, fs.balanceMicro, { ...cfg.pricing, floatTargetMicro: lane.floatTargetMicro });
        if (q.payoutMicro < cfg.minPayoutMicro) reasons.push("Amount is too small after fees.");
        if (q.payoutMicro > fs.maxPerTx) reasons.push("Amount is above the per-payout limit.");
        if (fs.paused) reasons.push("Payouts are paused.");
        if (q.payoutMicro > fs.balanceMicro) reasons.push("Not enough liquidity right now. Try a smaller amount later.");

        return json(res, 200, {
          lane: lane.id,
          asset: info.key,
          grossUsdc: formatMicro(q.grossMicro),
          feeUsdc: formatMicro(q.feeMicro),
          payoutUsdc: formatMicro(q.payoutMicro),
          payoutToken: PAYOUT_TOKEN[lane.id],
          surchargeApplied: q.surchargeApplied,
          canFulfill: reasons.length === 0,
          reasons,
          note: "Estimate. The final amount is set when your deposit is confirmed.",
        }, origin);
      }

      const m = path.match(/^\/api\/deposit\/(0x[0-9a-fA-F]+)$/);
      if (m) {
        if (!TX_RE.test(m[1])) return json(res, 400, { error: "invalid transaction hash" }, origin);
        const rows = store.byTx(m[1]);
        return json(res, 200, { deposits: rows.map(publicRow), indexed: rows.length > 0 }, origin);
      }

      return json(res, 404, { error: "not found" }, origin);
    } catch (e) {
      console.error(new Date().toISOString(), "request error", (e as Error).message);
      return json(res, 500, { error: "internal error" }, origin);
    }
  });
  server.listen(cfg.port, cfg.host, () => console.log(`API listening on ${cfg.host}:${cfg.port}`));
  return server;
}
