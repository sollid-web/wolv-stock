import { getRWATokenList, getRWAPlatforms } from "@/lib/binance";
import Link from "next/link";
import Image from "next/image";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { parseRwaAssetRecords, parseRwaPlatformRecords } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [platformResult, listResult] = await Promise.all([
    getRWAPlatforms()
      .then((data: unknown) => ({ data: parseRwaPlatformRecords(data), error: null as string | null }))
      .catch((error: unknown) => ({
        data: [] as ReturnType<typeof parseRwaPlatformRecords>,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
    getRWATokenList()
      .then((data: unknown) => ({ data: parseRwaAssetRecords(data), error: null as string | null }))
      .catch((error: unknown) => ({
        data: [] as ReturnType<typeof parseRwaAssetRecords>,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
  ]);

  const allTokens = filterSpotEligibleAssets(listResult.data);
  const feedUnavailable = listResult.error !== null || allTokens.length === 0;
  const platformsUnavailable = platformResult.error !== null || platformResult.data.length === 0;

  return (
    <main className="min-h-screen bg-[#07070f] pb-[calc(6rem+env(safe-area-inset-bottom))] text-white">
      <nav className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#0a0a14]/90 px-4 py-4 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3" aria-label="WOLV Spot Lens home">
            <div className="grid size-9 place-items-center rounded-xl bg-[#f0b90b] text-sm font-black text-black shadow-[0_0_24px_rgba(240,185,11,0.2)]">W</div>
            <div>
              <span className="block text-sm font-black tracking-[0.18em] text-white">WOLV</span>
              <span className="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:block">Spot Lens</span>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/markets" className="rounded-full border border-white/[0.1] px-3 py-2 text-xs font-bold text-slate-200 transition hover:border-[#f0b90b]/40 sm:px-4">
              Browse markets
            </Link>
            <Link href="/gap" className="rounded-full border border-[#f0b90b]/40 bg-[#f0b90b]/10 px-3 py-2 text-xs font-bold text-[#f0b90b] transition hover:bg-[#f0b90b]/20 sm:px-4">
              Price monitor <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </nav>

      <section className="relative mx-auto max-w-7xl overflow-hidden px-4 pb-8 pt-8 sm:px-8 sm:pb-12 sm:pt-14">
        <div className="wolv-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative grid gap-8 lg:grid-cols-[1.15fr_.85fr] lg:items-center">
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/[0.08] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f0b90b]">
              <span className="wolv-pulse size-1.5 rounded-full bg-[#f0b90b]" /> BSC tokenized markets
            </div>
            <h1 className="text-4xl font-black tracking-[-0.04em] text-white sm:text-6xl">
              See the price.<br /><span className="text-[#f0b90b]">Trust the route.</span>
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">
              WOLV makes tokenized-stock trading understandable: compare venues, spot unreliable quotes, preview the transaction, then trade on BSC.
            </p>
            <div className="mt-6 flex flex-wrap gap-2 text-xs font-bold text-slate-300">
              <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-2">Spot only</span>
              <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-2">BSC Mainnet</span>
              <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-2">Preflight before signing</span>
            </div>
          </div>

          <section aria-labelledby="coverage-title" className="wolv-float relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0e0e1c]/90 p-5 shadow-[0_20px_80px_rgba(0,0,0,.32)] sm:p-6">
            <div className="wolv-scan absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-[#f0b90b]/10 to-transparent" />
            <div className="relative flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Market overview</p>
                <h2 id="coverage-title" className="mt-1 text-lg font-black">Live BSC coverage</h2>
              </div>
              <span className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${feedUnavailable ? "border-yellow-800/50 bg-yellow-900/10 text-yellow-200" : "wolv-pulse border-emerald-400/30 bg-emerald-400/10 text-emerald-300"}`}>
                {feedUnavailable ? "feed unavailable" : "online"}
              </span>
            </div>
            <div className="relative mt-6 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="text-xl font-black text-white">{feedUnavailable ? "—" : allTokens.length}</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">assets</div>
              </div>
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="text-xl font-black text-white">{platformsUnavailable ? "—" : platformResult.data.length}</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">venues</div>
              </div>
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="text-xl font-black text-[#f0b90b]">BSC</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">spot venue</div>
              </div>
            </div>
            <p className="relative mt-4 text-xs leading-relaxed text-slate-500">
              Counts describe eligible records returned by the live RWA feed; they are not prices or executable quotes.
            </p>
          </section>
        </div>
      </section>

      {feedUnavailable && (
        <div role="status" className="mx-auto mb-6 max-w-7xl px-4 sm:px-8">
          <div className="rounded-xl border border-yellow-800/40 bg-yellow-900/10 p-4 text-sm leading-relaxed text-yellow-200">
            Live market data is unavailable. WOLV will not infer asset counts or prices from a missing feed.
            {listResult.error && <span className="mt-1 block break-words text-xs text-yellow-100/70">{listResult.error}</span>}
          </div>
        </div>
      )}

      {platformResult.error && (
        <div role="status" className="mx-auto mb-6 max-w-7xl px-4 sm:px-8">
          <div className="rounded-xl border border-yellow-800/40 bg-yellow-900/10 p-4 text-sm text-yellow-200">
            Venue details are temporarily unavailable.
          </div>
        </div>
      )}

      <section aria-label="Venue coverage" className="mx-auto grid max-w-7xl grid-cols-1 gap-3 px-4 pb-6 sm:grid-cols-2 sm:px-8 lg:grid-cols-3">
        {platformResult.data.map((platform) => {
          const count = allTokens.filter((token) => token.platformId === platform.platformId).length;
          return (
            <div key={platform.platformId} className="wolv-sheen min-w-0 rounded-xl border border-white/[0.08] p-4 transition hover:-translate-y-1 hover:border-[#f0b90b]/40 sm:p-5">
              <div className="mb-1 flex items-center gap-2">
                {platform.logoUrl && <Image src={platform.logoUrl} width={20} height={20} className="rounded-full" alt={platform.platformId} />}
                <span className="text-sm font-bold capitalize">{platform.platformId}</span>
              </div>
              <div className="text-xl font-black text-[#f0b90b]">{feedUnavailable ? "—" : count}</div>
              <div className="text-xs text-slate-300">{feedUnavailable ? "feed unavailable" : "eligible BSC assets"}</div>
            </div>
          );
        })}
        <div className="wolv-sheen min-w-0 rounded-xl border border-white/[0.08] p-4 transition hover:-translate-y-1 hover:border-[#f0b90b]/40 sm:p-5">
          <div className="mb-1 text-xs text-slate-300">Total available</div>
          <div className="text-xl font-black text-[#f0b90b]">{feedUnavailable ? "—" : allTokens.length}</div>
          <div className="text-xs text-slate-300">{feedUnavailable ? "feed unavailable" : "eligible BSC assets"}</div>
        </div>
      </section>

      <section aria-label="Explore WOLV" className="mx-auto grid max-w-7xl gap-4 px-4 pb-10 sm:grid-cols-2 sm:px-8">
        <Link href="/markets" className="group rounded-2xl border border-white/[0.1] bg-gradient-to-br from-[#151322] to-[#0e0e1c] p-5 transition hover:border-[#f0b90b]/45 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#f0b90b]">Find an asset</p>
          <h2 className="mt-2 text-xl font-black">Browse tokenized markets <span aria-hidden="true" className="transition group-hover:translate-x-1">→</span></h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">Search the full BSC spot-eligible directory, filter by venue or category, and open an asset’s detail page.</p>
        </Link>
        <Link href="/gap" className="group rounded-2xl border border-white/[0.1] bg-gradient-to-br from-[#151322] to-[#0e0e1c] p-5 transition hover:border-[#f0b90b]/45 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#f0b90b]">Compare routes</p>
          <h2 className="mt-2 text-xl font-black">Open the price monitor <span aria-hidden="true" className="transition group-hover:translate-x-1">→</span></h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">Compare listed reference data with fresh executable spot quotes, quote reliability, and market-session context.</p>
        </Link>
      </section>

      <GlobalNav />
    </main>
  );
}
