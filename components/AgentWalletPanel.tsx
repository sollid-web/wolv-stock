"use client";

import { useCallback, useState } from "react";

type BawChain = { binanceChainId: string; name: string; simpleName: string };
type BawAddress = { binanceChainId: string; chainName: string; address: string };
type BawBalance = {
  symbol: string;
  contractAddress: string;
  binanceChainId: string;
  balance: string;
  priceUsd: string;
  valueUsd: string;
};
type BawSafeSettings = {
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  abnormalTxnHandling: string;
  tradeAllTokens: boolean;
  predictionEnabled: boolean;
};
type BawWalletSnapshot = {
  connected: boolean;
  fetchedAt: string;
  chains: BawChain[];
  addresses: BawAddress[];
  balances: BawBalance[];
  settings: BawSafeSettings | null;
  errors: { section: string; code: string }[];
};

const panelClass = "wolv-glass rounded-2xl p-5";

function formatUsd(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (Math.abs(parsed) < 0.01 && parsed !== 0) return `$${parsed}`;
  return `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AgentWalletPanel() {
  const [accessToken, setAccessToken] = useState("");
  const [snapshot, setSnapshot] = useState<BawWalletSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) {
      setSnapshot(null);
      setError("Enter the server-configured operator access token to load wallet data.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent/wallet", {
        cache: "no-store",
        credentials: "omit",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data.message === "string" ? data.message : "Wallet status could not be loaded."
        );
      }
      setSnapshot(data as BawWalletSnapshot);
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "Wallet status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  const settings = snapshot?.settings ?? null;

  return (
    <section className={panelClass} aria-labelledby="baw-wallet-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="baw-wallet-heading" className="text-lg font-bold text-white">Operator wallet (BAW)</h2>
          <p className="mt-2 text-xs leading-5 text-slate-300">
            Read-only view of the Binance Agentic Wallet CLI session on this host. This is the
            operator&apos;s wallet, not the wallet connected in your browser — it does not trade
            from this page.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label className="sr-only" htmlFor="baw-operator-token">Operator access token</label>
        <input
          id="baw-operator-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={accessToken}
          onChange={(event) => {
            setAccessToken(event.target.value);
            setSnapshot(null);
            setError("");
          }}
          placeholder="Server-configured operator access token"
          className="w-full min-h-10 rounded-lg border border-white/[0.1] bg-black/20 px-3 text-xs text-white placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={loading || !accessToken}
          className="min-h-10 shrink-0 rounded-lg border border-[#FFC700]/35 px-3 text-[10px] font-bold text-[#FFC700] transition hover:bg-[#FFC700]/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Checking…" : snapshot ? "Refresh" : "Load wallet"}
        </button>
        {accessToken && (
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setAccessToken("");
              setSnapshot(null);
              setError("");
            }}
            className="min-h-10 shrink-0 rounded-lg border border-white/[0.1] px-3 text-[10px] font-bold text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Forget
          </button>
        )}
      </form>
      <p className="mt-2 text-[10px] leading-5 text-slate-400">
        The token is held in memory only and is sent only to this read-only wallet endpoint.
      </p>

      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{error}</p>}

      {!snapshot && !error && (
        <p role="status" className="mt-4 text-xs text-slate-400">
          Wallet status has not been loaded.
        </p>
      )}

      {snapshot && !error && (
        <dl className="mt-4 space-y-3 text-xs">
          <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
            <dt className="text-slate-400">CLI session</dt>
            <dd className={`font-semibold ${snapshot?.connected ? "text-emerald-300" : "text-amber-200"}`}>
              {loading && !snapshot ? "Checking…" : snapshot?.connected ? "Connected" : snapshot ? "Not connected" : "Unavailable"}
            </dd>
          </div>
          {snapshot?.connected && (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <dt className="text-slate-400">Supported chains</dt>
                <dd className="text-right font-semibold text-slate-300">
                  {snapshot.chains.length
                    ? snapshot.chains.map((chain) => chain.simpleName).join(", ")
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Addresses</dt>
                <dd>
                  {snapshot.addresses.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {snapshot.addresses.map((entry) => (
                        <li key={`${entry.binanceChainId}-${entry.address}`} className="flex items-start justify-between gap-3">
                          <span className="text-slate-400">{entry.chainName}</span>
                          <span className="break-all text-right font-mono text-[10px] text-slate-200">{entry.address}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-slate-300">—</p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Balances</dt>
                <dd>
                  {snapshot.balances.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {snapshot.balances.map((entry) => (
                        <li key={`${entry.binanceChainId}-${entry.contractAddress}`} className="flex items-start justify-between gap-3">
                          <span className="text-slate-300">
                            {entry.balance} {entry.symbol}
                            <span className="ml-2 text-slate-500">chain {entry.binanceChainId}</span>
                          </span>
                          <span className="text-right font-semibold text-slate-200">{formatUsd(entry.valueUsd)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-slate-300">No non-zero balances.</p>
                  )}
                </dd>
              </div>
              {settings && (
                <div>
                  <dt className="text-slate-400">Security settings (read-only)</dt>
                  <dd>
                    <ul className="mt-2 space-y-1.5 text-slate-300">
                      <li className="flex justify-between gap-3"><span>Daily limit</span><span className="font-semibold text-slate-200">{formatUsd(String(settings.dailyLimit))} · used {formatUsd(String(settings.quotaUsed))}</span></li>
                      <li className="flex justify-between gap-3"><span>Abnormal transaction handling</span><span className="font-semibold text-slate-200">{settings.abnormalTxnHandling}</span></li>
                      <li className="flex justify-between gap-3"><span>Trade all tokens</span><span className="font-semibold text-slate-200">{settings.tradeAllTokens ? "yes" : "no"}</span></li>
                      <li className="flex justify-between gap-3"><span>Prediction markets enabled</span><span className="font-semibold text-slate-200">{settings.predictionEnabled ? "yes" : "no"}</span></li>
                    </ul>
                  </dd>
                </div>
              )}
            </>
          )}
          {snapshot?.errors.length ? (
            <div>
              <dt className="text-amber-200">Section read failures</dt>
              <dd>
                <ul className="mt-2 space-y-1">
                  {snapshot.errors.map((entry) => (
                    <li key={entry.section} className="text-slate-400">{entry.section}: {entry.code}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      )}
      <p className="mt-4 text-[10px] leading-5 text-slate-400">
        Snapshot time: {snapshot?.fetchedAt ?? "—"}. No trading commands are issued by this panel;
        balances and settings are read from the local CLI session only.
      </p>
    </section>
  );
}
