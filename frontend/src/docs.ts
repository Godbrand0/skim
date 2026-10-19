import "@fontsource-variable/bricolage-grotesque";
// Live values for the docs page (read from the relayer API) and the table-of-contents highlight.

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:8787";
const MEZO_EXPLORER = "https://explorer.mezo.org";
const BASE_EXPLORER = "https://basescan.org";

interface Asset { key: string; symbol: string; unit: string; enabled: boolean; min: string; max: string }
interface Config {
  contracts: { deposit: string; float: string };
  assets: Asset[];
  fee: { percent: number; floorUsdc: string };
  floatAvailableUsdc: string;
  maxPayoutUsdc: string;
  paused: boolean;
  btcUsd: string | null;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};

const usd2 = (s: string): string => {
  const [w, f = ""] = s.split(".");
  return `$${Number(w).toLocaleString("en-US")}.${f.padEnd(2, "0").slice(0, 2)}`;
};

function row(label: string, value: string): HTMLDivElement {
  const d = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  d.append(dt, dd);
  return d;
}

function addressCell(el: HTMLElement, address: string, explorer: string): void {
  const a = document.createElement("a");
  a.href = `${explorer}/address/${address}`;
  a.textContent = address;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  el.replaceChildren(a);
}

async function loadLive(): Promise<void> {
  const status = $("live-status");
  try {
    const r = await fetch(`${API}/api/config`);
    if (!r.ok) throw new Error(String(r.status));
    const cfg = (await r.json()) as Config;

    const tbody = $("live-assets").querySelector("tbody");
    if (!tbody) return;
    tbody.replaceChildren();
    for (const a of cfg.assets) {
      const tr = document.createElement("tr");
      const cells = [a.key === "btc" ? "BTC (sats)" : a.symbol, `${a.min} ${a.unit}`, `${a.max} ${a.unit}`, a.enabled ? "Enabled" : "Disabled"];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.append(td);
      }
      tbody.append(tr);
    }
    $("live-assets").hidden = false;

    const kv = $("live-kv");
    kv.replaceChildren(
      row("Fee", `${cfg.fee.percent}%, at least ${usd2(cfg.fee.floorUsdc)}`),
      row("Maximum payout per transfer", usd2(cfg.maxPayoutUsdc)),
      row("Liquidity ready on Base", usd2(cfg.floatAvailableUsdc)),
      row("Payouts", cfg.paused ? "Paused" : "Active"),
      ...(cfg.btcUsd ? [row("BTC price used", `$${Number(cfg.btcUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}`)] : []),
    );
    kv.hidden = false;
    status.hidden = true;

    $("fact-fee").textContent = `${cfg.fee.percent}%, at least ${usd2(cfg.fee.floorUsdc)}`;
    addressCell($("addr-deposit"), cfg.contracts.deposit, MEZO_EXPLORER);
    addressCell($("addr-float"), cfg.contracts.float, BASE_EXPLORER);
  } catch {
    status.textContent = "Live values are unavailable right now. The defaults described on this page apply.";
    $("addr-deposit").textContent = "Not available right now";
    $("addr-float").textContent = "Not available right now";
  }
}

// On wide screens the contents list is always open; on narrow screens it starts collapsed.
const toc = document.getElementById("toc-details") as HTMLDetailsElement | null;
if (toc && window.matchMedia("(max-width: 959px)").matches) toc.open = false;

// Highlight the section that is currently in view.
const links = new Map<string, HTMLAnchorElement>();
document.querySelectorAll<HTMLAnchorElement>("#toc-list a").forEach((a) => links.set(a.hash.slice(1), a));
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        links.forEach((a) => a.removeAttribute("aria-current"));
        links.get(e.target.id)?.setAttribute("aria-current", "true");
      }
    }
  },
  { rootMargin: "-10% 0px -75% 0px" },
);
document.querySelectorAll(".doc section[id]").forEach((s) => observer.observe(s));

void loadLive();
