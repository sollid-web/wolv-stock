import { getRWATokenList, getRWAPlatforms } from "@/lib/binance";
import Link from "next/link";
import Image from "next/image";
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

export default async function Markets({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const tabId = parseTabId(tab); // null = All (no tabId sent to Binance)
  const tabLabel = RWA_TABS.find((t) => t.id === tabId)?.label;
  const [platformResult, list] = await Promise.all([
    getRWAPlatforms()
      .then((data: unknown) => ({ data: data as PlatformListResponse, err: null as string | null }))
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
          <div className="wolv-float relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0e0e1c]/90 p-5 shadow-[0_20px_80px_rgba(0,0,0,.32)]">
            <div className="wolv-scan absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-[#f0b90b]/10 to-transparent" />
            <div className="relative flex items-center justify-between"><div><div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Market pulse</div><div className="mt-1 text-lg font-black">Live BSC coverage</div></div><span className="wolv-pulse rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">online</span></div>
            <div className="relative mt-6 flex h-24 items-end gap-1.5 border-b border-white/[0.08] pb-2">{Array.from({ length: 18 }, (_, i) => { const height = 24 + ((i * 17 + allTokens.length) % 58); return <span key={i} className="wolv-chart-area flex-1 rounded-t-sm bg-gradient-to-t from-[#f0b90b]/20 to-[#f0b90b]" style={{ height: `${height}%`, opacity: 0.35 + (i % 4) * 0.12 }} />; })}</div>
            <div className="relative mt-4 grid grid-cols-3 gap-3 text-center"><div><div className="text-xl font-black text-white">{allTokens.length}</div><div className="text-[10px] uppercase tracking-wider text-slate-500">assets</div></div><div><div className="text-xl font-black text-white">{platformResult.data?.data?.length ?? 0}</div><div className="text-[10px] uppercase tracking-wider text-slate-500">venues</div></div><div><div className="text-xl font-black text-[#f0b90b]">BSC</div><div className="text-[10px] uppercase tracking-wider text-slate-500">spot venue</div></div></div>
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-3 px-4 pb-6 sm:flex sm:flex-wrap sm:px-8">
        {platformResult.data?.data?.map((p) => (
          <div key={p.platformId} className="wolv-sheen min-w-0 rounded-xl border border-white/[0.08] p-4 transition hover:-translate-y-1 hover:border-[#f0b90b]/40 sm:p-5">
            <div className="flex items-center gap-2 mb-1">
              {p.logoUrl && <Image src={p.logoUrl} width={20} height={20} className="rounded-full" alt={p.platformId} />}
              <span className="font-bold text-sm capitalize">{p.platformId}</span>
            </div>
            <div className="text-[#f0b90b] font-black text-xl">{allTokens.filter((t) => t.platformId === p.platformId).length}</div>
            <div className="text-slate-300 text-xs">on BSC</div>
          </div>
        ))}
        <div className="wolv-sheen min-w-0 rounded-xl border border-white/[0.08] p-4 transition hover:-translate-y-1 hover:border-[#f0b90b]/40 sm:p-5">
          <div className="text-slate-300 text-xs mb-1">Total Available</div>
          <div className="text-[#f0b90b] font-black text-xl">{allTokens.length}</div>
          <div className="text-slate-300 text-xs">on BSC chain</div>
        </div>
      </div>

      <CategoryTabs active={tabId} basePath="/markets" />

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

      <StockList key={tabId ?? "all"} tokens={slim} category={tabLabel} />

      <GlobalNav />
    </main>
  );
}
