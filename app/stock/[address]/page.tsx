import { getRWATokenList, getRWAMarketData, getRWAProfile, getCandles } from "@/lib/binance";
import { quoteUsd } from "@/lib/quotes";
import Link from "next/link";
import Image from "next/image";
import { buildProtectionRows } from "@/lib/rwaData";
import { isSpotEligibleAsset } from "@/lib/compliance";
import { isRwaToken } from "@/lib/rwaTypes";
import GlobalNav from "@/components/GlobalNav";
import MarketChart from "@/components/MarketChart";

export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const money = (value: unknown) => { const n = num(value); return n == null ? "—" : "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const big = (value: unknown) => {
  const n = num(value);
  if (n == null) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  return "$" + n.toLocaleString();
};
const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const tone = (g: number | null) =>
  g == null ? "text-[#64748b]" : Math.abs(g) < 0.25 ? "text-green-400" : Math.abs(g) < 1 ? "text-yellow-400" : "text-red-400";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCandlePoints(value: unknown): { time: string; value: number }[] {
  const root = isRecord(value) && Array.isArray(value.data) ? value.data : value;
  const records = Array.isArray(root) ? root : isRecord(root) && Array.isArray(root.data) ? root.data : [];
  return records.flatMap((record): { time: string; value: number }[] => {
    let timestamp: unknown;
    let close: unknown;
    if (Array.isArray(record)) {
      timestamp = record[0];
      close = record[4] ?? record[1];
    } else if (isRecord(record)) {
      timestamp = record.timestamp ?? record.time ?? record.openTime ?? record[0];
      close = record.close ?? record.closePrice ?? record.c ?? record.price;
    }
    const numericClose = num(close);
    if (numericClose == null || numericClose <= 0) return [];
    const date = typeof timestamp === "number" || typeof timestamp === "string" ? new Date(Number(timestamp)) : null;
    return [{ time: date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—", value: numericClose }];
  });
}

export default async function StockPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const tokens = await getRWATokenList();
  const rawTokens: unknown[] = Array.isArray(tokens?.data) ? tokens.data as unknown[] : [];
  const token = rawTokens.filter(isRwaToken).find((t) =>
    t.tokenContractAddress.toLowerCase() === address.toLowerCase() && isSpotEligibleAsset(t)
  );

  if (!token) return (
    <div className="min-h-screen bg-[#07070f] text-white flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl mb-4">⚠️</div>
        <p className="text-[#64748b]">Token not found</p>
        <Link href="/" className="text-[#f0b90b] text-sm mt-4 block">← Back</Link>
      </div>
    </div>
  );

  const errs: string[] = [];
  await sleep(300);
  const market: unknown = await getRWAMarketData(address).catch((error: unknown) => { errs.push("market data: " + (error instanceof Error ? error.message : String(error))); return null; });
  await sleep(300);
  const profile: unknown = await getRWAProfile(address).catch((error: unknown) => { errs.push("company profile: " + (error instanceof Error ? error.message : String(error))); return null; });
  await sleep(300);
  const candles: unknown = await getCandles(address, "56", "1h", "48").catch((error: unknown) => { errs.push("chart data: " + (error instanceof Error ? error.message : String(error))); return null; });
  const q = await quoteUsd(address);

  console.log("[profile-dump]", token.underlyingTicker, JSON.stringify(profile)?.slice(0, 1500));

  const marketData = isRecord(market) && isRecord(market.data) && isRecord(market.data.marketData)
    ? market.data.marketData
    : {};
  const md = marketData;
  const prof = isRecord(profile) && isRecord(profile.data) ? profile.data : null;
  const protectionRows = buildProtectionRows(prof);
  const mult = num(token.tokenToShareRatio) || 1;
  const listed = num(token.tokenPrice) ?? 0;
  const ref = num(token.referencePrice) ?? 0;
  const refShare = ref / mult; // referencePrice is per TOKEN
  const perShare = q.ok ? q.usd / mult : null;
  const gap = perShare != null && refShare > 0 ? (perShare / refShare - 1) * 100 : null;
  const isOpen = token.statusInfo?.openState;
  const status = token.statusInfo?.marketStatus ?? (isOpen ? "trading" : "closed");
  const chartPoints = parseCandlePoints(candles);

  const profRows: [string, string | number][] = prof
    ? Object.entries(prof).flatMap(([key, value]) =>
        (typeof value === "string" || typeof value === "number") && String(value).trim() !== "" && !/logo|chain|address|url|id$|^assetType$|^underlyingTicker$|ratio/i.test(key)
          ? [[key, value]]
          : [])
    : [];
  const shortRows = profRows.filter(([, v]) => String(v).length <= 120);
  const longRows = profRows.filter(([, v]) => String(v).length > 120);

  const stats: [string, string][] = [
    ["P/E Ratio (TTM)", num(md.peRatioTTM ?? token.peRatioTTM) != null ? num(md.peRatioTTM ?? token.peRatioTTM)!.toFixed(2) : "—"],
    ["Market Cap", big(md.marketCap ?? token.marketCap)],
    ["24H Volume", big(token.volume24H)],
    ["52W High", money(md.high52W)],
    ["52W Low", money(md.low52W)],
    ["Dividend Yield", num(md.dividendYield) != null ? num(md.dividendYield)!.toFixed(2) + "%" : "—"],
    ["Latest Dividend", money(md.latestDividend)],
  ];

  return (
    <main className="min-h-screen bg-[#07070f] pb-24 text-white md:pb-10">
      <nav className="border-b border-[#1b1b35] bg-[#0e0e1c] px-4 sm:px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
        <Link href="/" className="text-[#64748b] text-xl">←</Link>
  {token.tokenLogoUrl && <Image src={token.tokenLogoUrl} width={32} height={32} className="rounded-full" alt={token.underlyingTicker ?? "Asset"} />}
        <div className="min-w-0">
          <div className="font-black text-base sm:text-lg">{token.underlyingTicker}</div>
          <div className="text-xs text-[#64748b] truncate">{token.underlyingName || token.tokenName?.replace(/\s*\(.*?\)\s*/g, "")}</div>
        </div>
        <span className={`ml-auto shrink-0 text-[10px] font-bold px-2 py-1 rounded-full border sm:text-xs ${
          isOpen ? "bg-green-900/30 text-green-400 border-green-800" : "bg-yellow-900/20 text-yellow-400 border-yellow-800"
        }`}>
          {String(status).toUpperCase()}
        </span>
      </nav>

      <div className="mb-6 bg-gradient-to-b from-[#0e0e1c] to-transparent px-4 pb-1 pt-5 sm:px-6">
        <Link
          href={`/trade/${address}`}
          className="w-full rounded-xl bg-[#f0b90b] px-6 py-3 text-lg font-bold text-black shadow-[0_12px_40px_rgba(240,185,11,.18)] transition hover:-translate-y-0.5 hover:bg-[#ffd44d]"
        >
          Trade {token.underlyingTicker}
          <span className="text-xs">→</span>
        </Link>
      </div>

      <div className="space-y-4 px-4 pt-2 sm:px-6">
        <div className="wolv-sheen relative overflow-hidden rounded-2xl border border-white/[0.09] p-5 sm:p-7">
          <div className="wolv-grid pointer-events-none absolute inset-0 opacity-70" />
          <div className="relative flex items-end justify-between gap-4">
            <div>
              <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#f0b90b]">Live asset signal</div>
              <div className="text-4xl font-black tracking-tight sm:text-6xl">{token.underlyingTicker}</div>
              <div className="mt-2 max-w-md text-sm leading-6 text-slate-400">Reference data, executable pricing, and market state in one clear view.</div>
            </div>
            <div className="hidden text-right sm:block"><div className="text-2xl font-black text-emerald-400">24/7</div><div className="text-[10px] uppercase tracking-wider text-slate-500">on-chain venue</div></div>
          </div>
        </div>

        <MarketChart points={chartPoints} ticker={token.underlyingTicker ?? "Asset"} status={String(status)} />

        <div className="wolv-float bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-5">
          <div className="text-xs text-[#64748b] mb-1 uppercase tracking-wider">Listed price (per token)</div>
          <div className="text-4xl font-black text-white mb-1">
            ${listed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 })}
          </div>
          <div className="text-xs text-[#64748b]">
            via {token.platformId} · BSC · 1 token = {mult.toFixed(4)} shares
          </div>
        </div>

        <div className="rounded-xl p-5 border border-[#1b1b35] bg-[#0e0e1c]">
          <div className="text-xs text-[#64748b] mb-3 uppercase tracking-wider">Executable vs reference (per share)</div>
          {q.ok ? (
            <>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div>
                  <div className="text-xs text-[#64748b] mb-1">Executable</div>
                  <div className="font-bold text-sm">${perShare!.toFixed(3)}</div>
                </div>
                <div>
                  <div className="text-xs text-[#64748b] mb-1">Reference</div>
                  <div className="font-bold text-sm">${refShare.toFixed(3)}</div>
                </div>
                <div>
                  <div className="text-xs text-[#64748b] mb-1">Gap</div>
                  <div className={`font-black text-lg ${tone(gap)}`}>
                    {gap == null ? "—" : (gap > 0 ? "+" : "") + gap.toFixed(3) + "%"}
                  </div>
                </div>
              </div>
              <div className="text-xs text-[#64748b] leading-relaxed">
                What 100 USDT buys through the router ({q.vendor} {q.mode}), divided by the {mult.toFixed(4)} shares per token.
                Reference price is a per-share value derived from the on-chain token price according to Binance&apos;s RWA data;
                it is not an independent stock-market quote. Executable price reflects what the aggregator currently quotes for the token.
              </div>
            </>
          ) : (
            <div className="text-xs text-yellow-500">Quote unavailable: {q.err}</div>
          )}
        </div>

        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-5">
          <div className="text-xs text-[#64748b] mb-3 uppercase tracking-wider">Market Data</div>
          <div className="space-y-3">
            {stats.map(([l, v]) => (
              <div key={l} className="flex justify-between text-sm border-b border-[#1b1b35] pb-2 last:border-none last:pb-0">
                <span className="text-[#64748b]">{l}</span>
                <span className="font-bold">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-5">
          <div className="text-xs text-[#64748b] mb-3 uppercase tracking-wider">Company</div>
          {profRows.length === 0 ? (
            <div className="text-xs text-[#64748b]">No company details returned for this token.</div>
          ) : (
            <div className="space-y-2 text-sm">
              {shortRows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-[#1b1b35] pb-2 last:border-none">
                  <span className="text-[#64748b]">{label(k)}</span>
                  <span className="font-bold text-right max-w-[60%]">{String(v)}</span>
                </div>
              ))}
              {longRows.map(([k, v]) => (
                <p key={k} className="text-xs text-[#94a3b8] leading-relaxed pt-2">{String(v)}</p>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-5">
          <div className="text-xs text-[#64748b] mb-1 uppercase tracking-wider">Protections &amp; Reports</div>
          <p className="text-xs text-[#94a3b8] leading-relaxed mb-3">
            Investor protection and reporting information supplied through the RWA profile.
          </p>
          {protectionRows.length === 0 ? (
            <div className="text-xs text-[#64748b]">No protection reports currently available.</div>
          ) : (
            <>
              <div className="space-y-2 text-sm">
                {protectionRows.map((r) => (
                  <div key={r.key} className="flex items-center justify-between gap-4 border-b border-[#1b1b35] pb-2 last:border-none last:pb-0">
                    <span className="text-[#64748b]">{r.label}</span>
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-bold text-[#f0b90b] text-right">
                        View report ↗
                      </a>
                    ) : (
                      <span className="text-xs text-[#64748b] text-right">Listed · no report link provided</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#64748b] mt-3 leading-relaxed">
                Reports are published by the issuing platform. WOLV does not verify their contents.
              </p>
            </>
          )}
        </div>

        {errs.length > 0 && (
          <div className="text-xs text-yellow-500 bg-yellow-900/10 border border-yellow-800/40 rounded-xl p-3">
            {errs.map((e) => <div key={e}>{e}</div>)}
          </div>
        )}

        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-4 flex items-center justify-between">
          <div className="text-xs text-[#64748b]">Issued by</div>
          <span className="text-sm font-bold capitalize text-[#f0b90b]">{token.platformId}</span>
        </div>

        <GlobalNav />
      </div>
    </main>
  );
}
