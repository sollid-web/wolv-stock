import { getRWATokenList } from "@/lib/binance";
import Link from "next/link";
import StockList from "@/components/StockList";
import CategoryTabs from "@/components/CategoryTabs";
import { RWA_TABS, parseTabId } from "@/lib/rwaData";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { parseRwaAssetRecords } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

export default async function Markets({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const tabId = parseTabId(tab);
  const tabLabel = RWA_TABS.find((item) => item.id === tabId)?.label;
  const listResult = await getRWATokenList(undefined, tabId ?? undefined)
    .then((data: unknown) => ({ data: parseRwaAssetRecords(data), error: null as string | null }))
    .catch((error: unknown) => ({
      data: [] as ReturnType<typeof parseRwaAssetRecords>,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
    }));

  const tokens = filterSpotEligibleAssets(listResult.data);
  const feedUnavailable = listResult.error !== null || (tabId === null && tokens.length === 0);
  const stockListTokens = tokens.map((token) => ({
    tokenContractAddress: token.tokenContractAddress,
    tokenLogoUrl: token.tokenLogoUrl,
    underlyingTicker: token.underlyingTicker,
    underlyingName: token.underlyingName,
    tokenName: token.tokenName,
    platformId: token.platformId,
    tags: Array.isArray(token.tags) ? token.tags : [],
  }));

  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white">
      <nav className="sticky top-0 z-10 border-b border-white/[0.1] bg-[#070711]/72 px-4 py-4 backdrop-blur-2xl sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3" aria-label="Back to WOLV home">
            <div className="grid size-9 place-items-center rounded-xl bg-[#d9a80a] text-sm font-black text-black shadow-[0_0_24px_rgba(217,168,10,0.2)]">W</div>
            <div>
              <span className="block text-sm font-black tracking-[0.18em] text-white">WOLV</span>
              <span className="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:block">Spot Lens</span>
            </div>
          </Link>
          <Link href="/gap" className="rounded-full border border-[#d9a80a]/40 bg-[#d9a80a]/10 px-3 py-2 text-xs font-bold text-[#d9a80a] transition hover:bg-[#d9a80a]/20 sm:px-4">
            Price monitor <span aria-hidden="true">→</span>
          </Link>
        </div>
      </nav>

      <section className="mx-auto max-w-7xl px-4 pb-5 pt-8 sm:px-8 sm:pt-12">
        <div className="max-w-3xl">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#d9a80a]/25 bg-[#d9a80a]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#d9a80a]">
            BSC spot directory
          </p>
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Browse tokenized markets</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400 sm:text-base">
            Search eligible BSC assets, filter by category or issuer, and open an asset to inspect its details and trade route.
          </p>
          <p className="mt-3 text-xs font-bold uppercase tracking-wider text-slate-500">
            {feedUnavailable ? "Asset coverage unavailable" : `${tokens.length} eligible asset${tokens.length === 1 ? "" : "s"}${tabLabel ? ` · ${tabLabel}` : ""}`}
          </p>
        </div>
      </section>

      <CategoryTabs active={tabId} basePath="/markets" />

      {listResult.error && (
        <div role="status" className="mx-auto mb-4 max-w-7xl px-4 sm:px-8">
          <div className="rounded-xl border border-yellow-800/40 bg-yellow-900/10 p-4 text-sm leading-relaxed text-yellow-200">
            The live asset list is unavailable. No assets are inferred from missing data.
            <span className="mt-1 block break-words text-xs text-yellow-100/70">{listResult.error}</span>
          </div>
        </div>
      )}

      <StockList key={tabId ?? "all"} tokens={stockListTokens} category={tabLabel} feedUnavailable={feedUnavailable} />
      <GlobalNav />
    </main>
  );
}
