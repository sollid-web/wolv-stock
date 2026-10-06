"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { OpportunityRow, VenueResult } from "@/lib/opportunityMath";

type Analysis = {
  source: string;
  headline: string;
  summary: string;
  reasons: string[];
  nextStep: string;
  tone: "positive" | "caution" | "neutral";
  checkedAt: number;
  dataSources: string[];
  observations: {
    platform: string;
    status: string;
    quoteAvailable: boolean;
    quoteAgeSeconds: number | null;
    stale: boolean;
  }[];
};

function isComparable(venue: VenueResult): boolean {
  return venue.quote.ok && !venue.stale && !venue.unreliable && venue.referencePerShare != null && venue.executablePerShare != null;
}

export default function MarketAnalysis({ row }: { row: OpportunityRow }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const best = row.venues.find(isComparable) ?? row.venues.find((venue) => venue.quote.ok) ?? row.venues[0];

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = dialog?.querySelectorAll<HTMLElement>(focusableSelector);
    focusable?.[0]?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const items = dialog.querySelectorAll<HTMLElement>(focusableSelector);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [open]);

  async function analyze() {
    if (loading) return;
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker: row.ticker }),
      });
      const payload = await response.json() as Analysis & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Analysis is temporarily unavailable");
      setAnalysis(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis is temporarily unavailable");
    } finally {
      setLoading(false);
    }
  }

  const tone = analysis?.tone === "positive"
    ? "border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-200"
    : analysis?.tone === "caution"
      ? "border-amber-400/25 bg-amber-400/[0.06] text-amber-200"
      : "border-sky-300/20 bg-sky-300/[0.05] text-sky-200";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={analyze}
        disabled={loading}
        aria-label={`Ask WOLV AI to analyze ${row.ticker}`}
        className="flex-1 rounded-lg border border-sky-300/20 bg-sky-300/[0.04] px-3 py-2.5 text-center text-[10px] font-bold text-sky-200 transition hover:-translate-y-0.5 hover:border-sky-300/40 hover:bg-sky-300/[0.1] disabled:cursor-wait disabled:opacity-50"
      >
        <span className="mr-1.5 inline-block text-sky-300" aria-hidden="true">✦</span>{loading ? "Analyzing…" : "Analyse"}
      </button>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby={`analysis-${row.ticker}`}>
          <div ref={dialogRef} tabIndex={-1} className="w-full max-w-xl overflow-hidden rounded-2xl border border-sky-300/20 bg-[#0b1017] shadow-[0_24px_90px_rgba(0,0,0,.6)]">
            <div className="relative overflow-hidden border-b border-white/[0.08] p-5 sm:p-6">
              <div className="wolv-grid pointer-events-none absolute inset-0 opacity-30" />
              <div className="relative flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.18em] text-sky-300"><span className="wolv-pulse size-1.5 rounded-full bg-sky-300" /> WOLV AI market read</div>
                  <h2 id={`analysis-${row.ticker}`} className="mt-2 text-2xl font-black text-white">{row.ticker} <span className="text-slate-500">/</span> live context</h2>
                  <p className="mt-1 text-xs text-slate-400">A server-derived read. The request uses this ticker only; market data is fetched again on the server.</p>
                </div>
                <button type="button" onClick={() => setOpen(false)} className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/[0.1] text-lg text-slate-400 transition hover:bg-white/[0.06] hover:text-white" aria-label="Close analysis">×</button>
              </div>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-5 sm:p-6">
              {loading ? (
                <div className="space-y-3" aria-live="polite">
                  <div className="flex items-center gap-3 text-sm font-bold text-white"><span className="size-2 animate-ping rounded-full bg-sky-300" />Reading the market signal…</div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {["Checking freshness", "Comparing venues", "Writing explanation"].map((step, index) => <div key={step} className="animate-pulse rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 text-[10px] text-slate-400" style={{ animationDelay: `${index * 160}ms` }}>{step}</div>)}
                  </div>
                </div>
              ) : error ? (
                <div role="alert" className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-sm text-amber-200">{error}</div>
              ) : analysis ? (
                <div className="space-y-4" aria-live="polite">
                  <div className={`rounded-xl border p-4 ${tone}`}>
                    <div className="text-[9px] font-bold uppercase tracking-wider opacity-70">{analysis.source}</div>
                    <h3 className="mt-1 text-lg font-black">{analysis.headline}</h3>
                    <p className="mt-2 text-xs leading-5 opacity-85">{analysis.summary}</p>
                  </div>
                  <div>
                    <div className="mb-2 text-[9px] font-bold uppercase tracking-wider text-slate-500">Why WOLV says this</div>
                    <ul className="space-y-2">
                      {analysis.reasons.map((reason) => <li key={reason} className="flex gap-2 rounded-lg border border-white/[0.07] bg-black/20 p-3 text-xs leading-5 text-slate-300"><span className="mt-1 text-sky-300">◆</span><span>{reason}</span></li>)}
                    </ul>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {analysis.observations.map((observation) => (
                      <span key={observation.platform} className={`rounded-md border px-2 py-1 text-[9px] ${observation.stale ? "border-amber-400/20 text-amber-200" : "border-white/[0.08] text-slate-400"}`}>
                        {observation.platform} · {observation.status} · {observation.quoteAvailable ? `${observation.quoteAgeSeconds}s${observation.stale ? " stale" : ""}` : "quote unavailable"}
                      </span>
                    ))}
                  </div>
                  <p className="text-[9px] text-slate-500">{analysis.dataSources.join(" · ")} · checked {new Date(analysis.checkedAt).toLocaleTimeString()}</p>
                  <div className="rounded-xl border border-[#d9a80a]/20 bg-[#d9a80a]/[0.05] p-4">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-[#d9a80a]">Suggested next step</div>
                    <p className="mt-1 text-xs leading-5 text-slate-200">{analysis.nextStep}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t border-white/[0.07] pt-4">
                    {best && <Link href={`/stock/${best.token.tokenContractAddress}`} onClick={() => setOpen(false)} className="inline-flex min-h-10 items-center rounded-lg border border-white/[0.12] px-4 text-xs font-bold text-slate-200 transition hover:border-white/25 hover:bg-white/[0.05]">Open full analysis</Link>}
                    {best && isComparable(best) && <Link href={`/trade/${best.token.tokenContractAddress}`} onClick={() => setOpen(false)} className="inline-flex min-h-10 items-center rounded-lg bg-[#d9a80a] px-4 text-xs font-black text-[#111] transition hover:bg-[#f2c94c]">Request fresh quote →</Link>}
                  </div>
                  <p className="text-[10px] leading-4 text-slate-600">Informational only. WOLV does not place trades from this analysis. Your wallet remains in control of every approval and transaction.</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
