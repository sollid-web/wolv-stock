import { http, createConfig } from "wagmi";
import { bsc as wagmiBsc } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { bsc } from "@reown/appkit/networks";
import { resolvePublicRpcUrl } from "./publicRpcUrl";

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLET_PROJECT_ID;
const bscRpcUrl = resolvePublicRpcUrl(
  process.env.NEXT_PUBLIC_BSC_RPC_URL,
  "https://bsc-dataseed.binance.org/",
  "NEXT_PUBLIC_BSC_RPC_URL",
);
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
        [bsc.id]: http(bscRpcUrl),
      },
    })
  : null;

export const wagmiConfig = wagmiAdapter?.wagmiConfig ?? createConfig({
  chains: [wagmiBsc],
  connectors: [injected()],
  transports: {
    [wagmiBsc.id]: http(bscRpcUrl),
  },
  ssr: true,
});