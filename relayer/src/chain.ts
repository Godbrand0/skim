import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes } from "viem";
import type { Address, PublicClient, WalletClient, Account } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { floatAbi, oracleAbi } from "./abi.ts";
import { MEZO_ORACLE } from "./config.ts";
import type { ChainKey, Config } from "./config.ts";

export const mezo = defineChain({
  id: 31612,
  name: "Mezo",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.mezo.public.validationcloud.io"] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" } },
});

/** Patient RPC settings: public endpoints are slow at times, and a blip should not look like an outage. */
const RPC_OPTIONS = { timeout: 30_000, retryCount: 4, retryDelay: 1_000 } as const;

export const RELAYER_ROLE = keccak256(toBytes("RELAYER_ROLE"));

export interface Clients {
  mezoClient: PublicClient;
  baseClient: PublicClient;
  mezoWallet?: WalletClient;
  baseWallet?: WalletClient;
  account?: Account;
}

export const clientFor = (c: Clients, k: ChainKey): PublicClient => (k === "mezo" ? c.mezoClient : c.baseClient);
export const walletFor = (c: Clients, k: ChainKey): WalletClient | undefined => (k === "mezo" ? c.mezoWallet : c.baseWallet);

export function makeClients(cfg: Config): Clients {
  const mezoClient = createPublicClient({ chain: mezo, transport: http(cfg.mezoRpc, RPC_OPTIONS) });
  const baseClient = createPublicClient({ chain: base, transport: http(cfg.baseRpc, RPC_OPTIONS) }) as unknown as PublicClient;
  let mezoWallet: WalletClient | undefined;
  let baseWallet: WalletClient | undefined;
  let account: Account | undefined;
  if (cfg.relayerKey) {
    account = privateKeyToAccount(cfg.relayerKey);
    mezoWallet = createWalletClient({ account, chain: mezo, transport: http(cfg.mezoRpc, RPC_OPTIONS) });
    baseWallet = createWalletClient({ account, chain: base, transport: http(cfg.baseRpc, RPC_OPTIONS) }) as unknown as WalletClient;
  }
  return { mezoClient, baseClient, mezoWallet, baseWallet, account };
}

export interface FloatState {
  balanceMicro: bigint;
  paused: boolean;
  maxPerTx: bigint;
  maxPerAddress: bigint;
  maxGlobal: bigint;
  globalSpentToday: bigint;
}

/** Reads a float contract's balance, pause flag and limits. `client` must be on the float's chain. */
export async function readFloatState(client: PublicClient, floatAddress: Address): Promise<FloatState> {
  const read = <T extends "floatBalance" | "paused" | "maxPerTx" | "maxPerAddressPerDay" | "maxGlobalPerDay" | "globalSpentToday">(fn: T) =>
    client.readContract({ address: floatAddress, abi: floatAbi, functionName: fn });
  const [balanceMicro, paused, maxPerTx, maxPerAddress, maxGlobal, globalSpentToday] = await Promise.all([
    read("floatBalance"),
    read("paused"),
    read("maxPerTx"),
    read("maxPerAddressPerDay"),
    read("maxGlobalPerDay"),
    read("globalSpentToday"),
  ]);
  return { balanceMicro, paused, maxPerTx, maxPerAddress, maxGlobal, globalSpentToday };
}

/** BTC/USD from Mezo's own oracle precompile, scaled to 1e18. Throws if stale or invalid. */
export async function readBtcUsd18(c: Clients, maxAgeSec: bigint): Promise<bigint> {
  const [decimals, round] = await Promise.all([
    c.mezoClient.readContract({ address: MEZO_ORACLE, abi: oracleAbi, functionName: "decimals" }),
    c.mezoClient.readContract({ address: MEZO_ORACLE, abi: oracleAbi, functionName: "latestRoundData" }),
  ]);
  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n) throw new Error("oracle returned non-positive price");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > updatedAt && now - updatedAt > maxAgeSec) throw new Error(`oracle price is stale (${now - updatedAt}s old)`);
  const d = BigInt(decimals);
  return d === 18n ? answer : d < 18n ? answer * 10n ** (18n - d) : answer / 10n ** (d - 18n);
}
