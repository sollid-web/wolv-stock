interface WalletSelectorProps {
  isConnecting: boolean;
  error: string | null;
  walletConnectAvailable: boolean;
  onConnect: (wallet: "injected" | "walletConnect") => Promise<void>;
}

// NOTE: this component intentionally does NOT call useWallet() itself.
// It previously did, which meant it was creating a second, independent
// wallet-state instance alongside whatever parent already called
// useWallet() (before useWallet became a shared context). It only ever
// used the onConnect prop anyway, so the extra hook call was dead code
// that could still fire its own connect/listener effects.
export default function WalletSelector({
  isConnecting,
  error,
  walletConnectAvailable,
  onConnect
}: WalletSelectorProps) {
  return (
    <section className="w-full py-8">
      {isConnecting ? (
        <div className="flex flex-col items-center py-10 text-center" role="status">
          <div className="animate-spin w-8 h-8 border-2 border-[#f0b90b] border-t-transparent rounded-full mb-4" />
          <p className="text-sm text-slate-300">Connecting to wallet...</p>
        </div>
      ) : (
        <>
          <header className="text-center mb-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/5 px-3 py-1.5 text-xs font-semibold tracking-wide text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              BSC MAINNET · CHAIN 56
            </div>
            <h1 className="mt-5 text-2xl font-bold tracking-tight">Connect your wallet</h1>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Choose a wallet to access your portfolio and trade tokenized assets.
            </p>
          </header>

          <div className="rounded-2xl border border-[#27273c] bg-[#0e0e1c]/90 p-4 shadow-2xl shadow-black/20 backdrop-blur sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Available wallets</h2>
              <span className="text-xs text-slate-400">Secure connection</span>
            </div>
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => onConnect("injected")}
                className="group flex min-h-16 w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0b90b]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f0b90b]/15 text-base font-black text-[#f0b90b]">W</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white">Browser wallet</span>
                  <span className="mt-0.5 block text-xs text-slate-400">MetaMask, Trust Wallet, or another injected wallet</span>
                </span>
                <span aria-hidden="true" className="text-lg text-slate-500 transition-colors group-hover:text-white">›</span>
              </button>
              <button
                type="button"
                onClick={() => onConnect("walletConnect")}
                disabled={!walletConnectAvailable}
                className="group flex min-h-16 w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0b90b] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/10 disabled:hover:bg-white/[0.03]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#3b99fc]/15 text-base font-black text-[#63b3ff]">W</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white">WalletConnect</span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {walletConnectAvailable ? "Scan with a mobile wallet" : "Not configured for this app"}
                  </span>
                </span>
                {walletConnectAvailable && <span aria-hidden="true" className="text-lg text-slate-500 transition-colors group-hover:text-white">›</span>}
              </button>
            </div>
            <p className="mt-4 text-center text-xs leading-5 text-slate-400">
              Browser wallets use the injected provider; WalletConnect opens a separate mobile-wallet session.
            </p>
          </div>

          {error && (
            <div role="alert" className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-rose-400 backdrop-blur">
              <p className="text-sm font-semibold">⚠️ Wallet connection issue</p>
              <p className="mt-1.5 text-sm leading-6">{error}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}