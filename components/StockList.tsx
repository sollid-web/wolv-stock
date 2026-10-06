"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { TAG_LABELS, knownTags } from "@/lib/rwaData";
import { filterSpotEligibleAssets } from "@/lib/compliance";

type T = {
  tokenContractAddress: string;
  tokenLogoUrl?: string;
  underlyingTicker: string;
  underlyingName?: string;
  tokenName?: string;
  platformId: string;
  tags?: string[] | null;
};

const TAG_STYLE: Record<string, string> = {
  alpha: "text-purple-300 border-purple-800/60 bg-purple-900/20",
  communityRecognized: "text-sky-300 border-sky-800/60 bg-sky-900/20",
  volumeSurge: "text-green-400 border-green-800/60 bg-green-900/20",
  volumePlunge: "text-red-400 border-red-800/60 bg-red-900/20",
};

function Logo({ url, tk }: { url?: string; tk: string }) {
  const [bad, setBad] = useState(false);
  if (!url || bad)
    return (
      <div className="w-9 h-9 rounded-full bg-[#1b1b35] shrink-0 flex items-center justify-center text-xs font-black text-[#d9a80a]">
        {tk.slice(0, 4)}
      </div>
    );
  return <Image src={url} width={36} height={36} loading="lazy" onError={() => setBad(true)} className="w-9 h-9 rounded-full bg-[#1b1b35] shrink-0" alt={tk} />;
}

export default function StockList({ tokens, category, feedUnavailable = false }: { tokens: T[]; category?: string; feedUnavailable?: boolean }) {
  const [q, setQ] = useState("");
  const [plat, setPlat] = useState("all");
  const [limit, setLimit] = useState(50);

  // Apply compliance filter to remove leveraged ETFs (SOXL, KORU, MUU)
  const compliantTokens = useMemo(() => filterSpotEligibleAssets(tokens), [tokens]);

  const platforms = useMemo(
    () => Array.from(new Set(compliantTokens.map((t) => t.platformId))).sort(),
    [compliantTokens]
  );

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const starts = (t: T) => Number(t.underlyingTicker.toLowerCase().startsWith(s));
    return compliantTokens
      .filter(
        (t) =>
          (plat === "all" || t.platformId === plat) &&
          (!s ||
            `${t.underlyingTicker} ${t.underlyingName ?? ""} ${t.tokenName ?? ""}`
              .toLowerCase()
              .includes(s))
      )
      .sort((a, b) => (s ? starts(b) - starts(a) : 0));
  }, [compliantTokens, q, plat]);

  const chip = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs font-bold capitalize border transition-colors ${
      active
        ? "bg-[#d9a80a] text-black border-[#d9a80a]"
        : "bg-[#0e0e1c] text-[#94a3b8] border-[#1b1b35]"
    }`;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-10 sm:px-8">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Asset directory</p>
          <p className="mt-1 text-sm text-slate-400">Choose a stock to view its market and trade route.</p>
        </div>
        <label className="relative block w-full sm:max-w-sm">
          <span className="sr-only">Search ticker or company</span>
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-slate-500">⌕</span>
          <input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setLimit(50); }}
            placeholder="Search ticker or company"
            className="w-full rounded-xl border border-white/[0.1] bg-white/[0.04] py-3 pl-10 pr-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-[#d9a80a]/60 focus:bg-white/[0.06]"
          />
        </label>
      </div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <button className={chip(plat === "all")} onClick={() => { setPlat("all"); setLimit(50); }}>
          All
        </button>
        {platforms.map((p) => (
          <button key={p} className={chip(plat === p)} onClick={() => { setPlat(p); setLimit(50); }}>
            {p}
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 text-xs font-bold uppercase tracking-wider text-slate-300">
        <span className="min-w-0 flex-1 break-words">{feedUnavailable ? "Asset count unavailable" : `${rows.length} tokenized stock${rows.length === 1 ? "" : "s"}`}{category ? ` · ${category}` : ""}</span>
        <span className={`flex shrink-0 items-center gap-1.5 text-[10px] ${feedUnavailable ? "text-yellow-300" : "text-emerald-400"}`}>
          <span className={`size-1.5 rounded-full ${feedUnavailable ? "bg-yellow-300" : "wolv-pulse bg-emerald-400"}`} />
          {feedUnavailable ? "Feed unavailable" : "Live data"}
        </span>
      </div>

      {rows.length === 0 ? (
        feedUnavailable ? (
          <div role="status" className="py-8 text-center text-sm text-yellow-200">The live asset list is unavailable. No matching assets are inferred; retry when the upstream RWA feed is available.</div>
        ) : (
          <div className="text-sm text-slate-300 py-8 text-center">No matches. Try a ticker like SPY, a company name, or another category.</div>
        )
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {rows.slice(0, limit).map((t) => (
            <Link
              key={t.tokenContractAddress}
              href={`/stock/${t.tokenContractAddress}`}
              className="group relative flex items-center justify-between overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.035] backdrop-blur-xl px-4 py-4 transition duration-300 hover:-translate-y-1 hover:border-[#d9a80a]/50 hover:bg-white/[0.06] hover:shadow-[0_12px_36px_rgba(217,168,10,.08)] sm:px-5"
            >
              <span className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/4 -skew-x-12 bg-gradient-to-r from-transparent via-white/[0.08] to-transparent opacity-0 transition duration-700 group-hover:left-[120%] group-hover:opacity-100" />
              <div className="flex items-center gap-3 min-w-0">
                <Logo url={t.tokenLogoUrl} tk={t.underlyingTicker} />
                <div className="min-w-0">
                  <div className="font-bold text-sm">{t.underlyingTicker}</div>
                  <div className="text-xs text-slate-300 truncate">
                    {t.underlyingName || t.tokenName?.replace(/\s*\(.*?\)\s*/g, "")}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1 empty:hidden">
                    {knownTags(t.tags).map((tag) => (
                      <span key={tag} className={`text-xs font-bold px-2 py-0.5 rounded-full border ${TAG_STYLE[tag]}`}>
                        {TAG_LABELS[tag]}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 ml-3">
                <div className="text-xs text-slate-300 capitalize">{t.platformId}</div>
                <div className="text-xs text-[#d9a80a] font-bold mt-0.5">BSC →</div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length > limit && (
        <button
          onClick={() => setLimit(limit + 100)}
          className="mt-4 w-full py-3 rounded-xl border border-[#1b1b35] bg-[#0e0e1c] text-sm font-bold text-[#d9a80a]"
        >
          Show more ({rows.length - limit} left)
        </button>
      )}
    </div>
  );
}
