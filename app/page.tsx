import { getRWATokenList, getRWAPlatforms } from "@/lib/binance";
import Link from "next/link";
import Image from "next/image";
import StockList from "@/components/StockList";
import CategoryTabs from "@/components/CategoryTabs";
import { RWA_TABS, parseTabId } from "@/lib/rwaData";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { parseRwaAssetRecords, parseRwaPlatformRecords } from "@/lib/spotAssets";
import { getOpportunityRows } from "@/lib/opportunityMonitor";
import OpportunitySpotlight from "@/components/OpportunitySpotlight";

type TokenListResponse = { data?: unknown };
type PlatformListResponse = {
  data?: { platformId: string; logoUrl?: string }[] | null;
};

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const tabId = parseTabId(tab); // null = All (no tabId sent to Binance)
  const tabLabel = RWA_TABS.find((t) => t.id === tabId)?.label;
  const [platformResult, list] = await Promise.all([
    getRWAPlatforms()
      .then((data: unknown) => ({ data: { data: parseRwaPlatformRecords(data) } as PlatformListResponse, err: null as string | null }))
      .catch((error: unknown) => ({
        data: null,
        err: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
    getRWATokenList(undefined, tabId ?? undefined)
      .then((data: unknown) => ({ data: data as TokenListResponse, err: null as string | null }))
      .catch((error: unknown) => ({
        data: null,
        err: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
  ]);
  const tokens = list.data;
  const allTokens = filterSpotEligibleAssets(parseRwaAssetRecords(tokens));
  const [featuredOpportunity] = await getOpportunityRows(allTokens, 1);
  const slim = allTokens.map((t) => ({
    tokenContractAddress: t.tokenContractAddress,
    tokenLogoUrl: t.tokenLogoUrl,
    underlyingTicker: t.underlyingTicker,
    underlyingName: t.underlyingName,
    tokenName: t.tokenName,
    platformId: t.platformId,
    tags: Array.isArray(t.tags) ? t.tags : [],
  }));

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
          <Link href="/gap" className="rounded-full border border-[#f0b90b]/40 bg-[#f0b90b]/10 px-3 py-2 text-xs font-bold text-[#f0b90b] transition hover:bg-[#f0b90b]/20 sm:px-4">
            Executable prices <span aria-hidden="true">→</span>
          </Link>
        </div>
      </nav>

      <section className="relative mx-auto max-w-7xl overflow-hidden px-4 pb-8 pt-8 sm:px-8 sm:pb-12 sm:pt-14">
        <div className="wolv-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative grid gap-8 lg:grid-cols-[1.15fr_.85fr] lg:items-end">
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/[0.08] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f0b90b]"><span className="wolv-pulse size-1.5 rounded-full bg-[#f0b90b]" /> BSC tokenized markets</div>
            <h1 className="text-4xl font-black tracking-[-0.04em] text-white sm:text-6xl">See the price.<br /><span className="text-[#f0b90b]">Trust the route.</span></h1>
            <p className="mt-5 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">WOLV makes tokenized-stock trading understandable: compare venues, spot unreliable quotes, preview the transaction, then trade on BSC.</p>
            <div className="mt-6 flex flex-wrap gap-2 text-xs font-bold text-slate-300"><span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-2">Spot only</span><span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-2">BSC Mainnet</span><span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-2">Preflight before signing</span></div>
          </div>
          <div className="wolv-float min-w-0"><OpportunitySpotlight row={featuredOpportunity} feedUnavailable={list.err != null} /></div>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-3 px-4 pb-6 sm:flex sm:flex-wrap sm:px-8">
        {platformResult.data?.data?.map((p) => (
          <div key={p.platformId} className="wolv-sheen min-w-0 rounded-xl border border-white/[0.08] p-4 transition hover:-translate-y-1 hover:border-[#f0b90b]/40 sm:p-5">
            <div className="flex items-center gap-2 mb-1">
              {p.logoUrl && <Image src={p.logoUrl} width={20} height={20} className="rounded-full" alt={p.platformId} />}
              <span className="font-bold text-sm capitalize">{p.platformId}</span>
            </div>
            <div className="text-[#f0b90b] font-black text-xl">{list.err ? "—" : allTokens.filter((t) => t.platformId === p.platformId).length}</div>
            <div className="text-slate-300 text-xs">{list.err ? "feed unavailable" : "on BSC"}</div>
          </div>
        ))}
        <div className="wolv-sheen min-w-0 rounded-xl border border-white/[0.08] p-4 transition hover:-translate-y-1 hover:border-[#f0b90b]/40 sm:p-5">
          <div className="text-slate-300 text-xs mb-1">Total Available</div>
          <div className="text-[#f0b90b] font-black text-xl">{list.err ? "—" : allTokens.length}</div>
          <div className="text-slate-300 text-xs">{list.err ? "feed unavailable" : "on BSC chain"}</div>
        </div>
      </div>

      <CategoryTabs active={tabId} basePath="/" />

      {list.err && (
        <div className="mx-4 mb-3 break-words rounded-xl border border-yellow-800/40 bg-yellow-900/10 p-3 text-xs text-yellow-500 sm:mx-6">
          Couldn&apos;t load {tabLabel ?? "the token list"}: {list.err}
          {tabId != null && (
            <> · <Link href="/" className="underline">show all</Link></>
          )}
        </div>
      )}
      {platformResult.err && (
        <div role="status" className="mx-4 mb-3 break-words rounded-xl border border-yellow-800/40 bg-yellow-900/10 p-3 text-xs text-yellow-500 sm:mx-6">
          Platform metadata is temporarily unavailable: {platformResult.err}
        </div>
      )}

      <StockList key={tabId ?? "all"} tokens={slim} category={tabLabel} feedUnavailable={list.err != null} />

      <GlobalNav />
    </main>
  );
}
