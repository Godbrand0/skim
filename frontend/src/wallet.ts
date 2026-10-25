import { createPublicClient, createWalletClient, custom, getAddress } from "viem";
import type { Address, PublicClient, WalletClient } from "viem";
import { BASE_CHAIN_ID, BASE_EXPLORER, BASE_RPC, MEZO_CHAIN_ID, MEZO_EXPLORER, MEZO_RPC, baseChain, mezo } from "./constants.ts";

export type ChainKey = "mezo" | "base";

export const hasWallet = (): boolean => typeof window !== "undefined" && !!window.ethereum;

/** Public and wallet clients that talk through the user's wallet, for the given chain. */
export function walletClients(chain: ChainKey): { pub: PublicClient; wallet: WalletClient } {
  if (!window.ethereum) throw new Error("No wallet found. Install a wallet such as MetaMask or Rabby.");
  const transport = custom(window.ethereum);
  const c = chain === "mezo" ? mezo : baseChain;
  return {
    pub: createPublicClient({ chain: c, transport }) as unknown as PublicClient,
    wallet: createWalletClient({ chain: c, transport }) as unknown as WalletClient,
  };
}

export async function requestAccount(): Promise<{ account: Address; chainId: number }> {
  if (!window.ethereum) throw new Error("No wallet found. Install a wallet such as MetaMask or Rabby.");
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const chainId = Number(BigInt((await window.ethereum.request({ method: "eth_chainId" })) as string));
  return { account: getAddress(accounts[0]), chainId };
}

const NETWORKS = {
  mezo: {
    id: MEZO_CHAIN_ID,
    params: { chainName: "Mezo", nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 }, rpcUrls: [MEZO_RPC], blockExplorerUrls: [MEZO_EXPLORER] },
  },
  base: {
    id: BASE_CHAIN_ID,
    params: { chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [BASE_RPC], blockExplorerUrls: [BASE_EXPLORER] },
  },
} as const;

/** Ask the wallet to switch to a chain, adding it first if the wallet doesn't know it. */
export async function switchToChain(chain: ChainKey): Promise<void> {
  if (!window.ethereum) return;
  const n = NETWORKS[chain];
  const chainIdHex = `0x${n.id.toString(16)}`;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: chainIdHex, ...n.params }] });
  }
}

export function onWalletChange(handlers: { account: (a: Address | undefined) => void; chain: (id: number) => void }): void {
  const eth = window.ethereum;
  if (!eth?.on) return;
  eth.on("accountsChanged", (accs) => {
    const list = accs as string[];
    handlers.account(list[0] ? getAddress(list[0]) : undefined);
  });
  eth.on("chainChanged", (id) => handlers.chain(Number(BigInt(id as string))));
}
