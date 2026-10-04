"use client";

import { useState, type ReactNode } from "react";
import { createAppKit } from "@reown/appkit/react";
import { bsc } from "@reown/appkit/networks";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { appKitNetworks, wagmiAdapter, wagmiConfig, walletConnectProjectId } from "@/lib/wagmi";

if (typeof window !== "undefined" && walletConnectProjectId && wagmiAdapter) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [...appKitNetworks],
    defaultNetwork: bsc,
    projectId: walletConnectProjectId,
    metadata: {
      name: "WOLV Spot Lens",
      description: "Cross-venue spot trading for tokenized equities",
      url: "https://wolv-stock.vercel.app",
      icons: ["https://wolv-stock.vercel.app/logo.png"],
    },
    themeMode: "dark",
    features: { analytics: false, email: false, socials: false, allWallets: true },
  });
}

export default function Providers({ children }: { children: ReactNode }) {
  // Created once per client, not on every render.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={typeof window !== "undefined"}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
