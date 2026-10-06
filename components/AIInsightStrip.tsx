"use client";

import { useState } from "react";
import type { OpportunityRow } from "@/lib/opportunityMath";

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

export default function AIInsightStrip({ row }: { row?: OpportunityRow }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function analyze() {
    if (!row || loading) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker: row.ticker }),
      });
      const payload = await response.json() as Analysis & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Market analysis is temporarily unavailable");
      setAnalysis(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Market analysis is temporarily unavailable");
    } finally {
      setLoading(false);
    }
  }

  const tone = analysis?.tone === "positive"
    ? "border-emerald-400/20 bg-emerald-400/[0.05]"
    : analysis?.tone === "caution"
      ? "border-amber-400/20 bg-amber-400/[0.05]"
      : "border-sky-300/20 bg-sky-300/[0.05]";

  return (
    <section aria-label="On-demand WOLV market analysis" className={`relative overflow-hidden rounded-2xl border ${analysis ? tone : "border-sky-300/15 bg-[#0b1017]"} p-4 shadow-[0_18px_55px_rgba(0,0,0,.2)] transition-colors duration-500 sm:p-5`}>
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
              <span className="rounded-full border border-sky-300/20 bg-sky-300/[0.06] px-2 py-1 tracking-[0.12em]">{loading ? "Validating live data" : analysis?.source ?? "On-demand analysis"}</span>
            </div>
            {loading ? (
              <div className="mt-2 flex items-center gap-2 text-sm font-bold text-white"><span className="wolv-pulse size-1.5 rounded-full bg-sky-300" />Fetching server-side market data and preparing the explanation…</div>
            ) : analysis ? (
              <>
                <h2 className="mt-2 truncate text-base font-black text-white sm:text-lg">{analysis.headline}</h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-300">{analysis.summary}</p>
                <ul className="mt-2 space-y-1 text-[10px] leading-4 text-slate-400">
                  {analysis.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
                </ul>
                <div className="mt-2 flex flex-wrap gap-2">
                  {analysis.observations.map((observation) => (
                    <span key={observation.platform} className={`rounded-md border px-2 py-1 text-[9px] ${observation.stale ? "border-amber-400/20 text-amber-200" : "border-white/[0.08] text-slate-400"}`}>
                      {observation.platform} · {observation.status} · {observation.quoteAvailable ? `${observation.quoteAgeSeconds}s${observation.stale ? " stale" : ""}` : "quote unavailable"}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[9px] text-slate-500">
                  {analysis.dataSources.join(" · ")} · checked {new Date(analysis.checkedAt).toLocaleTimeString()}
                </p>
              </>
            ) : (
              <div className="mt-2 text-sm font-bold text-slate-300">
                {row ? `Ask WOLV to explain the current ${row.ticker} comparison.` : "No validated comparison is available to analyze."}
              </div>
            )}
            {error && <p role="alert" className="mt-2 text-xs text-amber-200">{error}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <button
            type="button"
            disabled={!row || loading}
            onClick={analyze}
            className="rounded-lg border border-sky-300/25 bg-sky-300/[0.06] px-3 py-2 text-[10px] font-bold text-sky-200 transition hover:bg-sky-300/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Analyzing…" : analysis || error ? "Refresh market read" : "Analyze live market"}
          </button>
          {analysis && <span className="text-[10px] font-bold text-slate-300 sm:max-w-[190px] sm:text-right">{analysis.nextStep}</span>}
        </div>
      </div>
      <div className="relative mt-4 flex flex-wrap gap-2 border-t border-white/[0.07] pt-3 text-[9px] font-semibold text-slate-500">
        <span className="text-sky-200/80">WOLV checks:</span>
        <span>freshness</span><span>•</span><span>session alignment</span><span>•</span><span>outlier safety</span><span>•</span><span>execution context</span>
      </div>
    </section>
  );
}
