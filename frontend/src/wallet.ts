import { createPublicClient, createWalletClient, custom, getAddress } from "viem";
import type { Address } from "viem";
import { MEZO_CHAIN_ID, MEZO_EXPLORER, MEZO_RPC, mezo } from "./constants.ts";

export const hasWallet = (): boolean => typeof window !== "undefined" && !!window.ethereum;

export function walletClients() {
  if (!window.ethereum) throw new Error("No wallet found. Install a wallet such as MetaMask or Rabby.");
  const transport = custom(window.ethereum);
  return {
    pub: createPublicClient({ chain: mezo, transport }),
    wallet: createWalletClient({ chain: mezo, transport }),
  };
}

export async function requestAccount(): Promise<{ account: Address; chainId: number }> {
  if (!window.ethereum) throw new Error("No wallet found. Install a wallet such as MetaMask or Rabby.");
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const chainId = Number(BigInt((await window.ethereum.request({ method: "eth_chainId" })) as string));
  return { account: getAddress(accounts[0]), chainId };
}

export async function switchToMezo(): Promise<void> {
  if (!window.ethereum) return;
  const chainIdHex = `0x${MEZO_CHAIN_ID.toString(16)}`;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: "Mezo",
          nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
          rpcUrls: [MEZO_RPC],
          blockExplorerUrls: [MEZO_EXPLORER],
        },
      ],
    });
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
