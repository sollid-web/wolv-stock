import Link from "next/link";
import { getRWATokenList } from "@/lib/binance";
import GlobalNav from "@/components/GlobalNav";
import BrandMark from "@/components/BrandMark";
import OpportunityCard from "@/components/OpportunityCard";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { isRwaAssetListResponse } from "@/lib/rwaAssetResponse";
import { parseRwaAssetRecords } from "@/lib/spotAssets";
import { getOpportunityRows, QUOTE_AMOUNT_USDT } from "@/lib/opportunityMonitor";
import {
  getCrossListedPairs,
  MAX_RELIABLE_GAP_PERCENT,
  positiveNumberValue,
} from "@/lib/opportunityMath";

export const dynamic = "force-dynamic";

export default async function OpportunityMonitor({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  const { n } = await searchParams;
  const limit = Math.min(40, Math.max(1, Number.parseInt(n ?? "8", 10) || 8));

  let tokens = [] as ReturnType<typeof parseRwaAssetRecords>;
  let feedUnavailable = false;
  try {
    const response: unknown = await getRWATokenList();
    if (!isRwaAssetListResponse(response, { allowEmpty: true })) {
      throw new Error("The RWA asset response could not be validated");
    }
    tokens = filterSpotEligibleAssets(parseRwaAssetRecords(response));
  } catch (error) {
    console.error("Opportunity monitor feed unavailable:", error);
    feedUnavailable = true;
  }

  const pairs = feedUnavailable ? [] : getCrossListedPairs(tokens);
  const rows = feedUnavailable ? [] : await getOpportunityRows(tokens, limit);
  const unusual = tokens
    .filter((token) => {
      const multiplier = positiveNumberValue(token.tokenToShareRatio);
      return multiplier != null && Math.abs(multiplier - 1) > 0.5;
    })
    .sort((a, b) =>
      Math.abs((positiveNumberValue(b.tokenToShareRatio) ?? 1) - 1) -
      Math.abs((positiveNumberValue(a.tokenToShareRatio) ?? 1) - 1)
    );

  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <nav className="sticky top-0 z-10 border-b border-white/[0.1] bg-[#070711]/72 px-4 py-4 backdrop-blur-2xl sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <BrandMark compact />
            <div className="hidden h-7 w-px bg-white/10 sm:block" />
          <div className="min-w-0">
            <h1 className="break-words text-base font-black sm:text-lg">Listed vs Executable Price</h1>
            <p className="break-words text-xs text-[#64748b]">
              Reference price vs executable route · {QUOTE_AMOUNT_USDT} USDT quote size · BSC spot
            </p>
          </div>
          </div>
          <Link href="/markets" className="shrink-0 rounded-full border border-white/10 px-3 py-2 text-xs font-bold text-slate-300 transition hover:border-[#d9a80a]/40 hover:text-[#d9a80a]">
            Browse markets
          </Link>
        </div>
      </nav>

      <section className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
        <div className="mb-5 max-w-4xl text-xs leading-relaxed text-[#94a3b8]">
          WOLV compares Binance RWA reference data with the current executable spot quote, normalized per share. A displayed difference is not guaranteed profit; fees, gas, liquidity, slippage, quote age, and market sessions still matter.
        </div>
        <div className="mb-4 grid grid-cols-1 items-start gap-1 text-xs font-bold uppercase tracking-[0.12em] text-[#64748b] sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
          <span>
            {feedUnavailable
              ? "Live comparison unavailable"
              : `Showing ${rows.length} of ${pairs.length} cross-listed tickers`}
          </span>
          <span>{feedUnavailable ? "No price or opportunity inferred" : `${tokens.length} eligible BSC asset records`}</span>
        </div>

        {feedUnavailable ? (
          <div role="alert" className="mb-6 rounded-xl border border-yellow-800/50 bg-yellow-900/10 p-4 text-sm leading-relaxed text-yellow-200">
            <div className="font-bold">Live RWA data feed unavailable</div>
            <p className="mt-1 text-xs text-yellow-100/80">
              WOLV could not validate the asset list. It has not substituted zero prices or inferred a comparison. Try again when the upstream feed is available.
            </p>
          </div>
        ) : rows.length > 0 ? (
          <div className="mb-8 space-y-4">
            {rows.map((row) => <OpportunityCard key={row.ticker} row={row} />)}
          </div>
        ) : (
          <div role="status" className="mb-8 rounded-xl border border-white/[0.08] bg-white/[0.03] p-6 text-center text-sm text-slate-300">
            No cross-listed tickers are available for a reliable comparison right now.
          </div>
        )}

        {!feedUnavailable && (
          <>
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-[#64748b]">
              Unusual share multipliers ({unusual.length})
            </div>
            {unusual.length > 0 ? (
              <div className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {unusual.map((token) => (
                  <Link
                    key={token.tokenContractAddress}
                    href={`/stock/${token.tokenContractAddress}`}
                    className="min-w-0 rounded-lg border border-[#1b1b35] bg-[#0e0e1c] p-3 text-xs"
                  >
                    <div className="break-words font-bold">
                      {token.underlyingTicker} <span className="font-normal capitalize text-[#64748b]">{token.platformId}</span>
                    </div>
                    <div className="break-words font-black text-[#d9a80a]">
                      {positiveNumberValue(token.tokenToShareRatio)?.toFixed(3)}× shares/token
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="mb-8 text-xs text-slate-500">No unusual share multipliers were identified in the current asset list.</p>
            )}
          </>
        )}

        <p className="mb-6 max-w-4xl text-[11px] leading-relaxed text-slate-500">
          Quotes more than {MAX_RELIABLE_GAP_PERCENT}% from their reference, stale quotes, and incomplete comparisons are excluded from spread ranking. This monitor is informational; check the current quote, simulation, network, approvals, and wallet prompt before any trade.
        </p>
      </section>
      <GlobalNav />
    </main>
  );
}
