import { http, createConfig } from "wagmi";
import { bsc as wagmiBsc } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { bsc } from "@reown/appkit/networks";

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLET_PROJECT_ID;
export const appKitNetworks = [bsc] as const;

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
        [bsc.id]: http("https://bsc-dataseed.binance.org/"),
      },
    })
  : null;

export const wagmiConfig = wagmiAdapter?.wagmiConfig ?? createConfig({
  chains: [wagmiBsc],
  connectors: [injected()],
  transports: {
    [wagmiBsc.id]: http("https://bsc-dataseed.binance.org/"),
  },
  ssr: true,
});