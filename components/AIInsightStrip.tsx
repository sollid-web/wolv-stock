"use client";

import { useEffect, useState } from "react";
import type { OpportunityRow } from "@/lib/opportunityMath";
import { marketLabel } from "@/lib/opportunityMath";
import { quoteAgeSeconds } from "@/lib/quotes";

type Analysis = {
  source: string;
  headline: string;
  summary: string;
  reasons: string[];
  nextStep: string;
  tone: "positive" | "caution" | "neutral";
};

function requestFor(row: OpportunityRow) {
  return {
    ticker: row.ticker,
    company: row.venues[0]?.token.underlyingName ?? row.venues[0]?.token.tokenName ?? row.ticker,
    spread: row.crossVenueSpread,
    statusMismatch: row.statusMismatch,
    statuses: row.statuses,
    venues: row.venues.map((venue) => ({
      platform: venue.token.platformId,
      status: marketLabel(venue.token),
      referencePerShare: venue.referencePerShare,
      executablePerShare: venue.executablePerShare,
      referenceGap: venue.referenceGap,
      quoteAgeSeconds: venue.quote.ok ? quoteAgeSeconds(venue.quote) : null,
      stale: venue.stale,
      unreliable: venue.unreliable,
      quoteAvailable: venue.quote.ok,
    })),
  };
}

export default function AIInsightStrip({ row }: { row?: OpportunityRow }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState(false);
  const loading = Boolean(row && !analysis && !error);

  useEffect(() => {
    if (!row) return;
    let active = true;
    fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestFor(row)),
    })
      .then(async (response) => {
        const payload = await response.json() as Analysis;
        if (!response.ok) throw new Error("analysis unavailable");
        if (active) setAnalysis(payload);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => { active = false; };
  }, [row]);

  const tone = analysis?.tone === "positive"
    ? "border-emerald-400/20 bg-emerald-400/[0.05]"
    : analysis?.tone === "caution"
      ? "border-amber-400/20 bg-amber-400/[0.05]"
      : "border-sky-300/20 bg-sky-300/[0.05]";

  return (
    <section aria-label="WOLV AI live market pulse" className={`relative overflow-hidden rounded-2xl border ${analysis ? tone : "border-sky-300/15 bg-[#0b1017]"} p-4 shadow-[0_18px_55px_rgba(0,0,0,.2)] transition-colors duration-500 sm:p-5`}>
      <div className="pointer-events-none absolute -right-10 -top-16 size-44 rounded-full bg-sky-400/[0.08] blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="relative mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl border border-sky-300/30 bg-sky-300/[0.08] text-lg text-sky-200 shadow-[0_0_24px_rgba(125,211,252,.15)]">
            <span className={loading ? "animate-pulse" : ""}>✦</span>
            <span className="absolute -right-1 -top-1 size-2 rounded-full bg-sky-300 shadow-[0_0_12px_rgba(125,211,252,.9)]" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[9px] font-black uppercase tracking-[0.18em] text-sky-200">
              <span>WOLV AI</span>
              <span className="rounded-full border border-sky-300/20 bg-sky-300/[0.06] px-2 py-1 tracking-[0.12em]">{loading ? "Reading live feed" : analysis?.source === "WOLV AI" ? "Live analyzer" : "Safety read"}</span>
            </div>
            {loading ? (
              <div className="mt-2 flex items-center gap-2 text-sm font-bold text-white"><span className="wolv-pulse size-1.5 rounded-full bg-sky-300" />Watching price, freshness, and venue status…</div>
            ) : analysis ? (
              <>
                <h2 className="mt-2 truncate text-base font-black text-white sm:text-lg">{analysis.headline}</h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-300">{analysis.summary}</p>
              </>
            ) : (
              <div className="mt-2 text-sm font-bold text-slate-300">AI is waiting for a validated live comparison.</div>
            )}
          </div>
        </div>
        {analysis && (
          <div className="flex shrink-0 items-center gap-2 text-[10px] font-bold text-slate-300 sm:max-w-[190px] sm:text-right">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,.8)]" />
            {analysis.nextStep}
          </div>
        )}
      </div>
      <div className="relative mt-4 flex flex-wrap gap-2 border-t border-white/[0.07] pt-3 text-[9px] font-semibold text-slate-500">
        <span className="text-sky-200/80">AI watches:</span>
        <span>freshness</span><span>•</span><span>session alignment</span><span>•</span><span>outlier safety</span><span>•</span><span>execution context</span>
      </div>
    </section>
  );
}
