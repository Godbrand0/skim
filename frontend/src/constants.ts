import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { base } from "viem/chains";
import type { Address } from "viem";

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:8787";

export const MEZO_CHAIN_ID = 31612;
export const BASE_CHAIN_ID = 8453;
export const BASE_RPC = "https://mainnet.base.org";
/** 0.000005 ETH on Base: several times the cost of an approval plus a deposit. Below this the UI warns. */
export const LOW_BASE_ETH_WEI = 5n * 10n ** 12n;
export { base as baseChain };
export const MEZO_EXPLORER = "https://explorer.mezo.org";
export const BASE_EXPLORER = "https://basescan.org";
export const MEZO_RPC = "https://mainnet.mezo.public.validationcloud.io";

export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const MUSD_ADDR: Address = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
export const MUSDC_ADDR: Address = "0x04671C72Aab5AC02A03c1098314b1BB6B560c197";

export const WEI_PER_SAT = 10n ** 10n;
/** 0.00001 BTC left behind when sending the whole BTC balance, so the wallet can still pay fees. */
export const GAS_RESERVE_WEI = 10n ** 13n;
/** 0.000001 BTC: several times the cost of a deposit. Below this the UI warns about gas. */
export const LOW_GAS_WEI = 10n ** 12n;

export const mezo = defineChain({
  id: MEZO_CHAIN_ID,
  name: "Mezo",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [MEZO_RPC] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: MEZO_EXPLORER } },
});

// Read-only clients over plain HTTP, so balances show whichever network the wallet is on.
export const mezoRead = createPublicClient({ chain: mezo, transport: http() });
export const baseRead = createPublicClient({ chain: base, transport: http(BASE_RPC) });

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const depositAbi = parseAbi([
  "function deposit(address token, uint256 amount, address recipient) returns (bytes32)",
  "function depositNative(address recipient) payable returns (bytes32)",
]);
