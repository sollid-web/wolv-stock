"use client";

import Link from "next/link";
import WalletSelector from "@/components/WalletSelector";
import NetworkSwitchModal from "@/components/NetworkSwitchModal";
import { useWallet } from "@/hooks/useWallet";
import { useIsHydrated } from "@/hooks/useIsHydrated";
import { useState } from "react";
import GlobalNav from "@/components/GlobalNav";
import WalletPortfolio from "@/components/WalletPortfolio";

export const dynamic = "force-dynamic";

export default function WalletPage() {
  const isHydrated = useIsHydrated();
  const {
    address,
    chainId,
    isConnected,
    isCorrectNetwork,
    isConnecting,
    isInitializing,
    error,
    walletConnectAvailable,
    connect,
    disconnect,
    switchToBscMainnet,
  } = useWallet();
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false);

  const handleNetworkSwitch = async () => {
    setIsSwitchingNetwork(true);
    try {
      await switchToBscMainnet();
    } finally {
      setIsSwitchingNetwork(false);
    }
  };

  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <nav className="sticky top-0 z-10 flex items-center gap-4 border-b border-white/[0.1] bg-[#070711]/72 px-4 py-4 backdrop-blur-2xl sm:px-6">
        <Link href="/" className="text-[#64748b] text-xl">←</Link>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#d9a80a] flex items-center justify-center font-black text-black text-sm">W</div>
          <span className="font-bold text-lg tracking-wide">WOLV Spot Lens</span>
        </div>
      </nav>

      <div className="mx-auto w-full max-w-md px-4 pt-6 sm:px-6">
        {(!isHydrated || isInitializing) && (
          <div className="text-center py-8">
            <div className="animate-spin w-8 h-8 border-2 border-[#d9a80a] border-t-transparent rounded-full" />
            <p className="mt-2 text-xs text-[#64748b]">Checking wallet connection...</p>
          </div>
        )}

        {isHydrated && !isInitializing && isConnecting && (
          <div className="text-center py-8">
            <div className="animate-spin w-8 h-8 border-2 border-[#d9a80a] border-t-transparent rounded-full" />
            <p className="mt-2 text-xs text-[#64748b]">Connecting...</p>
          </div>
        )}

        {isHydrated && !isInitializing && !isConnected && !isConnecting && (
            <WalletSelector
              isConnecting={isConnecting}
              error={error}
              walletConnectAvailable={walletConnectAvailable}
              onConnect={connect}
            />
        )}

        {isHydrated && !isInitializing && isConnected && !isConnecting && (
          <div className="space-y-6">
            <NetworkSwitchModal
              open={!isCorrectNetwork}
              isSwitching={isSwitchingNetwork}
              onSwitch={handleNetworkSwitch}
            />

            <div className="wolv-glass rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs text-[#64748b] font-medium">Wallet Address</div>
                <button
                  onClick={() => navigator.clipboard.writeText(address || "")}
                  className="text-xs text-[#d9a80a] hover:text-[#d9a80a]/80"
                >
                  Copy
                </button>
              </div>
              <div className="font-mono text-xs text-[#d9a80a]">
                {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "—"}
              </div>
            </div>

            <div className="wolv-glass rounded-xl p-6">
              <div className="text-xs text-[#64748b] font-medium mb-2">Network Status</div>
              <div className="flex items-center space-x-3">
                <div className={`w-3 h-3 rounded-full ${isCorrectNetwork ? "bg-[#d9a80a]" : "bg-[#ef4444]"}`}></div>
                <span className={isCorrectNetwork ? "text-xs text-[#d9a80a]" : "text-xs text-[#ef4444]"}>
                  {isCorrectNetwork ? `BSC Mainnet (Chain ID: 56)` : `Unsupported network detected (Chain ID: ${chainId ?? "unknown"})`}
                </span>
              </div>
            </div>

            {address && <WalletPortfolio address={address} enabled={isCorrectNetwork} />}

            <div className="mt-8">
              <button
                onClick={disconnect}
                className="wolv-glass-control w-full max-w-xs rounded-xl bg-red-500/80 px-6 py-3 font-bold text-white hover:bg-red-500"
              >
                Disconnect Wallet
              </button>
            </div>
          </div>
        )}
      </div>

      <GlobalNav />
    </main>
  );
}
