import type { AppConfig, AssetKey, DepositRow, QuoteResp } from "./types.ts";
import { API } from "./constants.ts";

export async function fetchConfig(): Promise<AppConfig> {
  const r = await fetch(`${API}/api/config`);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as AppConfig;
}

export type QuoteResult = { ok: true; quote: QuoteResp } | { ok: false; error: string };

export async function fetchQuote(asset: AssetKey, amount: string): Promise<QuoteResult> {
  try {
    const r = await fetch(`${API}/api/quote?asset=${asset}&amount=${encodeURIComponent(amount)}`);
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
