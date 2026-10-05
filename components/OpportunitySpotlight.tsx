import Link from "next/link";
import OpportunityCard from "@/components/OpportunityCard";
import type { OpportunityRow } from "@/lib/opportunityMath";
import { QUOTE_AMOUNT_USDT } from "@/lib/opportunityMonitor";

export default function OpportunitySpotlight({ row, feedUnavailable = false }: { row?: OpportunityRow; feedUnavailable?: boolean }) {
  return (
    <section aria-labelledby="opportunity-spotlight-title" className="relative min-w-0 overflow-hidden rounded-2xl border border-[#f0b90b]/25 bg-gradient-to-br from-[#151322] via-[#0e0e1c] to-[#0a0a14] p-4 shadow-[0_20px_70px_rgba(0,0,0,.34)] sm:p-5">
      <div className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-[#f0b90b]/[0.06] blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#f0b90b]">
            {!feedUnavailable && <span className="wolv-pulse size-1.5 rounded-full bg-[#f0b90b]" />}
            {feedUnavailable ? "Executable-price monitor" : "Live executable-price monitor"}
          </div>
          <h2 id="opportunity-spotlight-title" className="mt-2 text-lg font-black leading-tight text-white sm:text-xl">Reference price ≠ executable price</h2>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-slate-400">
            {QUOTE_AMOUNT_USDT} USDT spot-buy quotes, normalized to the underlying share. Fresh, reference-backed venues inform the spread; stale, outlier, or incomplete comparisons are labelled and excluded.
          </p>
        </div>
        <Link href="/gap" className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-[#f0b90b]/35 bg-[#f0b90b]/10 px-3 py-2 text-xs font-bold text-[#f0b90b] transition hover:bg-[#f0b90b]/20">
          Full monitor <span aria-hidden="true" className="ml-1">→</span>
        </Link>
      </div>

      <div className="relative mt-4">
        {feedUnavailable ? (
          <div role="status" className="rounded-xl border border-yellow-800/50 bg-yellow-900/[0.06] p-4 text-xs leading-relaxed text-yellow-200">
            <div className="font-bold">Live RWA data feed unavailable</div>
            <div className="mt-1 text-yellow-100/70">No reference-backed executable comparison is shown until the feed returns. WOLV does not infer a price or spread from missing data.</div>
          </div>
        ) : row ? (
          <OpportunityCard row={row} />
        ) : (
          <div role="status" className="rounded-xl border border-white/[0.08] bg-[#0a0a14]/80 p-4 text-xs leading-relaxed text-slate-400">
            No cross-listed quote is available right now. The full monitor explains missing, stale, and unreliable data; WOLV does not present a spread as guaranteed profit.
          </div>
        )}
      </div>
      <p className="relative mt-3 text-[10px] leading-relaxed text-slate-500">
        Reference fields come from Binance RWA data; they are not an independent stock-market feed. A visible spread is not profit and does not account for fees, gas, liquidity, slippage, or execution changes.
      </p>
    </section>
  );
}
