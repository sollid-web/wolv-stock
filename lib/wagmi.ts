import { http, createConfig } from "wagmi";
import { bsc as wagmiBsc, bscTestnet as wagmiBscTestnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { bsc, bscTestnet } from "@reown/appkit/networks";
import { getBscRpcUrl, getConfiguredBscChain } from "./bscChain.ts";

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLET_PROJECT_ID;
const mainnetRpcUrl = getBscRpcUrl(56);
const testnetRpcUrl = getBscRpcUrl(97);
const configuredChain = getConfiguredBscChain();
export const appKitNetworks = [bsc, bscTestnet] as const;

if (!walletConnectProjectId) {
  console.warn(
    "NEXT_PUBLIC_WALLET_PROJECT_ID is not set - AppKit wallets are unavailable; injected wallets still work."
  );
}

export const wagmiAdapter = walletConnectProjectId
  ? new WagmiAdapter({
      networks: [...appKitNetworks],
      projectId: walletConnectProjectId,
      ssr: true,
      transports: {
        [wagmiBsc.id]: http(mainnetRpcUrl),
        [wagmiBscTestnet.id]: http(testnetRpcUrl),
      },
    })
  : null;

export const wagmiConfig = wagmiAdapter?.wagmiConfig ?? createConfig({
  chains: [wagmiBsc, wagmiBscTestnet],
  connectors: [injected()],
  transports: {
    [wagmiBsc.id]: http(mainnetRpcUrl),
    [wagmiBscTestnet.id]: http(testnetRpcUrl),
  },
  ssr: true,
});

export const defaultAppKitNetwork = configuredChain.id === 97 ? bscTestnet : bsc;