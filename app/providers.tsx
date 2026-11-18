"use client";

import { useState, type ReactNode } from "react";
import { createAppKit } from "@reown/appkit/react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { appKitNetworks, defaultAppKitNetwork, wagmiAdapter, wagmiConfig, walletConnectProjectId } from "@/lib/wagmi";

if (typeof window !== "undefined" && walletConnectProjectId && wagmiAdapter) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [...appKitNetworks],
    defaultNetwork: defaultAppKitNetwork,
    projectId: walletConnectProjectId,
    // Shown in the wallet's connection prompt: must match the page origin exactly.
    metadata: {
      name: "WOLV",
      description: "Tokenized stocks on BNB Chain, compared before you trade",
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.svg`],
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
