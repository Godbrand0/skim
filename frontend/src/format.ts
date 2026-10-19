import { formatUnits, parseUnits } from "viem";
import type { AssetCfg } from "./types.ts";
import { WEI_PER_SAT } from "./constants.ts";

/** Format base units, truncating (never rounding up) to at most `maxFrac` decimals. */
export function fmt(value: bigint, decimals: number, maxFrac: number): string {
  const [whole, frac = ""] = formatUnits(value, decimals).split(".");
  const f = frac.slice(0, maxFrac).replace(/0+$/, "");
  const w = BigInt(whole).toLocaleString("en-US");
  return f ? `${w}.${f}` : w;
}

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Balance as shown next to a token: sats for BTC, whole-token units otherwise. */
export function fmtBalance(a: AssetCfg, value: bigint): string {
  return a.key === "btc" ? (value / WEI_PER_SAT).toLocaleString("en-US") : fmt(value, a.decimals, 4);
}

/** Parse the amount text into base units, or undefined when it is empty or invalid. */
export function parseAmount(a: AssetCfg, text: string): bigint | undefined {
  const v = text.trim();
  if (!v) return undefined;
  try {
    if (a.key === "btc") {
      if (!/^\d+$/.test(v)) return undefined; // whole sats only
      const n = BigInt(v) * WEI_PER_SAT;
      return n > 0n ? n : undefined;
    }
    if (!/^\d*\.?\d+$/.test(v) && !/^\d+\.$/.test(v)) return undefined;
    const dec = v.split(".")[1];
    if (dec && dec.length > a.decimals) return undefined;
    const n = parseUnits(v.endsWith(".") ? v.slice(0, -1) : v, a.decimals);
    return n > 0n ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Display metadata for tokens. Colors are tuned to stay legible on both themes. */
export const TOKEN_STYLE: Record<string, { label: string; glyph: string; cls: string; name: string }> = {
  musdc: { label: "mUSDC", glyph: "$", cls: "t-usdc", name: "Mezo Circle USDC" },
  musd: { label: "MUSD", glyph: "M", cls: "t-musd", name: "Mezo USD" },
  btc: { label: "BTC", glyph: "₿", cls: "t-btc", name: "Bitcoin (sats)" },
  usdc: { label: "USDC", glyph: "$", cls: "t-usdc", name: "USD Coin" },
};
