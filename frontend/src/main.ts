import "@fontsource-variable/bricolage-grotesque";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import type { AppConfig, AssetCfg, AssetKey, Balances, DepositRow, QuoteResp } from "./types.ts";
import {
  BASE_EXPLORER,
  BASE_USDC,
  GAS_RESERVE_WEI,
  LOW_GAS_WEI,
  MEZO_CHAIN_ID,
  MEZO_EXPLORER,
  MUSDC_ADDR,
  MUSD_ADDR,
  WEI_PER_SAT,
  baseRead,
  depositAbi,
  erc20Abi,
  mezoRead,
} from "./constants.ts";
import { TOKEN_STYLE, fmt, fmtBalance, parseAmount, short } from "./format.ts";
import { fetchConfig, fetchDeposit, fetchQuote } from "./api.ts";
import { createSelect } from "./select.ts";
import type { SelectOption } from "./select.ts";
import { hasWallet, onWalletChange, requestAccount, switchToMezo, walletClients } from "./wallet.ts";

// ---------- state ----------

const emptyBalances = (): Balances => ({ musdc: undefined, musd: undefined, btcWei: undefined, baseUsdc: undefined, failed: false });

const state = {
  config: undefined as AppConfig | undefined,
  asset: "musdc" as AssetKey,
  account: undefined as Address | undefined,
  chainId: undefined as number | undefined,
  allowance: 0n,
  quote: undefined as QuoteResp | undefined,
  quoteError: "",
  busy: false,
  pollTimer: undefined as number | undefined,
  balances: emptyBalances(),
  baseOwner: undefined as Address | undefined,
};

// ---------- dom ----------

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const connectBtn = $<HTMLButtonElement>("connect");
const amountEl = $<HTMLInputElement>("amount");
const recipientEl = $<HTMLInputElement>("recipient");
const actionBtn = $<HTMLButtonElement>("action");
const useWalletBtn = $<HTMLButtonElement>("use-wallet");
const msgEl = $("msg");
const reasonEl = $("q-reason");

const setMsg = (t: string): void => {
  msgEl.textContent = t;
};
const currentAsset = (): AssetCfg | undefined => state.config?.assets.find((a) => a.key === state.asset);

function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** "9.800000" -> "9.80", "0.123456" -> "0.123456": drop trailing zeros but keep at least 2 decimals. */
function money(s: string): string {
  const [w, f = ""] = s.split(".");
  const trimmed = f.replace(/0+$/, "");
  return `${w}.${trimmed.padEnd(2, "0")}`;
}

/** Truncate a decimal string to 2 decimals without rounding up. */
function money2(s: string): string {
  const [w, f = ""] = s.split(".");
  return `${w}.${f.padEnd(2, "0").slice(0, 2)}`;
}

function balanceOf(a: AssetCfg): bigint | undefined {
  const b = state.balances;
  return a.key === "musdc" ? b.musdc : a.key === "musd" ? b.musd : b.btcWei;
}

// ---------- token dropdowns ----------

const fromSelect = createSelect($("from-select"), "Token to send", (id) => {
  state.asset = id as AssetKey;
  amountEl.value = "";
  state.quote = undefined;
  state.quoteError = "";
  setMsg("");
  void refreshAllowance().then(render);
  renderSelects();
  render();
});
const toSelect = createSelect($("to-select"), "Token to receive", () => {
  /* USDC on Base is the only destination today */
});

function renderSelects(): void {
  const assets = (state.config?.assets ?? []).filter((a) => a.enabled);
  const opts: SelectOption[] = assets.map((a) => {
    const st = TOKEN_STYLE[a.key];
    const bal = balanceOf(a);
    return {
      id: a.key,
      glyph: st.glyph,
      cls: st.cls,
      symbol: a.key === "btc" ? "BTC (sats)" : st.label,
      name: st.name,
      detail: bal !== undefined ? fmtBalance(a, bal) : undefined,
    };
  });
  fromSelect.setOptions(opts, state.asset);

  const u = TOKEN_STYLE.usdc;
  toSelect.setOptions([{ id: "usdc-base", glyph: u.glyph, cls: u.cls, symbol: "USDC", name: "USD Coin on Base" }], "usdc-base");
}

// ---------- wallet and balances ----------

async function connect(): Promise<void> {
  try {
    const { account, chainId } = await requestAccount();
    state.account = account;
    state.chainId = chainId;
    if (!recipientEl.value) recipientEl.value = account;
    await refreshAllowance();
    render();
    void refreshBalances();
  } catch (e) {
    setMsg((e as Error).message);
  }
}

