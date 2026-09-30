import { getRWATokenList, getRWAPlatforms } from "@/lib/binance";
import Link from "next/link";
import StockList from "@/components/StockList";
import CategoryTabs from "@/components/CategoryTabs";
import { RWA_TABS, parseTabId } from "@/lib/rwaData";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets } from "@/lib/compliance";

type RwaToken = {
  tokenContractAddress: string;
  tokenLogoUrl?: string;
  underlyingTicker: string;
  underlyingName?: string;
  tokenName?: string;
  platformId: string;
  tags?: string[] | null;
};

type TokenListResponse = { data?: RwaToken[] | null };
type PlatformListResponse = {
  data?: { platformId: string; logoUrl?: string }[] | null;
};

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const tabId = parseTabId(tab); // null = All (no tabId sent to Binance)
  const tabLabel = RWA_TABS.find((t) => t.id === tabId)?.label;
  const [platforms, list] = await Promise.all([
    getRWAPlatforms().then((data: unknown) => data as PlatformListResponse),
    getRWATokenList(undefined, tabId ?? undefined)
      .then((data: unknown) => ({ data: data as TokenListResponse, err: null as string | null }))
      .catch((error: unknown) => ({
        data: null,
        err: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
  ]);
  const tokens = list.data;
  const allTokens = filterSpotEligibleAssets(tokens?.data ?? []);
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
    <main className="min-h-screen bg-[#07070f] text-white pb-20">
      <nav className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#0a0a14]/90 px-4 py-4 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3" aria-label="WOLV Stock Terminal home">
            <div className="grid size-9 place-items-center rounded-xl bg-[#f0b90b] text-sm font-black text-black shadow-[0_0_24px_rgba(240,185,11,0.2)]">W</div>
            <div>
              <span className="block text-sm font-black tracking-[0.18em] text-white">WOLV</span>
              <span className="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:block">Stock Terminal</span>
            </div>
          </Link>
          <Link href="/gap" className="rounded-full border border-[#f0b90b]/40 bg-[#f0b90b]/10 px-3 py-2 text-xs font-bold text-[#f0b90b] transition hover:bg-[#f0b90b]/20 sm:px-4">
            Executable prices <span aria-hidden="true">→</span>
          </Link>
        </div>
      </nav>

      <section className="mx-auto max-w-7xl px-4 pb-5 pt-8 sm:px-8 sm:pt-12">
        <div className="max-w-2xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/[0.08] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f0b90b]"><span className="size-1.5 rounded-full bg-[#f0b90b]" /> BSC tokenized markets</div>
          <h1 className="text-3xl font-black tracking-tight text-white sm:text-5xl">Explore tokenized stocks<br className="hidden sm:block" /> built for onchain trading.</h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">Discover compliant spot assets across leading issuers. Compare venues, inspect live execution paths, and trade with confidence.</p>
        </div>
      </section>

      <div className="mx-auto flex max-w-7xl gap-3 overflow-x-auto px-4 pb-6 sm:px-8">
        {platforms?.data?.map((p) => (
          <div key={p.platformId} className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-5 flex-shrink-0">
            <div className="flex items-center gap-2 mb-1">
              <img src={p.logoUrl} className="w-5 h-5 rounded-full" alt={p.platformId} />
              <span className="font-bold text-sm capitalize">{p.platformId}</span>
            </div>
            <div className="text-[#f0b90b] font-black text-xl">{allTokens.filter((t) => t.platformId === p.platformId).length}</div>
            <div className="text-slate-300 text-xs">on BSC</div>
          </div>
        ))}
        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl p-5 flex-shrink-0">
          <div className="text-slate-300 text-xs mb-1">Total Available</div>
          <div className="text-[#f0b90b] font-black text-xl">{allTokens.length}</div>
          <div className="text-slate-300 text-xs">on BSC chain</div>
        </div>
      </div>

      <CategoryTabs active={tabId} />

      {list.err && (
        <div className="mx-4 sm:mx-6 mb-3 text-xs text-yellow-500 bg-yellow-900/10 border border-yellow-800/40 rounded-xl p-3">
          Couldn&apos;t load {tabLabel ?? "the token list"}: {list.err}
          {tabId != null && (
            <> · <Link href="/" className="underline">show all</Link></>
          )}
        </div>
      )}

      <StockList key={tabId ?? "all"} tokens={slim} category={tabLabel} />

      <GlobalNav />
    </main>
  );
}
