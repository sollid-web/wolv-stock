import Link from "next/link";
import { getRWATokenList } from "@/lib/binance";
import { isQuoteFresh, quoteAgeSeconds, quoteUsd, type Q } from "@/lib/quotes";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets, type SpotAssetIdentity } from "@/lib/compliance";

export const dynamic = "force-dynamic";

const QUOTE_AMOUNT_USDT = 100;
const MAX_CONCURRENT_QUOTES = 4;

type RwaToken = SpotAssetIdentity & {
  underlyingTicker?: string | null;
  platformId?: string | null;
  tokenContractAddress: string;
  tokenToShareRatio?: string | number | null;
  referencePrice?: string | number | null;
  tokenLogoUrl?: string | null;
  volume24H?: string | number | null;
  statusInfo?: {
    marketStatus?: string | null;
    openState?: boolean | null;
  } | null;
};

type VenueResult = {
  token: RwaToken;
  quote: Q;
  multiplier: number;
  referencePrice: number;
  referencePerShare: number | null;
  executablePerShare: number | null;
  referenceGap: number | null;
  stale: boolean;
};

type OpportunityRow = {
  ticker: string;
  venues: VenueResult[];
  crossVenueSpread: number | null;
};

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(3)}%`;
}

function tone(value: number | null): string {
  if (value == null) return "text-[#64748b]";
  return Math.abs(value) < 0.25 ? "text-green-400" : Math.abs(value) < 1 ? "text-yellow-400" : "text-red-400";
}

function marketLabel(token: RwaToken): string {
  const status = token.statusInfo?.marketStatus;
  if (typeof status === "string" && status.trim()) return status;
  if (token.statusInfo?.openState === true) return "open";
  if (token.statusInfo?.openState === false) return "closed";
  return "status unavailable";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function buildVenueResult(token: RwaToken): Promise<VenueResult> {
  const quote = await quoteUsd(token.tokenContractAddress, QUOTE_AMOUNT_USDT);
  const multiplier = numberValue(token.tokenToShareRatio) || 1;
  const referencePrice = numberValue(token.referencePrice);
  const referencePerShare = referencePrice > 0 ? referencePrice / multiplier : null;
  const executablePerShare = quote.ok ? quote.usd / multiplier : null;
  const referenceGap = executablePerShare != null && referencePerShare != null && referencePerShare > 0
    ? (executablePerShare / referencePerShare - 1) * 100
    : null;

  return {
    token,
    quote,
    multiplier,
    referencePrice,
    referencePerShare,
    executablePerShare,
    referenceGap,
    stale: !isQuoteFresh(quote),
  };
}

export default async function GapPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const { n } = await searchParams;
  const limit = Math.min(40, Math.max(1, Number.parseInt(n ?? "8", 10) || 8));
  const tokensResponse = await getRWATokenList();
  const rawTokens = Array.isArray(tokensResponse?.data) ? tokensResponse.data : [];
  const all = filterSpotEligibleAssets(rawTokens as RwaToken[]);
  const grouped: Record<string, Record<string, RwaToken>> = {};

  for (const token of all) {
    if (!token.underlyingTicker || !token.platformId) continue;
    (grouped[token.underlyingTicker] ||= {})[token.platformId] ||= token;
  }

  const pairs = Object.entries(grouped)
    .filter(([, venues]) => Object.keys(venues).length >= 2)
    .map(([ticker, venues]) => ({ ticker, venues: Object.values(venues) }))
    .sort((a, b) => Math.max(...b.venues.map((token) => numberValue(token.volume24H))) - Math.max(...a.venues.map((token) => numberValue(token.volume24H))));
  const shown = pairs.slice(0, limit);
  const rows = await mapWithConcurrency(shown, MAX_CONCURRENT_QUOTES, async (pair): Promise<OpportunityRow> => {
    const venues = await mapWithConcurrency(pair.venues, MAX_CONCURRENT_QUOTES, buildVenueResult);
    const prices = venues.map((venue) => venue.executablePerShare).filter((value): value is number => value != null && value > 0);
    const crossVenueSpread = prices.length >= 2 ? (Math.max(...prices) / Math.min(...prices) - 1) * 100 : null;
    return { ticker: pair.ticker, venues, crossVenueSpread };
  });

  const unusual = all
    .filter((token) => Math.abs(numberValue(token.tokenToShareRatio) - 1) > 0.5)
    .sort((a, b) => Math.abs(numberValue(b.tokenToShareRatio) - 1) - Math.abs(numberValue(a.tokenToShareRatio) - 1));

  return (
    <main className="min-h-screen bg-[#07070f] pb-10 text-white">
      <nav className="sticky top-0 z-10 flex items-center gap-4 border-b border-[#1b1b35] bg-[#0e0e1c] px-4 py-4 sm:px-6">
        <Link href="/" className="text-xl text-[#64748b]">←</Link>
        <div>
          <div className="text-lg font-black">Listed vs Executable Price</div>
          <div className="text-xs text-[#64748b]">Updated {new Date().toISOString().slice(11, 19)} UTC · quote size {QUOTE_AMOUNT_USDT} USDT</div>
        </div>
      </nav>

      <div className="px-4 pt-6 sm:px-6">
        <div className="mb-5 max-w-4xl text-xs leading-relaxed text-[#94a3b8]">
          WOLV compares two different signals: Binance RWA reference data and what the aggregator currently quotes for a spot buy. Prices are normalized by each token&apos;s shares-per-token multiplier. A raw difference is not guaranteed profit; fees, gas, liquidity, slippage, quote age, and market status still matter.
        </div>
        <div className="mb-3 text-xs font-bold uppercase tracking-wider text-[#64748b]">
          Top {shown.length} of {pairs.length} cross-listed tickers by volume · add ?n=40 for all
        </div>

        <div className="mb-8 space-y-3">
          {rows.map((row) => (
            <div key={row.ticker} className="rounded-xl border border-[#1b1b35] bg-[#0e0e1c] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="font-bold">{row.ticker}</div>
                <div className={`text-right text-xs font-bold ${tone(row.crossVenueSpread)}`}>
                  {row.crossVenueSpread == null ? "cross-venue comparison unavailable" : `${signedPercent(row.crossVenueSpread)} executable spread per share`}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {row.venues.map((venue) => {
                  const quoteIsUsable = venue.quote.ok && !venue.stale;
                  return (
                    <Link key={venue.token.tokenContractAddress} href={`/stock/${venue.token.tokenContractAddress}`} className={`block rounded-lg border p-3 ${venue.stale ? "border-yellow-900/60" : "border-[#1b1b35]"}`}>
                      <div className="mb-2 flex items-center gap-2">
                        {venue.token.tokenLogoUrl && <img src={venue.token.tokenLogoUrl} className="h-5 w-5 rounded-full" alt={row.ticker} />}
                        <span className="text-xs capitalize text-[#64748b]">{venue.token.platformId}</span>
                        <span className="ml-auto text-[10px] text-[#64748b]">{marketLabel(venue.token)}</span>
                      </div>
                      {venue.quote.ok ? (
                        <>
                          <div className="text-sm font-black">
                            ${venue.executablePerShare?.toFixed(3) ?? "n/a"} <span className="text-xs font-normal text-[#64748b]">per share, executable</span>
                          </div>
                          <div className="text-xs text-[#64748b]">
                            reference {venue.referencePerShare == null ? "n/a" : `$${venue.referencePerShare.toFixed(3)}`} · {venue.multiplier.toFixed(4)}× shares/token
                          </div>
                          <div className={`text-xs font-bold ${tone(venue.referenceGap)}`}>
                            {venue.referenceGap == null ? "reference comparison unavailable" : `reference difference ${signedPercent(venue.referenceGap)}`}
                          </div>
                          <div className="mt-1 text-[10px] text-[#64748b]">
                            {venue.quote.vendor} · {venue.quote.mode} · impact {venue.quote.impact == null ? "n/a" : `${venue.quote.impact}%`} · {quoteAgeSeconds(venue.quote)}s old
                          </div>
                          {!quoteIsUsable && <div className="mt-2 text-[10px] font-bold uppercase tracking-wider text-yellow-500">Refresh before trading: quote is stale</div>}
                        </>
                      ) : (
                        <div className="text-xs text-yellow-500">Quote unavailable: {venue.quote.err}</div>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mb-3 text-xs font-bold uppercase tracking-wider text-[#64748b]">Unusual share multipliers ({unusual.length})</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {unusual.map((token) => (
            <Link key={token.tokenContractAddress} href={`/stock/${token.tokenContractAddress}`} className="rounded-lg border border-[#1b1b35] bg-[#0e0e1c] p-3 text-xs">
              <div className="font-bold">{token.underlyingTicker} <span className="font-normal capitalize text-[#64748b]">{token.platformId}</span></div>
              <div className="font-black text-[#f0b90b]">{numberValue(token.tokenToShareRatio).toFixed(3)}× shares/token</div>
            </Link>
          ))}
        </div>
      </div>

      <GlobalNav />
    </main>
  );
}
