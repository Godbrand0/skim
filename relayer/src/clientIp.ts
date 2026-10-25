import type { IncomingHttpHeaders } from "node:http";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/**
 * The address to rate-limit a request by. Behind a hosting proxy the socket address is the proxy's, so every user
 * would share one limit. With `trustProxy` we prefer the headers the platform sets: Cloudflare's, then the last entry
 * of X-Forwarded-For (the one the nearest proxy appended). This is only a courtesy limit and a determined client can
 * still vary it, so it must never guard anything that matters.
 */
export function clientIp(headers: IncomingHttpHeaders, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = first(headers["cf-connecting-ip"]);
    if (cf) return cf;
    const tci = first(headers["true-client-ip"]);
    if (tci) return tci;
    const xff = first(headers["x-forwarded-for"]);
    if (xff) {
      const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return socketAddress ?? "unknown";
}
