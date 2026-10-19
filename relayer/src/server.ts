import http from "node:http";
import { formatUnits } from "viem";
import type { Address } from "viem";
import { depositAbi } from "./abi.ts";
import type { Config } from "./config.ts";
import { MUSD, MUSDC, NATIVE } from "./config.ts";
import { readBtcUsd18, readFloatState } from "./chain.ts";
import type { Clients } from "./chain.ts";
import type { Store, DepositRow } from "./db.ts";
import { formatMicro, parseDecimal, quote, satsToWei, weiToSats } from "./pricing.ts";
import type { Asset } from "./pricing.ts";

interface AssetInfo {
  key: Asset;
  symbol: string;
  decimals: number;
  address: Address;
  /** For BTC the UI works in sats; otherwise in whole tokens. */
  unit: string;
}
const ASSETS: AssetInfo[] = [
  { key: "musdc", symbol: "mUSDC", decimals: 6, address: MUSDC, unit: "mUSDC" },
  { key: "musd", symbol: "MUSD", decimals: 18, address: MUSD, unit: "MUSD" },
  { key: "btc", symbol: "BTC", decimals: 18, address: NATIVE, unit: "sats" },
];

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
    nonce: r.nonce,
    asset: r.asset,
    amount: r.amount,
    recipient: r.recipient,
    status: r.status,
    payoutUsdc: r.payout_micro ? formatMicro(BigInt(r.payout_micro)) : null,
    feeUsdc: r.fee_micro ? formatMicro(BigInt(r.fee_micro)) : null,
    releaseTx: r.release_tx,
    note: r.status === "manual_review" || r.status === "waiting" ? r.note : null,
    updatedAt: r.updated_at,
  };
}

export function startServer(cfg: Config, c: Clients, store: Store): http.Server {
  // tiny in-memory per-IP rate limit
  const hits = new Map<string, { n: number; reset: number }>();
  const limited = (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now > h.reset) {
      hits.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    h.n++;
    return h.n > 90;
  };

  let tokenCfgCache: { at: number; value: Record<string, { enabled: boolean; min: bigint; max: bigint }> } | undefined;
  async function tokenConfigs() {
    if (tokenCfgCache && Date.now() - tokenCfgCache.at < 30_000) return tokenCfgCache.value;
    const value: Record<string, { enabled: boolean; min: bigint; max: bigint }> = {};
    for (const a of ASSETS) {
      const [enabled, min, max] = await c.mezoClient.readContract({ address: cfg.depositAddress, abi: depositAbi, functionName: "tokenConfig", args: [a.address] });
      value[a.key] = { enabled, min, max };
    }
    tokenCfgCache = { at: Date.now(), value };
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

  const server = http.createServer(async (req, res) => {
    const origin = cfg.corsOrigin;
    try {
      if (req.method === "OPTIONS") return json(res, 204, {}, origin);
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, origin);
      const ip = req.socket.remoteAddress ?? "unknown";
      if (limited(ip)) return json(res, 429, { error: "rate limited" }, origin);

      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/api/health") {
        const fs = await readFloatState(c, cfg.floatAddress);
        const head = store.getMeta("head_block");
        const last = store.getMeta("last_block");
        return json(res, 200, {
          ok: true,
          payoutsEnabled: cfg.enablePayouts,
          floatUsdc: formatMicro(fs.balanceMicro),
          floatPaused: fs.paused,
          mezoHead: head ?? null,
          lastProcessedBlock: last ?? null,
          lastIngestAt: Number(store.getMeta("last_ingest_at") ?? 0),
          counts: store.counts(),
        }, origin);
      }

      if (path === "/api/config") {
        const [tc, fs, price] = await Promise.all([tokenConfigs(), readFloatState(c, cfg.floatAddress), btcPrice()]);
        return json(res, 200, {
          chains: { mezo: 31612, base: 8453 },
          contracts: { deposit: cfg.depositAddress, float: cfg.floatAddress },
          assets: ASSETS.map((a) => {
            const t = tc[a.key];
            const toUnit = (v: bigint) => (a.key === "btc" ? weiToSats(v).toString() : formatUnits(v, a.decimals));
            return { key: a.key, symbol: a.symbol, decimals: a.decimals, address: a.address, unit: a.unit, enabled: t.enabled, min: toUnit(t.min), max: toUnit(t.max) };
          }),
          fee: { percent: Number(cfg.pricing.feeBps) / 100, floorUsdc: formatMicro(cfg.pricing.feeFloorMicro) },
          floatAvailableUsdc: formatMicro(fs.balanceMicro),
          maxPayoutUsdc: formatMicro(fs.maxPerTx),
          paused: fs.paused,
          btcUsd: price.value !== undefined ? formatUnits(price.value, 18) : null,
        }, origin);
      }

      if (path === "/api/quote") {
        const key = url.searchParams.get("asset") as Asset | null;
        const amountStr = url.searchParams.get("amount") ?? "";
        const info = ASSETS.find((a) => a.key === key);
        if (!info) return json(res, 400, { error: "unknown asset" }, origin);

        let amount: bigint;
        try {
          amount = info.key === "btc" ? satsToWei(parseDecimal(amountStr, 0)) : parseDecimal(amountStr, info.decimals);
        } catch {
          return json(res, 400, { error: "invalid amount" }, origin);
        }

        const [tc, fs, price] = await Promise.all([tokenConfigs(), readFloatState(c, cfg.floatAddress), btcPrice()]);
        const t = tc[info.key];
        const reasons: string[] = [];
        if (!t.enabled) reasons.push("This asset is not enabled right now.");
        if (amount < t.min) reasons.push("Amount is below the minimum.");
        if (amount > t.max) reasons.push("Amount is above the maximum.");
        if (info.key === "btc" && price.value === undefined) reasons.push("BTC price is temporarily unavailable.");

        const q = quote(info.key, amount, price.value, fs.balanceMicro, cfg.pricing);
        if (q.payoutMicro < cfg.minPayoutMicro) reasons.push("Amount is too small after fees.");
        if (q.payoutMicro > fs.maxPerTx) reasons.push("Amount is above the per-payout limit.");
        if (fs.paused) reasons.push("Payouts are paused.");
        if (q.payoutMicro > fs.balanceMicro) reasons.push("Not enough liquidity right now. Try a smaller amount later.");

        return json(res, 200, {
          asset: info.key,
          grossUsdc: formatMicro(q.grossMicro),
          feeUsdc: formatMicro(q.feeMicro),
          payoutUsdc: formatMicro(q.payoutMicro),
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
  server.listen(cfg.port, () => console.log(`API listening on :${cfg.port}`));
  return server;
}