if (hasWallet()) {
  onWalletChange({
    account: (a) => {
      state.account = a;
      state.allowance = 0n;
      void refreshAllowance().then(render);
      void refreshBalances();
    },
    chain: (id) => {
      state.chainId = id;
      render();
    },
  });
}

/** Allowance for the selected ERC-20, read over HTTP so it works regardless of the wallet's network. */
async function refreshAllowance(): Promise<void> {
  const a = currentAsset();
  if (!a || a.key === "btc" || !state.account || !state.config) {
    state.allowance = 0n;
    return;
  }
  try {
    state.allowance = await mezoRead.readContract({
      address: a.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [state.account, state.config.contracts.deposit],
    });
  } catch {
    state.allowance = 0n;
  }
}

let balanceSeq = 0;
/** Reads Mezo balances for the connected wallet and the Base USDC balance of the receiving address. */
async function refreshBalances(): Promise<void> {
  const seq = ++balanceSeq;
  const owner = state.account;
  const typed = recipientEl.value.trim();
  const baseOwner = isAddress(typed) ? getAddress(typed) : owner;
  state.baseOwner = baseOwner;
  if (!owner && !baseOwner) {
    state.balances = emptyBalances();
    renderSelects();
    return render();
  }
  try {
    const [musdc, musd, btcWei, baseUsdc] = await Promise.all([
      owner ? mezoRead.readContract({ address: MUSDC_ADDR, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : undefined,
      owner ? mezoRead.readContract({ address: MUSD_ADDR, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : undefined,
      owner ? mezoRead.getBalance({ address: owner }) : undefined,
      baseOwner ? baseRead.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [baseOwner] }) : undefined,
    ]);
    if (seq !== balanceSeq) return; // superseded by a newer refresh
    state.balances = { musdc, musd, btcWei, baseUsdc, failed: false };
  } catch {
    if (seq !== balanceSeq) return;
    state.balances = { ...state.balances, failed: true };
  }
  renderSelects();
  render();
}

// ---------- quote ----------

let quoteSeq = 0;
let quoteTimer: number | undefined;
function scheduleQuote(): void {
  window.clearTimeout(quoteTimer);
  state.quote = undefined;
  state.quoteError = "";
  quoteTimer = window.setTimeout(() => void loadQuote(), 350);
}
async function loadQuote(): Promise<void> {
  const a = currentAsset();
  if (!a || parseAmount(a, amountEl.value) === undefined) return render();
  const seq = ++quoteSeq;
  const res = await fetchQuote(a.key, amountEl.value.trim());
  if (seq !== quoteSeq) return; // a newer request superseded this one
  if (res.ok) {
    state.quote = res.quote;
    state.quoteError = "";
  } else {
    state.quote = undefined;
    state.quoteError = res.error;
  }
  render();
}

// ---------- render ----------

function render(): void {
  const a = currentAsset();
  const cfg = state.config;
  const q = state.quote;
  const amount = a ? parseAmount(a, amountEl.value) : undefined;

  connectBtn.textContent = state.account ? short(state.account) : "Connect wallet";
  useWalletBtn.hidden = !state.account || recipientEl.value.trim().toLowerCase() === state.account.toLowerCase();

  // from panel
  const bal = a ? balanceOf(a) : undefined;
  $("balance").textContent = a && bal !== undefined ? `Balance ${fmtBalance(a, bal)} ${a.unit}` : "";
  $("limits").textContent = a ? `Between ${a.min} and ${a.max} ${a.unit} per transfer` : "";
  $("usd-est").textContent = q ? `≈ $${money(q.grossUsdc)}` : " ";

  // to panel and details
  $("receive").textContent = q ? money(q.payoutUsdc) : "0";
  $("q-gross").textContent = q ? `$${money(q.grossUsdc)}` : "-";
  $("q-fee").textContent = q ? `$${money(q.feeUsdc)}${cfg ? ` (${cfg.fee.percent}%, at least $${money(cfg.fee.floorUsdc)})` : ""}` : "-";
  $("q-payout").textContent = q ? `$${money(q.payoutUsdc)} USDC` : "-";
  $("q-liquidity").textContent = cfg ? `$${money2(cfg.floatAvailableUsdc)} USDC` : "-";
  $("sum-line").textContent = q ? `Fee $${money(q.feeUsdc)}` : cfg ? `Fee ${cfg.fee.percent}%` : "";
  $("fee-line").textContent = q
    ? `Fee $${money(q.feeUsdc)}`
    : cfg
      ? `${cfg.fee.percent}% fee, at least $${money(cfg.fee.floorUsdc)}`
      : "";

  reasonEl.textContent = state.quoteError || (q && !q.canFulfill ? (q.reasons[0] ?? "") : "");

  renderWalletPanel();

  if (cfg) {
    $("contracts").replaceChildren(
      "Contracts: ",
      link(`${MEZO_EXPLORER}/address/${cfg.contracts.deposit}`, `Mezo deposit ${short(cfg.contracts.deposit)}`),
      " and ",
      link(`${BASE_EXPLORER}/address/${cfg.contracts.float}`, `Base float ${short(cfg.contracts.float)}`),
    );
  }

  // action button
  let label = "Bridge to Base";
  let disabled = false;
  if (!cfg || !a) {
    label = "Loading…";
    disabled = true;
  } else if (!state.account) {
    label = "Connect wallet";
  } else if (state.chainId !== MEZO_CHAIN_ID) {
    label = "Switch to Mezo";
  } else if (!isAddress(recipientEl.value.trim())) {
    label = "Enter a Base address";
    disabled = true;
  } else if (amount === undefined) {
    label = "Enter an amount";
    disabled = true;
  } else if (state.quoteError) {
    label = "Quote unavailable";
    disabled = true;
  } else if (q && !q.canFulfill) {
    label = "Can't process this amount";
    disabled = true;
  } else if (!q) {
    label = "Getting quote…";
    disabled = true;
  } else if (bal !== undefined && amount > bal) {
    label = "Insufficient balance";
    disabled = true;
  } else if (a.key !== "btc" && state.allowance < amount) {
    label = `Approve ${TOKEN_STYLE[a.key].label}`;
  }
  if (state.busy) disabled = true;
  actionBtn.textContent = label;
  actionBtn.disabled = disabled;
}

function renderWalletPanel(): void {
  const b = state.balances;
  const show = (id: string, v: string | undefined) => {
    $(id).textContent = v ?? "-";
  };
  show("b-musdc", b.musdc !== undefined ? `${fmt(b.musdc, 6, 4)} mUSDC` : undefined);
  show("b-musd", b.musd !== undefined ? `${fmt(b.musd, 18, 4)} MUSD` : undefined);
  show("b-btc", b.btcWei !== undefined ? `${(b.btcWei / WEI_PER_SAT).toLocaleString("en-US")} sats` : undefined);
  show("b-gas", b.btcWei !== undefined ? `${fmt(b.btcWei, 18, 8)} BTC` : undefined);
  show("b-base", b.baseUsdc !== undefined ? `${fmt(b.baseUsdc, 6, 4)} USDC` : undefined);
  $("b-base-label").textContent = state.baseOwner ? `USDC on Base (${short(state.baseOwner)})` : "USDC on Base";
  const lowGas = b.btcWei !== undefined && b.btcWei < LOW_GAS_WEI;
  $("b-note").textContent = b.failed
    ? "Could not refresh balances. Showing the last values."
    : !state.account
      ? "Connect your wallet to see your balances."
      : lowGas
        ? "Your gas balance is very low. Mezo network fees are paid in BTC, so keep a small amount in your wallet."
        : "";
}

// ---------- actions ----------

async function onAction(): Promise<void> {
  const a = currentAsset();
  const cfg = state.config;
  if (!a || !cfg) return;
  if (!state.account) return void (await connect());
  if (state.chainId !== MEZO_CHAIN_ID) {
    try {
      await switchToMezo();
      state.chainId = MEZO_CHAIN_ID;
    } catch (e) {
      setMsg((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message);
    }
    return render();
  }

  const amount = parseAmount(a, amountEl.value);
  const recipientRaw = recipientEl.value.trim();
  if (amount === undefined || !isAddress(recipientRaw)) return;
  const recipient = getAddress(recipientRaw);
  if (recipient.toLowerCase() === cfg.contracts.deposit.toLowerCase() || recipient.toLowerCase() === a.address.toLowerCase()) {
    return setMsg("That address cannot receive your USDC. Use your own Base wallet address.");
  }
  const bal = balanceOf(a);
  if (a.key === "btc" && bal !== undefined && amount + GAS_RESERVE_WEI > bal) {
    return setMsg("Leave a little BTC in your wallet to pay network fees.");
  }

  state.busy = true;
  render();
  try {
    const { pub, wallet } = walletClients();
    if (a.key !== "btc" && state.allowance < amount) {
      setMsg(`Approve ${a.symbol} in your wallet…`);
      // exact amount, never unlimited
      const approveHash = await wallet.writeContract({
        account: state.account,
        address: a.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [cfg.contracts.deposit, amount],
      });
      setMsg("Waiting for approval to confirm…");
      await pub.waitForTransactionReceipt({ hash: approveHash });
      await refreshAllowance();
      setMsg("Approved. Now bridge to Base.");
      return;
    }

    setMsg("Confirm the bridge in your wallet…");
    const hash: Hex =
      a.key === "btc"
        ? await wallet.writeContract({ account: state.account, address: cfg.contracts.deposit, abi: depositAbi, functionName: "depositNative", args: [recipient], value: amount })
        : await wallet.writeContract({ account: state.account, address: cfg.contracts.deposit, abi: depositAbi, functionName: "deposit", args: [a.address, amount, recipient] });
    setMsg("Bridge sent. Waiting for confirmation…");
    amountEl.value = "";
    state.quote = undefined;
    startTracking(hash);
    await pub.waitForTransactionReceipt({ hash });
    await refreshAllowance();
    void refreshBalances();
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    setMsg(err.shortMessage ?? err.message ?? "Something went wrong.");
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- tracker ----------

function startTracking(txHash: Hex): void {
  window.clearInterval(state.pollTimer);
  $("tracker").hidden = false;
  const steps = $("steps");
  const note = $("track-note");

  const draw = (stage: number, row?: DepositRow) => {
    const labels = ["Sent on Mezo", "Confirming on Mezo", "USDC sent on Base"];
    steps.replaceChildren();
    labels.forEach((l, i) => {
      const li = document.createElement("li");
      li.className = i < stage ? "done" : i === stage ? "active" : "";
      li.append(l);
      if (i === 0) li.append(" ", link(`${MEZO_EXPLORER}/tx/${txHash}`, "view"));
      if (i === 2 && row?.releaseTx && row.status === "paid") li.append(" ", link(`${BASE_EXPLORER}/tx/${row.releaseTx}`, `view · $${money(row.payoutUsdc ?? "0")} USDC`));
      steps.append(li);
    });
    note.textContent =
      row?.status === "waiting" && row.note
        ? `Waiting: ${row.note}. This resolves automatically.`
        : row?.status === "manual_review"
          ? `Needs manual review (${row.note ?? "unknown"}). Contact support with your transaction link.`
          : "";
  };
  draw(1);

  const poll = async () => {
    try {
      const row = await fetchDeposit(txHash);
      if (!row) return draw(1);
      if (row.status === "paid") {
        draw(3, row);
        window.clearInterval(state.pollTimer);
        void refreshBalances();
      } else {
        draw(2, row);
      }
    } catch {
      /* keep polling */
    }
  };
  state.pollTimer = window.setInterval(() => void poll(), 3000);
  void poll();
}

// ---------- events and boot ----------

amountEl.addEventListener("input", () => {
  setMsg("");
  scheduleQuote();
  render();
});

let recipientTimer: number | undefined;
recipientEl.addEventListener("input", () => {
  render();
  window.clearTimeout(recipientTimer);
  recipientTimer = window.setTimeout(() => void refreshBalances(), 400);
});
useWalletBtn.addEventListener("click", () => {
  if (!state.account) return;
  recipientEl.value = state.account;
  void refreshBalances();
  render();
});

$("max").addEventListener("click", () => {
  const a = currentAsset();
  const bal = a ? balanceOf(a) : undefined;
  if (!a || bal === undefined) return;
  let amt = a.key === "btc" ? (bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n) : bal;
  const cap = parseAmount(a, a.max); // never offer more than the per-transfer maximum
  if (cap !== undefined && amt > cap) amt = cap;
  amountEl.value = a.key === "btc" ? (amt / WEI_PER_SAT).toString() : fmtExact(amt, a.decimals);
  scheduleQuote();
  render();
});

/** Exact decimal string for an amount in base units (no grouping, no truncation). */
function fmtExact(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

connectBtn.addEventListener("click", () => void connect());
actionBtn.addEventListener("click", () => void onAction());

async function boot(): Promise<void> {
  renderSelects();
  render();
  try {
    state.config = await fetchConfig();
    const first = state.config.assets.find((a) => a.enabled);
    if (first) state.asset = first.key;
    if (state.config.paused) setMsg("Payouts are paused right now. Deposits are not recommended until they resume.");
  } catch {
    setMsg("Could not reach the service. Please try again shortly.");
  }
  renderSelects();
  render();
  void refreshBalances();
  window.setInterval(() => {
    if (!document.hidden) void refreshBalances();
  }, 30_000);
}
void boot();
