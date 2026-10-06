import Image from "next/image";
import Link from "next/link";
import type { OpportunityRow, VenueResult } from "@/lib/opportunityMath";
import { marketLabel, MAX_RELIABLE_GAP_PERCENT, signedPercent } from "@/lib/opportunityMath";
import { quoteAgeSeconds } from "@/lib/quotes";
import { QUOTE_AMOUNT_USDT } from "@/lib/opportunityMonitor";
import MarketAnalysis from "@/components/MarketAnalysis";
import AIInsightStrip from "@/components/AIInsightStrip";

import ParticleCanvas from "@/components/ParticleCanvas";
type HomepageProps = {
  rows: OpportunityRow[];
  assetCount: number;
  feedUnavailable: boolean;
};

function price(value: number | null): string {
  return value == null ? "Unavailable" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
}

function isComparable(venue: VenueResult): boolean {
  return venue.quote.ok &&
    !venue.stale &&
    !venue.unreliable &&
    venue.referencePerShare != null &&
    venue.executablePerShare != null;
}

function tickerVenues(rows: OpportunityRow[]): VenueResult[] {
  return rows.flatMap((row) => row.venues)
    .filter((venue) => isComparable(venue) && venue.referenceGap != null)
    .slice(0, 10);
}

function signalFor(row: OpportunityRow): { label: string; tone: string; explanation: string } {
  const comparableCount = row.venues.filter(isComparable).length;
  if (row.statusMismatch) {
    return {
      label: "Session mismatch",
      tone: "text-amber-300",
      explanation: `Venue market status differs (${row.statuses.join(" vs ")}); compare only after checking whether the venues are in the same trading session.`,
    };
  }
  if (row.crossVenueSpread == null || comparableCount < 2) {
    return {
      label: "Insufficient comparison",
      tone: "text-slate-300",
      explanation: "There are not enough fresh, reference-backed venue quotes to calculate a reliable cross-venue spread.",
    };
  }
  return {
    label: "Quotes comparable",
    tone: "text-emerald-300",
    explanation: `${comparableCount} fresh venue quotes include reference prices. The ${signedPercent(row.crossVenueSpread)} spread is quote-size specific and excludes fees, gas, slippage, and execution changes.`,
  };
}

