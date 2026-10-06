"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Holding = {
  binanceChainId: string;
  tokenContractAddress: string;
  symbol: string;
  balance: number | null;
  rawBalance: string | null;
  tokenPriceUsd: number | null;
  valueUsd: number | null;
  isRiskToken: boolean;
};

type PortfolioOverview = {
  realizedPnlUsd?: string | number;
  realizedPnlPercent?: string | number;
  winRate?: string | number;
  buyTxCount?: string | number;
  sellTxCount?: string | number;
  totalTokenCount?: string | number;
  buyTxVolume?: string | number;
  sellTxVolume?: string | number;
};

type PortfolioResponse = {
  holdings: Holding[];
  overview: PortfolioOverview | null;
  fetchedAt: number;
};

function numberValue(value: string | number | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usd(value: number | null): string {
  return value == null ? "—" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(value: string | number | undefined): string {
  const parsed = numberValue(value);
  return parsed == null ? "—" : `${parsed.toFixed(2)}%`;
}

export default function WalletPortfolio({ address, enabled }: { address: string; enabled: boolean }) {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!enabled || !address) {
      return;
    }

    const controller = new AbortController();
    // This effect owns the request lifecycle; initialize its loading/error state before fetching.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch(`/api/wallet/portfolio?address=${encodeURIComponent(address)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json() as PortfolioResponse & { error?: string };
        if (!response.ok) throw new Error(result.error || "Portfolio lookup failed");
        return result;
      })
      .then((result) => setData(result))
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Portfolio lookup failed");
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [address, enabled, retryKey]);

  if (!enabled) {
    return (
      <div className="rounded-xl border border-yellow-900/50 bg-yellow-900/10 p-4 text-xs text-yellow-400">
        Switch to BNB Smart Chain Mainnet to load BSC holdings and portfolio statistics.
      </div>
    );
  }

  if (isLoading && !data) {
    return <div className="rounded-xl border border-[#1b1b35] bg-[#0e0e1c] p-6 text-xs text-[#64748b]">Loading read-only BSC holdings…</div>;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-900/10 p-4 text-xs text-red-300">
        <div className="font-bold">Holdings unavailable</div>
        <div className="mt-1">{error}</div>
        <div className="mt-2 text-red-400/80">No transaction or signing action was performed.</div>
        <button
          type="button"
          onClick={() => setRetryKey((current) => current + 1)}
          className="mt-3 rounded-lg border border-red-400/40 px-3 py-2 font-bold text-red-200 hover:border-red-300"
        >
          Retry read-only lookup
        </button>
      </div>
    );
  }

  if (!data) return null;

  const overview = data.overview;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#1b1b35] bg-[#0e0e1c] p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-[#64748b]">Portfolio overview</div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-[#64748b]">Binance read-only data · trailing 7 days</div>
          </div>
          <div className="text-right text-[10px] text-[#64748b]">{data.holdings.length} visible assets</div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Realized PnL" value={usd(numberValue(overview?.realizedPnlUsd))} tone={(numberValue(overview?.realizedPnlUsd) ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
          <Metric label="PnL %" value={percent(overview?.realizedPnlPercent)} tone={(numberValue(overview?.realizedPnlPercent) ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
          <Metric label="Win rate" value={percent(overview?.winRate)} />
          <Metric label="Trades" value={`${numberValue(overview?.buyTxCount) ?? 0} buy · ${numberValue(overview?.sellTxCount) ?? 0} sell`} />
        </div>
      </div>

      <div className="rounded-xl border border-[#1b1b35] bg-[#0e0e1c] p-6">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs font-medium text-[#64748b]">BSC token holdings</div>
          {isLoading && <div className="text-[10px] text-[#64748b]">Refreshing…</div>}
        </div>
        {data.holdings.length === 0 ? (
          <div className="text-xs text-[#64748b]">No non-zero BSC token balances were returned for this wallet.</div>
        ) : (
          <div className="space-y-2">
            {data.holdings.map((holding) => (
              <div key={`${holding.binanceChainId}:${holding.tokenContractAddress}:${holding.symbol}`} className="flex items-center justify-between gap-3 border-b border-[#1b1b35] pb-3 last:border-none last:pb-0">
                <div className="min-w-0">
                  {holding.tokenContractAddress ? (
                    <Link href={`/stock/${holding.tokenContractAddress}`} className="font-bold text-white hover:text-[#d9a80a]">{holding.symbol}</Link>
                  ) : (
                    <span className="font-bold text-white">{holding.symbol}</span>
                  )}
                  <div className="truncate text-[10px] text-[#64748b]">{holding.balance == null ? "Balance unavailable" : holding.balance.toLocaleString(undefined, { maximumFractionDigits: 8 })} units · {holding.binanceChainId === "56" ? "BSC" : `Chain ${holding.binanceChainId}`}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-[#d9a80a]">{usd(holding.valueUsd)}</div>
                  <div className="text-[10px] text-[#64748b]">{holding.tokenPriceUsd == null ? "price unavailable" : `${usd(holding.tokenPriceUsd)} / unit`}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-[10px] leading-relaxed text-[#64748b]">
        Holdings and metrics are read from Binance Web3 API for the connected address. WOLV does not custody assets, infer cost basis, or execute any action from this view. Last response: {new Date(data.fetchedAt).toLocaleTimeString()}.
      </div>
    </div>
  );
}

function Metric({ label, value, tone = "text-white" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-[#1b1b35] bg-[#0b0b17] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[#64748b]">{label}</div>
      <div className={`mt-1 truncate text-sm font-black ${tone}`}>{value}</div>
    </div>
  );
}
