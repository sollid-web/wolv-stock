import Link from "next/link";
import { Suspense } from "react";
import { getRWATokenList } from "@/lib/binance";
import Homepage from "@/components/Homepage";
import GlobalNav from "@/components/GlobalNav";
import BrandMark from "@/components/BrandMark";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { isRwaAssetListResponse } from "@/lib/rwaAssetResponse";
import { getOpportunityRows } from "@/lib/opportunityMonitor";
import { parseRwaAssetRecords } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

function HomepageLoading() {
  return (
    <main className="wolv-app-shell min-h-screen overflow-hidden pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <header className="sticky top-0 z-40 border-b border-white/[0.09] bg-[#070711]/70 px-4 backdrop-blur-2xl sm:px-6">
        <nav aria-label="Main navigation" className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4">
          <BrandMark />
          <div className="hidden items-center gap-7 md:flex">
            <Link href="/markets" className="text-xs font-semibold text-slate-400">Markets</Link>
            <Link href="/trade" className="text-xs font-semibold text-slate-400">Trade</Link>
            <Link href="/wallet" className="text-xs font-semibold text-slate-400">Portfolio</Link>
          </div>
          <Link href="/wallet" className="wolv-connect-button rounded-lg px-3 py-2 text-[11px] font-black sm:px-4">Connect wallet</Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-7xl gap-8 px-4 pb-10 pt-10 sm:px-6 sm:pb-12 sm:pt-14 lg:grid-cols-[0.94fr_1.06fr] lg:items-center">
        <div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#d9a80a]/20 bg-[#d9a80a]/[0.05] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.17em] text-[#f4c834]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#d9a80a]" />
            BNB Chain · Tokenized stocks · Spot only
          </div>
          <h1 className="max-w-2xl text-4xl font-black leading-[1.03] tracking-[-0.055em] text-white sm:text-5xl xl:text-6xl">
            TOKENIZED STOCKS.<br />
            <span className="text-[#d9a80a]">ON-CHAIN EXECUTION.</span>
          </h1>
          <p className="mt-5 text-base font-semibold text-slate-200 sm:text-lg">Find the price. See the execution.</p>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
            WOLV compares issuer reference data with indicative BSC spot estimates and checks freshness and market status before you decide whether to trade.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a href="#opportunities" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#d9a80a] px-5 text-xs font-black text-[#101010]">Explore opportunities <span aria-hidden="true" className="ml-2">→</span></a>
            <a href="#how-it-works" className="wolv-glass-control inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-xs font-bold text-slate-200">How WOLV works</a>
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[10px] font-semibold text-slate-500">
            <span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Reference-backed data</span>
            <span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#d9a80a]" /> Preflight before signing</span>
            <span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-sky-300" /> User-controlled execution</span>
          </div>
        </div>
        <div className="rounded-2xl border border-white/[0.09] bg-[#0e0e1c]/80 p-5 shadow-[0_22px_70px_rgba(0,0,0,.35)]" aria-busy="true" aria-live="polite">
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
            <div>
              <div className="h-6 w-24 animate-pulse rounded bg-white/[0.08]" />
              <div className="mt-2 h-3 w-40 animate-pulse rounded bg-white/[0.06]" />
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#d9a80a]/20 px-2.5 py-1.5 text-[9px] font-bold uppercase text-[#f4c834]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#d9a80a]" /> Checking feed
            </span>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {["Reference / share", "Indicative estimate / share", "Normalized price", "Reference gap"].map((label) => (
              <div key={label} className="rounded-lg border border-white/[0.06] bg-black/20 p-3">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
                <div className="mt-2 h-5 w-20 animate-pulse rounded bg-white/[0.08]" />
              </div>
            ))}
          </div>
          <p className="mt-5 border-t border-white/[0.08] pt-4 text-xs text-slate-400">Loading verified market data… no price or opportunity is inferred while the feed is unavailable.</p>
        </div>
      </section>

      <section id="opportunities" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14" aria-busy="true">
        <div className="mb-5 flex items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#d9a80a]">Live BSC spot monitor</p>
            <h2 className="mt-1 text-lg font-black text-white sm:text-xl">Execution opportunities</h2>
          </div>
          <span className="text-[10px] text-slate-500">Checking current data…</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {["a", "b", "c", "d"].map((key) => (
            <div key={key} className="h-44 animate-pulse rounded-xl border border-white/[0.08] bg-[#0b1017]/75" aria-hidden="true" />
          ))}
        </div>
      </section>
      <GlobalNav />
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<HomepageLoading />}>
      <HomeData />
    </Suspense>
  );
}

async function HomeData() {
  let tokens = [] as ReturnType<typeof parseRwaAssetRecords>;
  let feedUnavailable = false;

  try {
    const response: unknown = await getRWATokenList();
    if (!isRwaAssetListResponse(response, { allowEmpty: true })) {
      throw new Error("The RWA asset response could not be validated");
    }
    tokens = filterSpotEligibleAssets(parseRwaAssetRecords(response));
    feedUnavailable = tokens.length === 0;
  } catch (error) {
    console.error("Homepage RWA feed unavailable:", error);
    feedUnavailable = true;
  }

  // The homepage renders four opportunity cards; do not block first data paint on unused rows.
  const rows = feedUnavailable ? [] : await getOpportunityRows(tokens, 4);

  return (
    <>
      <Homepage rows={rows} assetCount={tokens.length} feedUnavailable={feedUnavailable} />
      <GlobalNav />
    </>
  );
}
