"use client";

import { useAppKit } from "@reown/appkit/react";

interface WalletSelectorProps {
  isConnecting: boolean;
  error: string | null;
  walletConnectAvailable: boolean;
  onConnect: (wallet: "injected" | "walletConnect") => Promise<void>;
}

function AppKitConnectButton() {
  const { open } = useAppKit();

  return (
    <button
      type="button"
      onClick={() => void open({ view: "Connect", namespace: "eip155" })}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#f0b90b] px-5 text-sm font-bold text-black transition-colors hover:bg-[#ffd44d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      Connect wallet
      <span aria-hidden="true">→</span>
    </button>
  );
}

export default function WalletSelector({
  isConnecting,
  error,
  walletConnectAvailable,
  onConnect,
}: WalletSelectorProps) {
  return (
    <section className="w-full py-8">
      {isConnecting ? (
        <div className="flex flex-col items-center py-10 text-center" role="status">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-[#f0b90b] border-t-transparent" />
          <p className="text-sm text-slate-300">Connecting to wallet...</p>
        </div>
      ) : (
        <>
          <header className="mb-7 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/5 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              BSC MAINNET · CHAIN 56
            </div>
            <h1 className="mt-5 text-2xl font-bold">Connect your wallet</h1>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Choose a browser wallet or connect a mobile wallet with WalletConnect.
            </p>
          </header>

          <div className="rounded-xl border border-[#27273c] bg-[#0e0e1c]/90 p-5 shadow-2xl shadow-black/20 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Wallet connection</h2>
              <span className="text-xs text-slate-400">Secure · non-custodial</span>
            </div>
            {walletConnectAvailable ? (
              <AppKitConnectButton />
            ) : (
              <button
                type="button"
                onClick={() => void onConnect("injected")}
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#f0b90b] px-5 text-sm font-bold text-black transition-colors hover:bg-[#ffd44d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Connect browser wallet
                <span aria-hidden="true">→</span>
              </button>
            )}
            <p className="mt-4 text-center text-xs leading-5 text-slate-400">
              Your wallet approves each connection and transaction. WOLV never receives your recovery phrase.
            </p>
          </div>

          {error && (
            <div role="alert" className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-rose-400">
              <p className="text-sm font-semibold">Wallet connection issue</p>
              <p className="mt-1.5 text-sm leading-6">{error}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}