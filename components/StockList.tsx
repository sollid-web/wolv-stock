"use client";
import { useMemo, useState } from "react";
import Link from "next/link";

type T = {
  tokenContractAddress: string;
  tokenLogoUrl?: string;
  underlyingTicker: string;
  underlyingName?: string;
  tokenName?: string;
  platformId: string;
};

export default function StockList({ tokens }: { tokens: T[] }) {
  const [q, setQ] = useState("");
  const [plat, setPlat] = useState("all");
  const [limit, setLimit] = useState(50);

  const platforms = useMemo(
    () => Array.from(new Set(tokens.map((t) => t.platformId))).sort(),
    [tokens]
  );

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const starts = (t: T) => Number(t.underlyingTicker.toLowerCase().startsWith(s));
    return tokens
      .filter(
        (t) =>
          (plat === "all" || t.platformId === plat) &&
          (!s ||
            `${t.underlyingTicker} ${t.underlyingName ?? ""} ${t.tokenName ?? ""}`
              .toLowerCase()
              .includes(s))
      )
      .sort((a, b) => (s ? starts(b) - starts(a) : 0));
  }, [tokens, q, plat]);

  const chip = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs font-bold capitalize border transition-colors ${
      active
        ? "bg-[#f0b90b] text-black border-[#f0b90b]"
        : "bg-[#0e0e1c] text-[#94a3b8] border-[#1b1b35]"
    }`;

  return (
    <div className="px-4 sm:px-6 pb-10">
      <input
        type="search"
        value={q}
        onChange={(e) => { setQ(e.target.value); setLimit(50); }}
        placeholder="Search ticker or company (e.g. NVDA)"
        className="w-full mb-3 bg-[#0e0e1c] border border-[#1b1b35] rounded-xl px-4 py-3 text-sm text-white placeholder-[#64748b] outline-none focus:border-[#f0b90b]/50"
      />
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

      <div className="text-xs text-[#64748b] mb-3 uppercase tracking-wider font-bold">
        {rows.length} tokenized stock{rows.length === 1 ? "" : "s"}
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-[#64748b] py-8 text-center">No matches. Try a ticker like SPY or a company name.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {rows.slice(0, limit).map((t) => (
            <Link
              key={t.tokenContractAddress}
              href={`/stock/${t.tokenContractAddress}`}
              className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-4 flex items-center justify-between hover:border-[#f0b90b]/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                {t.tokenLogoUrl && (
                  <img src={t.tokenLogoUrl} loading="lazy" className="w-9 h-9 rounded-full bg-[#1b1b35] shrink-0" alt={t.underlyingTicker} />
                )}
                <div className="min-w-0">
                  <div className="font-bold text-sm">{t.underlyingTicker}</div>
                  <div className="text-xs text-[#64748b] truncate">
                    {t.underlyingName || t.tokenName?.replace(/\s*\(.*?\)\s*/g, "")}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 ml-3">
                <div className="text-xs text-[#64748b] capitalize">{t.platformId}</div>
                <div className="text-xs text-[#f0b90b] font-bold mt-0.5">BSC →</div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length > limit && (
        <button
          onClick={() => setLimit(limit + 100)}
          className="mt-4 w-full py-3 rounded-xl border border-[#1b1b35] bg-[#0e0e1c] text-sm font-bold text-[#f0b90b]"
        >
          Show more ({rows.length - limit} left)
        </button>
      )}
    </div>
  );
}
