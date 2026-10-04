"use client";

import { useRef, useState } from "react";
import { useAppKit, useAppKitState } from "@reown/appkit/react";

interface WalletSelectorProps {
  isConnecting: boolean;
  error: string | null;
  walletConnectAvailable: boolean;
  onConnect: (wallet: "injected" | "walletConnect") => Promise<void>;
}

function AppKitConnectButton() {
  const { open } = useAppKit();
  const { open: modalOpen, connectingWallet } = useAppKitState();
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const openInFlight = useRef(false);

  const handleOpen = async () => {
    if (openInFlight.current || modalOpen || connectingWallet) return;
    openInFlight.current = true;
    setIsOpening(true);
    setOpenError(null);
    try {
      await open({ view: "Connect", namespace: "eip155" });
    } catch {
      setOpenError("Could not open the wallet selector. Close any pending wallet prompt and retry.");
    } finally {
      openInFlight.current = false;
      setIsOpening(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleOpen()}
      disabled={isOpening || modalOpen || Boolean(connectingWallet)}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#f0b90b] px-5 text-sm font-bold text-black transition-colors hover:bg-[#ffd44d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:opacity-60"
    >
      {isOpening || modalOpen || connectingWallet ? "Wallet connection pending..." : "Connect wallet"}
      <span aria-hidden="true">→</span>
    </button>
    {openError && <p role="alert" className="mt-3 text-sm text-rose-400">{openError}</p>}
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
            <div className="inline-flex items-center gap-2 rounded-full border border-[#f0b90b]/30 bg-[#f0b90b]/[0.08] px-3 py-1.5 text-xs font-semibold text-[#f0b90b]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#f0b90b]" />
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