function Logo({ venue, ticker, size = 32 }: { venue: VenueResult; ticker: string; size?: number }) {
  if (venue.token.tokenLogoUrl) {
    return (
      <Image
        src={venue.token.tokenLogoUrl}
        width={size}
        height={size}
        className="shrink-0 rounded-full bg-white/5 ring-1 ring-white/10"
        alt={`${ticker} token logo`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full border border-[#f0b90b]/20 bg-[#f0b90b]/[0.08] font-bold text-[#f0b90b]"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.34) }}
    >
      {ticker.slice(0, 2)}
    </span>
  );
}

function Navigation() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#070a0e]/90 backdrop-blur-xl">
      <nav aria-label="Main navigation" className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="WOLV home">
          <span className="grid size-9 place-items-center rounded-xl bg-[#f0b90b] text-sm font-black text-black shadow-[0_0_22px_rgba(240,185,11,.18)]">W</span>
          <span className="text-sm font-black tracking-[0.2em] text-white">WOLV</span>
        </Link>
        <div className="hidden items-center gap-7 md:flex">
          <Link href="/markets" className="text-xs font-semibold text-slate-400 transition hover:text-white">Markets</Link>
          <a href="#opportunities" className="text-xs font-semibold text-slate-400 transition hover:text-white">Opportunities</a>
          <Link href="/trade" className="text-xs font-semibold text-slate-400 transition hover:text-white">Trade</Link>
          <Link href="/wallet" className="text-xs font-semibold text-slate-400 transition hover:text-white">Portfolio</Link>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-sky-300/20 bg-sky-300/[0.05] px-2.5 py-2 text-[9px] font-bold text-sky-200 sm:flex">
            <span className="size-1.5 rounded-full bg-sky-300" /> AI market read
          </span>
          <span className="hidden items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-[10px] font-semibold text-slate-300 sm:flex">
            <span className="size-1.5 rounded-full bg-[#f0b90b]" />
            BNB Chain · Mainnet
          </span>
          <Link href="/wallet" className="rounded-lg bg-[#f0b90b] px-3 py-2 text-[11px] font-black text-[#111] transition hover:bg-[#ffd44d] sm:px-4">
            Connect wallet
          </Link>
        </div>
      </nav>
    </header>
  );
}

function Terminal({ row, feedUnavailable }: { row?: OpportunityRow; feedUnavailable: boolean }) {
  const featuredVenue = row?.venues.find((venue) => venue.quote.ok) ?? row?.venues[0];
  const signal = row ? signalFor(row) : null;
  const comparableCount = row?.venues.filter(isComparable).length ?? 0;
  const age = featuredVenue?.quote.ok ? quoteAgeSeconds(featuredVenue.quote) : null;
  const marketStatus = featuredVenue ? marketLabel(featuredVenue.token) : "unavailable";

  return (
    <section aria-label="Live opportunity preview" className="wolv-glass wolv-glass-hover relative overflow-hidden rounded-2xl p-4 shadow-[0_22px_70px_rgba(0,0,0,.45)] sm:p-5">
      <div className="pointer-events-none absolute inset-0 opacity-30">
        <div className="wolv-grid absolute inset-0" />
        <div className="absolute -right-24 -top-24 size-64 rounded-full bg-[#f0b90b]/10 blur-3xl" />
      </div>
      <div className="relative flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.08] pb-4">
        <div className="flex min-w-0 items-center gap-3">
          {featuredVenue && <Logo venue={featuredVenue} ticker={row?.ticker ?? "W"} size={38} />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black tracking-tight text-white">{row?.ticker ?? "Live feed"}</h2>
              {featuredVenue && <span className="text-[10px] capitalize text-slate-400">{featuredVenue.token.platformId}</span>}
            </div>
            <p className="truncate text-[11px] text-slate-500">{featuredVenue?.token.underlyingName ?? "Cross-venue spot comparison"}</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider ${
          feedUnavailable ? "border-amber-400/20 bg-amber-400/[0.06] text-amber-200" : "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200"
        }`}>
          <span className={`size-1.5 rounded-full ${feedUnavailable ? "bg-amber-300" : "wolv-pulse bg-emerald-400"}`} />
          {feedUnavailable ? "Feed unavailable" : "Live BSC data"}
        </span>
      </div>

      {feedUnavailable || !row || !featuredVenue ? (
        <div role="status" className="relative mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-sm text-amber-100">
          <div className="font-bold">No live opportunity preview</div>
          <p className="mt-1 text-xs leading-5 text-amber-100/70">
            {feedUnavailable ? "WOLV could not validate the current asset feed. No prices or signals are inferred." : "No cross-listed executable quote is available in this snapshot."}
          </p>
        </div>
      ) : (
        <>
          <div className="relative mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Reference / share" value={price(featuredVenue.referencePerShare)} />
            <Metric label="Executable / share" value={price(featuredVenue.executablePerShare)} accent />
            <Metric label="Normalized price" value={price(featuredVenue.executablePerShare)} />
            <Metric label="Reference gap" value={featuredVenue.referenceGap == null ? "Unavailable" : signedPercent(featuredVenue.referenceGap)} accent />
          </div>
          <div className="relative mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Quote freshness</div>
              <div className={`mt-1 text-xs font-bold ${featuredVenue.stale ? "text-amber-300" : "text-emerald-300"}`}>
                {age == null ? "Unavailable" : `${age}s${featuredVenue.stale ? " · stale" : " · fresh"}`}
              </div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Market status</div>
              <div className="mt-1 truncate text-xs font-bold capitalize text-slate-200">{marketStatus}</div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Quote impact</div>
              <div className="mt-1 text-xs font-bold text-slate-200">
                {featuredVenue.quote.ok && featuredVenue.quote.impact != null ? `${featuredVenue.quote.impact}%` : "Unavailable"}
              </div>
            </div>
          </div>
          <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-3">
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">WOLV data read · rule-based</div>
              <div className={`mt-1 text-xs font-bold ${signal?.tone}`}>{signal?.label} <span className="font-normal text-slate-500">· {comparableCount} comparable venue{comparableCount === 1 ? "" : "s"}</span></div>
            </div>
            {isComparable(featuredVenue) ? (
              <Link href={`/trade/${featuredVenue.token.tokenContractAddress}`} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-[#f0b90b] px-4 text-xs font-black text-[#111] transition hover:bg-[#ffd44d]">
                Trade {row.ticker} <span aria-hidden="true" className="ml-2">→</span>
              </Link>
            ) : (
              <span className="rounded-lg border border-white/[0.08] px-3 py-2 text-[10px] font-semibold text-slate-500">Refresh data before trading</span>
            )}
          </div>
          <p className="relative mt-3 text-[9px] leading-relaxed text-slate-600">
            Indicative {QUOTE_AMOUNT_USDT} USDT quote from {featuredVenue.quote.ok ? `${featuredVenue.quote.vendor} · ${featuredVenue.quote.mode}` : "unavailable source"}. Trade route requests a fresh quote and runs its existing preflight before wallet approval.
          </p>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-black/20 p-3">
      <div className="truncate text-[9px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 break-words text-sm font-black tracking-tight sm:text-base ${accent ? "text-[#f0b90b]" : "text-white"}`}>{value}</div>
    </div>
  );
}

function Ticker({ rows }: { rows: OpportunityRow[] }) {
  const venues = tickerVenues(rows);
  if (venues.length === 0) {
    return (
      <div className="border-y border-white/[0.07] bg-[#090d13] px-4 py-3 text-center text-[10px] text-slate-500">
        Live comparison ticker will appear when fresh reference-backed quotes are available.
      </div>
    );
  }
  const items = venues.map((venue) => {
    const ticker = venue.token.underlyingTicker;
    const gap = venue.referenceGap ?? 0;
    return (
      <span key={`${venue.token.tokenContractAddress}-ticker`} className="inline-flex shrink-0 items-center gap-2 px-5 text-[10px] font-semibold">
        <span className="text-slate-200">{ticker}</span>
        <span className="text-slate-500 capitalize">{venue.token.platformId}</span>
        <span className={gap >= 0 ? "text-emerald-300" : "text-rose-300"}>{signedPercent(gap)} vs ref</span>
        <span className="text-slate-700" aria-hidden="true">◆</span>
      </span>
    );
  });
  return (
    <div role="region" aria-label="Fresh executable quotes compared with reference prices" className="overflow-hidden border-y border-white/[0.07] bg-[#090d13] py-3">
      <div className="market-ticker-track flex w-max items-center">
        <div className="flex items-center">{items}</div>
        <div className="flex items-center" aria-hidden="true">{items}</div>
      </div>
    </div>
  );
}

function OpportunityTile({ row }: { row: OpportunityRow }) {
  const representative = row.venues.find(isComparable) ?? row.venues.find((venue) => venue.quote.ok) ?? row.venues[0];
  const bestTrade = row.venues.find(isComparable);
  const company = representative.token.underlyingName ?? representative.token.tokenName ?? row.ticker;
  const signal = signalFor(row);

  return (
    <article className="wolv-glass wolv-glass-hover group min-w-0 rounded-xl p-4 transition duration-200 hover:-translate-y-0.5">
      <div className="flex min-w-0 items-center gap-3">
        <Logo venue={representative} ticker={row.ticker} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="font-black text-white">{row.ticker}</h3>
            <span className="truncate text-[10px] text-slate-500">{company}</span>
          </div>
          <p className="truncate text-[10px] capitalize text-slate-500">{row.venues.map((venue) => venue.token.platformId).join(" · ")}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-bold ${signal.tone} border-white/[0.08] bg-white/[0.03]`}>{signal.label}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Metric label="Reference / share" value={price(representative.referencePerShare)} />
        <Metric label="Executable / share" value={price(representative.executablePerShare)} accent />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-3 text-[10px]">
        <span className="text-slate-500">Cross-venue spread</span>
        <span className={`font-bold ${row.crossVenueSpread == null ? "text-slate-500" : "text-[#f0b90b]"}`}>
          {row.crossVenueSpread == null ? "Not comparable" : signedPercent(row.crossVenueSpread)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
        <span className="text-slate-500">Quote age · {marketLabel(representative.token)}</span>
        <span className={representative.stale ? "font-bold text-amber-300" : "text-slate-400"}>
          {representative.quote.ok ? `${quoteAgeSeconds(representative.quote)}s` : "Unavailable"}
        </span>
      </div>
      {row.statusMismatch && <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.04] p-2 text-[10px] leading-4 text-amber-200">Market sessions differ; spread may not represent a tradable opportunity.</p>}
      <div className="mt-4 flex gap-2">
        <MarketAnalysis row={row} />
        {bestTrade ? (
          <Link href={`/trade/${bestTrade.token.tokenContractAddress}`} className="flex-1 rounded-lg bg-[#f0b90b] px-3 py-2.5 text-center text-[10px] font-black text-[#111] transition hover:bg-[#ffd44d]">
            Trade <span aria-hidden="true">→</span>
          </Link>
        ) : (
          <span className="flex-1 rounded-lg border border-white/[0.06] px-3 py-2.5 text-center text-[10px] font-semibold text-slate-600">Trade unavailable</span>
        )}
      </div>
    </article>
  );
}

function Intelligence({ row, feedUnavailable }: { row?: OpportunityRow; feedUnavailable: boolean }) {
  if (feedUnavailable || !row) {
    return (
      <section id="intelligence" className="scroll-mt-24 rounded-2xl border border-white/[0.08] bg-[#0a0f15] p-5 sm:p-7">
        <SectionHeading eyebrow="WOLV market intelligence" title="Context before execution" />
        <p className="mt-4 text-sm text-slate-400">No live comparison is available, so WOLV does not generate a signal from missing data.</p>
      </section>
    );
  }
  const signal = signalFor(row);
  const venues = row.venues.filter((venue) => venue.quote.ok);
  const staleCount = row.venues.filter((venue) => venue.stale).length;
  const unreliableCount = row.venues.filter((venue) => venue.unreliable).length;

  return (
    <section id="intelligence" className="wolv-glass wolv-glass-hover scroll-mt-24 overflow-hidden rounded-2xl p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading eyebrow="WOLV market intelligence" title="Context before execution" />
        <span className="rounded-full border border-sky-300/15 bg-sky-300/[0.04] px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider text-sky-200">AI-assisted · rules-grounded</span>
      </div>
      <p className="mt-3 max-w-3xl text-xs leading-5 text-slate-400">
        Click <span className="font-bold text-sky-200">Analyse</span> on any opportunity to open a lively plain-English read. WOLV grounds the explanation in the displayed quote, reference gap, freshness, and market status; it never trades autonomously.
      </p>
      <div className="mt-5 grid gap-3 md:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
          <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Current read · {row.ticker}</p>
          <p className={`mt-2 text-xl font-black ${signal.tone}`}>{signal.label}</p>
          <p className="mt-2 text-xs leading-5 text-slate-400">{signal.explanation}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Reference / share" value={price(venues[0]?.referencePerShare ?? null)} />
          <Metric label="Executable / share" value={price(venues[0]?.executablePerShare ?? null)} accent />
          <Metric label="Cross-venue spread" value={row.crossVenueSpread == null ? "Unavailable" : signedPercent(row.crossVenueSpread)} />
          <Metric label="Fresh quotes" value={`${venues.filter((venue) => !venue.stale).length} / ${row.venues.length}`} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
        <span className={`rounded-full border px-2.5 py-1.5 ${row.statusMismatch ? "border-amber-400/20 text-amber-200" : "border-white/[0.08] text-slate-400"}`}>
          {row.statusMismatch ? `Session mismatch · ${row.statuses.join(" / ")}` : "No session mismatch reported"}
        </span>
        {staleCount > 0 && <span className="rounded-full border border-amber-400/20 px-2.5 py-1.5 text-amber-200">{staleCount} stale quote{staleCount === 1 ? "" : "s"}</span>}
        {unreliableCount > 0 && <span className="rounded-full border border-rose-400/20 px-2.5 py-1.5 text-rose-200">{unreliableCount} reference outlier{unreliableCount === 1 ? "" : "s"} excluded</span>}
        {row.crossVenueSpread != null && <span className="rounded-full border border-white/[0.08] px-2.5 py-1.5 text-slate-400">Outlier threshold ±{MAX_RELIABLE_GAP_PERCENT}%</span>}
      </div>
      <p className="mt-4 border-t border-white/[0.07] pt-3 text-[10px] leading-relaxed text-slate-500">
        Informational only. Confirm the latest quote, simulation, fees, liquidity, slippage, market session, and wallet transaction details yourself before signing.
      </p>
    </section>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#f0b90b]">{eyebrow}</p>
      <h2 className="mt-1 text-lg font-black tracking-tight text-white sm:text-xl">{title}</h2>
    </div>
  );
}

export default function Homepage({ rows, assetCount, feedUnavailable }: HomepageProps) {
  const featured = rows[0];
  const spreadCount = rows.filter((row) => row.crossVenueSpread != null).length;

  return (
    <main className="min-h-screen overflow-hidden bg-[#070a0e] pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <Navigation />

      <section className="relative mx-auto grid max-w-7xl gap-8 px-4 pb-9 pt-9 sm:px-6 sm:pb-12 sm:pt-14 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
        <div className="wolv-grid pointer-events-none absolute inset-0 opacity-40" />
        <ParticleCanvas />
        <div className="wolv-hero-glow wolv-orb-a" style={{width:"520px",height:"520px",top:"-160px",left:"-80px",background:"radial-gradient(circle,rgba(240,185,11,0.13),transparent 70%)"}} />
        <div className="wolv-hero-glow wolv-orb-b" style={{width:"400px",height:"400px",top:"60px",right:"-100px",background:"radial-gradient(circle,rgba(51,65,120,0.18),transparent 70%)"}} />
        <div className="relative home-reveal">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#f0b90b]/20 bg-[#f0b90b]/[0.05] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.17em] text-[#f4c834]">
            <span className="wolv-pulse size-1.5 rounded-full bg-[#f0b90b]" />
            BNB Chain · Tokenized stocks · Spot only
          </div>
          <h1 className="max-w-2xl text-4xl font-black leading-[1.03] tracking-[-0.055em] text-white sm:text-5xl xl:text-6xl">
            TOKENIZED STOCKS.<br />
            <span className="text-[#f0b90b]">ON-CHAIN EXECUTION.</span>
          </h1>
          <p className="mt-5 text-base font-semibold text-slate-200 sm:text-lg">Find the price. See the execution.</p>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
            WOLV compares issuer reference data with executable BSC spot quotes, normalizes prices per share, and surfaces quote freshness and market status before you decide whether to trade.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a href="#opportunities" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#f0b90b] px-5 text-xs font-black text-[#101010] shadow-[0_8px_24px_rgba(240,185,11,.16)] transition hover:-translate-y-0.5 hover:bg-[#ffd44d]">
              Explore opportunities <span aria-hidden="true" className="ml-2">→</span>
            </a>
            <a href="#how-it-works" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.025] px-4 text-xs font-bold text-slate-200 transition hover:border-white/25 hover:bg-white/[0.05]">
              How WOLV works
            </a>
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[10px] font-semibold text-slate-500">
            <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-emerald-400" /> Reference-backed data</span>
            <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-[#f0b90b]" /> Preflight before signing</span>
            <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-sky-300" /> User-controlled execution</span>
          </div>
        </div>
        <div className="relative home-reveal home-reveal-delay">
          <Terminal row={featured} feedUnavailable={feedUnavailable} />
        </div>
      </section>

      {feedUnavailable && (
        <div role="alert" className="mx-auto mb-5 max-w-7xl px-4 sm:px-6">
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs leading-5 text-amber-100">
            Live market data is unavailable. WOLV is not substituting sample prices or inferred opportunities.
            Retry when the upstream market feed is available.
          </div>
        </div>
      )}

      <Ticker rows={rows} />

      <div className="mx-auto max-w-7xl space-y-12 px-4 py-10 sm:space-y-16 sm:px-6 sm:py-14">
        <AIInsightStrip row={featured} />
        <section id="opportunities" className="scroll-mt-24">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <SectionHeading eyebrow="Live BSC spot monitor" title="Execution opportunities" />
              <p className="mt-2 text-xs text-slate-500">
                {feedUnavailable
                  ? "Live quote comparison unavailable"
                  : `${assetCount} eligible asset records · ${rows.length} live ticker comparisons · ${spreadCount} with a reliable cross-venue spread`}
              </p>
            </div>
            <Link href="/gap?n=40" className="text-[10px] font-bold text-[#f0b90b] transition hover:text-[#ffe27a]">
              Open full monitor <span aria-hidden="true">→</span>
            </Link>
          </div>
          {rows.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {rows.slice(0, 4).map((row) => <OpportunityTile key={row.ticker} row={row} />)}
            </div>
          ) : (
            <div role="status" className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-6 text-sm text-slate-400">
              {feedUnavailable ? "Opportunity cards will return when the validated live asset feed is available." : "No cross-listed comparisons are available in this snapshot."}
            </div>
          )}
        </section>

        <Intelligence row={featured} feedUnavailable={feedUnavailable} />

        <section id="how-it-works" className="scroll-mt-24">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <SectionHeading eyebrow="A transparent workflow" title="From market data to your decision" />
            <p className="text-[10px] text-slate-500">No autonomous trades. You review and approve every transaction.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { number: "01", title: "Discover", text: "Scan eligible tokenized stocks and supported BSC venues." },
              { number: "02", title: "Compare", text: "Review reference and executable prices normalized per share." },
              { number: "03", title: "Analyze", text: "Read transparent checks for quote freshness, market session, and outliers." },
              { number: "04", title: "Execute", text: "Open a fresh quote, inspect preflight, and approve in your wallet." },
            ].map((step, index) => (
              <article key={step.number} className="home-reveal rounded-xl border border-white/[0.08] bg-[#0b1017]/75 p-4" style={{ animationDelay: `${index * 75}ms` }}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black tracking-[0.16em] text-[#f0b90b]">{step.number}</span>
                  <span className="h-px flex-1 bg-white/[0.08] mx-3" />
                  <span className="size-2 rounded-full border border-sky-300/50 bg-sky-300/10" />
                </div>
                <h3 className="mt-4 text-sm font-black text-white">{step.title}</h3>
                <p className="mt-2 text-xs leading-5 text-slate-500">{step.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="relative overflow-hidden rounded-2xl border border-[#f0b90b]/15 bg-[#0b1017] p-5 sm:p-7">
          <div className="pointer-events-none absolute -right-12 -top-16 size-64 rounded-full bg-sky-400/[0.06] blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#f0b90b]">Built for BNB Chain</p>
              <h2 className="mt-2 text-xl font-black tracking-tight text-white sm:text-2xl">BSC spot markets. Wallet-first execution.</h2>
              <p className="mt-2 text-xs leading-5 text-slate-400">WOLV reads market data server-side and requests user approval for on-chain transactions. The connected wallet remains in control of signing.</p>
            </div>
            <div className="flex shrink-0 items-center gap-3 rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3">
              <span className="grid size-10 place-items-center rounded-xl border border-[#f0b90b]/25 bg-[#f0b90b]/[0.07] text-sm font-black text-[#f0b90b]">B</span>
              <div>
                <p className="text-xs font-bold text-white">BNB Smart Chain</p>
                <p className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">Mainnet · Chain 56</p>
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col items-center rounded-2xl border border-white/[0.08] bg-gradient-to-r from-[#0b1017] via-[#11151a] to-[#0b1017] px-5 py-9 text-center sm:py-12">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#f0b90b]">WOLV · BSC tokenized markets</p>
          <h2 className="mt-3 max-w-xl text-2xl font-black tracking-tight text-white sm:text-3xl">See what the market is actually offering.</h2>
          <p className="mt-3 max-w-lg text-xs leading-5 text-slate-400">Inspect a live comparison, then decide whether to open the asset and request a fresh trade quote.</p>
          <a href="#opportunities" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-[#f0b90b] px-5 text-xs font-black text-[#111] transition hover:bg-[#ffd44d]">
            Explore opportunities <span aria-hidden="true" className="ml-2">→</span>
          </a>
        </section>
      </div>
    </main>
  );
}
