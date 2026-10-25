import "@fontsource-variable/bricolage-grotesque";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import type { AppConfig, AssetCfg, AssetKey, Balances, DepositRow, QuoteResp } from "./types.ts";
import {
  BASE_CHAIN_ID,
  BASE_EXPLORER,
  BASE_USDC,
  GAS_RESERVE_WEI,
  LOW_BASE_ETH_WEI,
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
import { fetchConfigWithRetry, fetchDeposit, fetchQuote } from "./api.ts";
import { createSelect } from "./select.ts";
import type { SelectOption } from "./select.ts";
import { hasWallet, onWalletChange, requestAccount, switchToChain, walletClients } from "./wallet.ts";
import type { ChainKey } from "./wallet.ts";

// ---------- direction ----------
// "exit"  = Mezo to Base: deposit mUSDC, MUSD or sats on Mezo, receive USDC on Base.
// "enter" = Base to Mezo: deposit USDC on Base, receive mUSDC on Mezo.

type Direction = "exit" | "enter";

interface DirInfo {
  id: Direction;
  src: ChainKey;
  dst: ChainKey;
  srcName: string;
  dstName: string;
  srcChainId: number;
  srcExplorer: string;
  dstExplorer: string;
  payoutToken: string;
  deposit: Address;
  assets: AssetCfg[];
  liquidity: string;
  paused: boolean;
}

function dirInfo(): DirInfo | undefined {
  const cfg = state.config;
  if (!cfg) return undefined;
  if (state.direction === "enter" && cfg.enter) {
    return {
      id: "enter",
      src: "base",
      dst: "mezo",
      srcName: "Base",
      dstName: "Mezo",
      srcChainId: BASE_CHAIN_ID,
      srcExplorer: BASE_EXPLORER,
      dstExplorer: MEZO_EXPLORER,
      payoutToken: cfg.enter.payoutToken,
      deposit: cfg.enter.contracts.deposit,
      assets: [cfg.enter.asset],
      liquidity: cfg.enter.floatAvailable,
      paused: cfg.enter.paused,
    };
  }
  return {
    id: "exit",
    src: "mezo",
    dst: "base",
    srcName: "Mezo",
    dstName: "Base",
    srcChainId: MEZO_CHAIN_ID,
    srcExplorer: MEZO_EXPLORER,
    dstExplorer: BASE_EXPLORER,
    payoutToken: "USDC",
    deposit: cfg.contracts.deposit,
    assets: cfg.assets,
    liquidity: cfg.floatAvailableUsdc,
    paused: cfg.paused,
  };
}

// ---------- state ----------

const emptyBalances = (): Balances => ({
  musdc: undefined,
  musd: undefined,
  btcWei: undefined,
  baseUsdc: undefined,
  accountBaseUsdc: undefined,
  baseEth: undefined,
  failed: false,
});

const state = {
  config: undefined as AppConfig | undefined,
  direction: (location.hash === "#enter" ? "enter" : "exit") as Direction,
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
const flipBtn = $<HTMLButtonElement>("flip");
const msgEl = $("msg");
const reasonEl = $("q-reason");

const setMsg = (t: string): void => {
  msgEl.textContent = t;
};
const currentAsset = (): AssetCfg | undefined => dirInfo()?.assets.find((a) => a.key === state.asset);

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
  switch (a.key) {
    case "musdc":
      return b.musdc;
    case "musd":
      return b.musd;
    case "usdc":
      return b.accountBaseUsdc;
    default:
      return b.btcWei;
  }
}

/** Reset the form when the asset or the direction changes. */
function resetForm(): void {
  amountEl.value = "";
  state.quote = undefined;
  state.quoteError = "";
  setMsg("");
}

// ---------- token dropdowns ----------

const fromSelect = createSelect($("from-select"), "Token to send", (id) => {
  state.asset = id as AssetKey;
  resetForm();
  void refreshAllowance().then(render);
  renderSelects();
  render();
});
const toSelect = createSelect($("to-select"), "Token to receive", () => {
  /* one destination token per direction */
});

function renderSelects(): void {
  const d = dirInfo();
  const assets = (d?.assets ?? []).filter((a) => a.enabled);
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

  if (d?.id === "enter") {
    const m = TOKEN_STYLE.musdc;
    toSelect.setOptions([{ id: "musdc-mezo", glyph: m.glyph, cls: m.cls, symbol: "mUSDC", name: "Mezo Circle USDC on Mezo" }], "musdc-mezo");
  } else {
    const u = TOKEN_STYLE.usdc;
    toSelect.setOptions([{ id: "usdc-base", glyph: u.glyph, cls: u.cls, symbol: "USDC", name: "USD Coin on Base" }], "usdc-base");
  }
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
  const d = dirInfo();
  if (!a || !d || a.key === "btc" || !state.account) {
    state.allowance = 0n;
    return;
  }
  try {
    const client = d.src === "base" ? baseRead : mezoRead;
    state.allowance = await client.readContract({
      address: a.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [state.account, d.deposit],
    });
  } catch {
    state.allowance = 0n;
  }
}

let balanceSeq = 0;
/** Reads the connected wallet's balances on both chains, plus the Base USDC balance shown in the bar. */
async function refreshBalances(): Promise<void> {
  const seq = ++balanceSeq;
  const owner = state.account;
  const typed = recipientEl.value.trim();
  // The bar's Base USDC tile follows the receiving address on the exit lane, and the wallet itself on the enter lane.
  const baseOwner = state.direction === "exit" && isAddress(typed) ? getAddress(typed) : owner;
  state.baseOwner = baseOwner;
  if (!owner && !baseOwner) {
    state.balances = emptyBalances();
    renderSelects();
    return render();
  }
  try {
    const [musdc, musd, btcWei, baseUsdc, accountBaseUsdc, baseEth] = await Promise.all([
      owner ? mezoRead.readContract({ address: MUSDC_ADDR, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : undefined,
      owner ? mezoRead.readContract({ address: MUSD_ADDR, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : undefined,
      owner ? mezoRead.getBalance({ address: owner }) : undefined,
      baseOwner ? baseRead.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [baseOwner] }) : undefined,
      owner ? baseRead.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : undefined,
      owner ? baseRead.getBalance({ address: owner }) : undefined,
    ]);
    if (seq !== balanceSeq) return; // superseded by a newer refresh
    state.balances = { musdc, musd, btcWei, baseUsdc, accountBaseUsdc, baseEth, failed: false };
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
  const res = await fetchQuote(a.key, amountEl.value.trim(), state.direction);
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
  const d = dirInfo();
  const a = currentAsset();
  const cfg = state.config;
  const q = state.quote;
  const amount = a ? parseAmount(a, amountEl.value) : undefined;
  const dstName = d?.dstName ?? "Base";
  const srcName = d?.srcName ?? "Mezo";
  const payout = d?.payoutToken ?? "USDC";

  connectBtn.textContent = state.account ? short(state.account) : "Connect wallet";
  useWalletBtn.hidden = !state.account || recipientEl.value.trim().toLowerCase() === state.account.toLowerCase();
  flipBtn.hidden = !cfg?.enter;

  // direction-dependent labels
  $("title").textContent = d?.id === "enter" ? "Bring small amounts onto Mezo" : "Withdraw small amounts from Mezo";
  $("lead").textContent =
    d?.id === "enter"
      ? "Have USDC on Base? Send it here and receive mUSDC on Mezo."
      : "Below Mezo's own withdrawal minimum? Send it here and receive USDC on Base.";
  $("from-chain").textContent = `From ${srcName}`;
  $("to-chain").textContent = `To ${dstName}`;
  $("from-dot").className = `dot ${d?.src === "base" ? "base" : "mezo"}`;
  $("to-dot").className = `dot ${d?.dst === "mezo" ? "mezo" : "base"}`;
  $("recipient-label").textContent = `${dstName} address that receives the ${payout}`;
  $("recipient-hint").textContent = `Use an address you control on ${dstName}. Transfers can't be undone.`;
  $("to-note").textContent =
    d?.id === "enter" ? "We cover the Mezo network fee. You'll need a little BTC on Mezo to move your mUSDC." : "We cover the Base network fee";
  $("q-liq-label").textContent = `Liquidity on ${dstName}`;
  $("how-1").textContent = `You send on ${srcName}. The funds go straight to the Skim treasury.`;
  $("how-2").textContent = `When your transfer confirms, ${payout} is paid to your ${dstName} address from a pre-funded float, minus the fee.`;
  flipBtn.setAttribute("aria-label", d?.id === "enter" ? "Switch to Mezo to Base" : "Switch to Base to Mezo");

  // from panel
  const bal = a ? balanceOf(a) : undefined;
  $("balance").textContent = a && bal !== undefined ? `Balance ${fmtBalance(a, bal)} ${a.unit}` : "";
  $("limits").textContent = a ? `Between ${a.min} and ${a.max} ${a.unit} per transfer` : "";
  $("usd-est").textContent = q ? `≈ $${money(q.grossUsdc)}` : " ";

  // to panel and details
  $("receive").textContent = q ? money(q.payoutUsdc) : "0";
  $("q-gross").textContent = q ? `$${money(q.grossUsdc)}` : "-";
  $("q-fee").textContent = q ? `$${money(q.feeUsdc)}${cfg ? ` (${cfg.fee.percent}%, at least $${money(cfg.fee.floorUsdc)})` : ""}` : "-";
  $("q-payout").textContent = q ? `$${money(q.payoutUsdc)} ${payout}` : "-";
  $("q-liquidity").textContent = d ? `$${money2(d.liquidity)} ${payout}` : "-";
  $("sum-line").textContent = q ? `Fee $${money(q.feeUsdc)}` : cfg ? `Fee ${cfg.fee.percent}%` : "";
  $("fee-line").textContent = q
    ? `Fee $${money(q.feeUsdc)}`
    : cfg
      ? `${cfg.fee.percent}% fee, at least $${money(cfg.fee.floorUsdc)}`
      : "";

  reasonEl.textContent = state.quoteError || (q && !q.canFulfill ? (q.reasons[0] ?? "") : "");

  renderWalletPanel();

  if (cfg) {
    const parts: (string | HTMLAnchorElement)[] = [
      "Contracts: ",
      link(`${MEZO_EXPLORER}/address/${cfg.contracts.deposit}`, `Mezo deposit ${short(cfg.contracts.deposit)}`),
      " and ",
      link(`${BASE_EXPLORER}/address/${cfg.contracts.float}`, `Base float ${short(cfg.contracts.float)}`),
    ];
    if (cfg.enter) {
      parts.push(
        ". Reverse direction: ",
        link(`${BASE_EXPLORER}/address/${cfg.enter.contracts.deposit}`, `Base deposit ${short(cfg.enter.contracts.deposit)}`),
        " and ",
        link(`${MEZO_EXPLORER}/address/${cfg.enter.contracts.float}`, `Mezo float ${short(cfg.enter.contracts.float)}`),
      );
    }
    $("contracts").replaceChildren(...parts);
  }

  // action button
  let label = `Bridge to ${dstName}`;
  let disabled = false;
  if (!cfg || !a || !d) {
    label = "Loading…";
    disabled = true;
  } else if (!state.account) {
    label = "Connect wallet";
  } else if (state.chainId !== d.srcChainId) {
    label = `Switch to ${srcName}`;
  } else if (!isAddress(recipientEl.value.trim())) {
    label = `Enter a ${dstName} address`;
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

  const d = dirInfo();
  const lowMezoGas = b.btcWei !== undefined && b.btcWei < LOW_GAS_WEI;
  const lowBaseGas = b.baseEth !== undefined && b.baseEth < LOW_BASE_ETH_WEI;
  $("b-note").textContent = b.failed
    ? "Could not refresh balances. Showing the last values."
    : !state.account
      ? "Connect your wallet to see your balances."
      : d?.id === "enter" && lowBaseGas
        ? "Your ETH on Base is very low. Base network fees are paid in ETH, so keep a small amount in your wallet."
        : d?.id !== "enter" && lowMezoGas
          ? "Your gas balance is very low. Mezo network fees are paid in BTC, so keep a small amount in your wallet."
          : "";
}

// ---------- actions ----------

async function onAction(): Promise<void> {
  const a = currentAsset();
  const d = dirInfo();
  const cfg = state.config;
  if (!a || !d || !cfg) return;
  if (!state.account) return void (await connect());
  if (state.chainId !== d.srcChainId) {
    try {
      await switchToChain(d.src);
      state.chainId = d.srcChainId;
    } catch (e) {
      setMsg((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message);
    }
    return render();
  }

  const amount = parseAmount(a, amountEl.value);
  const recipientRaw = recipientEl.value.trim();
  if (amount === undefined || !isAddress(recipientRaw)) return;
  const recipient = getAddress(recipientRaw);
  if (recipient.toLowerCase() === d.deposit.toLowerCase() || recipient.toLowerCase() === a.address.toLowerCase()) {
    return setMsg(`That address cannot receive your ${d.payoutToken}. Use your own ${d.dstName} wallet address.`);
  }
  const bal = balanceOf(a);
  if (a.key === "btc" && bal !== undefined && amount + GAS_RESERVE_WEI > bal) {
    return setMsg("Leave a little BTC in your wallet to pay network fees.");
  }

  state.busy = true;
  render();
  try {
    const { pub, wallet } = walletClients(d.src);
    if (a.key !== "btc" && state.allowance < amount) {
      setMsg(`Approve ${a.symbol} in your wallet…`);
      // exact amount, never unlimited
      const approveHash = await wallet.writeContract({
        account: state.account,
        chain: undefined,
        address: a.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [d.deposit, amount],
      });
      setMsg("Waiting for approval to confirm…");
      await pub.waitForTransactionReceipt({ hash: approveHash });
      await refreshAllowance();
      setMsg(`Approved. Now bridge to ${d.dstName}.`);
      return;
    }

    setMsg("Confirm the bridge in your wallet…");
    const hash: Hex =
      a.key === "btc"
        ? await wallet.writeContract({ account: state.account, chain: undefined, address: d.deposit, abi: depositAbi, functionName: "depositNative", args: [recipient], value: amount })
        : await wallet.writeContract({ account: state.account, chain: undefined, address: d.deposit, abi: depositAbi, functionName: "deposit", args: [a.address, amount, recipient] });
    setMsg("Bridge sent. Waiting for confirmation…");
    amountEl.value = "";
    state.quote = undefined;
    startTracking(hash, d);
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

function startTracking(txHash: Hex, d: DirInfo): void {
  window.clearInterval(state.pollTimer);
  $("tracker").hidden = false;
  const steps = $("steps");
  const note = $("track-note");

  const draw = (stage: number, row?: DepositRow) => {
    const labels = [`Sent on ${d.srcName}`, `Confirming on ${d.srcName}`, `${d.payoutToken} sent on ${d.dstName}`];
    steps.replaceChildren();
    labels.forEach((l, i) => {
      const li = document.createElement("li");
      li.className = i < stage ? "done" : i === stage ? "active" : "";
      li.append(l);
      if (i === 0) li.append(" ", link(`${d.srcExplorer}/tx/${txHash}`, "view"));
      if (i === 2 && row?.releaseTx && row.status === "paid") li.append(" ", link(`${d.dstExplorer}/tx/${row.releaseTx}`, `view · $${money(row.payoutUsdc ?? "0")} ${d.payoutToken}`));
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

flipBtn.addEventListener("click", () => {
  if (!state.config?.enter) return;
  state.direction = state.direction === "exit" ? "enter" : "exit";
  history.replaceState(null, "", state.direction === "enter" ? "#enter" : location.pathname + location.search);
  const d = dirInfo();
  const first = d?.assets.find((a) => a.enabled) ?? d?.assets[0];
  if (first) state.asset = first.key;
  resetForm();
  void refreshAllowance().then(render);
  void refreshBalances();
  renderSelects();
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
    state.config = await fetchConfigWithRetry(() => setMsg("Starting the service. This can take up to a minute…"));
    setMsg("");
    // a link to #enter only works when the reverse direction is switched on
    if (state.direction === "enter" && !state.config.enter) state.direction = "exit";
    const d = dirInfo();
    const first = d?.assets.find((a) => a.enabled) ?? d?.assets[0];
    if (first) state.asset = first.key;
    if (d?.paused) setMsg("Payouts are paused right now. Deposits are not recommended until they resume.");
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
