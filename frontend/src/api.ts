import type { AppConfig, AssetKey, DepositRow, QuoteResp } from "./types.ts";
import { API } from "./constants.ts";

export async function fetchConfig(): Promise<AppConfig> {
  const r = await fetch(`${API}/api/config`);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as AppConfig;
}

export type QuoteResult = { ok: true; quote: QuoteResp } | { ok: false; error: string };

export async function fetchQuote(asset: AssetKey, amount: string, lane: "exit" | "enter" = "exit"): Promise<QuoteResult> {
  try {
    const r = await fetch(`${API}/api/quote?lane=${lane}&asset=${asset}&amount=${encodeURIComponent(amount)}`);
    const body = (await r.json()) as QuoteResp & { error?: string };
    return r.ok ? { ok: true, quote: body } : { ok: false, error: body.error ?? "Could not get a quote." };
  } catch {
    return { ok: false, error: "Could not reach the service. Try again shortly." };
  }
}

export async function fetchDeposit(txHash: string): Promise<DepositRow | undefined> {
  const r = await fetch(`${API}/api/deposit/${txHash}`);
  const body = (await r.json()) as { deposits: DepositRow[] };
  return body.deposits[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches the config, retrying while the service wakes up (a host's free tier can take about a minute to start).
 * `onWaiting` is called once, on the first failure, so the page can say what is happening.
 */
export async function fetchConfigWithRetry(onWaiting: () => void, maxWaitMs = 100_000): Promise<AppConfig> {
  const deadline = Date.now() + maxWaitMs;
  let told = false;
  for (;;) {
    try {
      return await fetchConfig();
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      if (!told) {
        told = true;
        onWaiting();
      }
      await sleep(4000);
    }
  }
}
