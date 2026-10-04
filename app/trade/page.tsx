import Link from "next/link";
import Image from "next/image";
import { getRWATokenList, getRWAPlatforms } from "@/lib/binance";
import StockList from "@/components/StockList";
import CategoryTabs from "@/components/CategoryTabs";
import { RWA_TABS, parseTabId } from "@/lib/rwaData";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { parseRwaAssetRecords, parseRwaPlatformRecords, type RwaAssetRecord } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

export default async function Trade({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const tabId = parseTabId(tab); // null = All (no tabId sent to Binance)
  const tabLabel = RWA_TABS.find((t) => t.id === tabId)?.label;
  const [platformResponse, list] = await Promise.all([
    getRWAPlatforms()
      .then((data: unknown) => ({ data: parseRwaPlatformRecords(data), err: null as string | null }))
      .catch((error: unknown) => ({
        data: [] as ReturnType<typeof parseRwaPlatformRecords>,
        err: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
    getRWATokenList(undefined, tabId ?? undefined)
      .then((data: unknown) => ({ data: parseRwaAssetRecords(data), err: null as string | null }))
      .catch((error: unknown) => ({
        data: [] as RwaAssetRecord[],
        err: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      })),
  ]);
  const platforms = platformResponse.data;
  const allTokens = filterSpotEligibleAssets(list.data);
  const slim = allTokens.map((t) => ({
    tokenContractAddress: t.tokenContractAddress,
    tokenLogoUrl: t.tokenLogoUrl ?? undefined,
    underlyingTicker: t.underlyingTicker ?? "UNKNOWN",
    underlyingName: t.underlyingName ?? undefined,
    tokenName: t.tokenName ?? undefined,
    platformId: t.platformId ?? "unknown",
    tags: t.tags ?? [],
  }));

  return (
    <main className="min-h-screen bg-[#07070f] pb-24 text-white md:pb-0">
      <nav className="border-b border-[#1b1b35] bg-[#0e0e1c] px-4 py-4 sm:px-6 flex items-center justify-between gap-3 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#f0b90b] flex items-center justify-center font-black text-black text-sm">W</div>
          <span className="truncate font-bold text-sm tracking-wide sm:text-lg">WOLV Spot Lens</span>
        </div>
        <div className="flex items-center gap-2">
            <Link href="/" className="text-xs text-[#64748b] hover:text-white sm:text-sm">
            ← <span className="hidden sm:inline">Home</span>
          </Link>
          <span className="text-xs text-[#64748b]">/</span>
            <Link href="/trade" className="text-xs font-bold text-[#f0b90b] sm:text-sm">
            Trade
          </Link>
        </div>
      </nav>

      <div className="px-4 sm:px-6 py-4 flex gap-3 overflow-x-auto">
        {platforms.map((p) => (
          <div key={p.platformId} className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl px-4 py-3 flex-shrink-0">
            <div className="flex items-center gap-2 mb-1">
              {p.logoUrl && <Image src={p.logoUrl} width={20} height={20} className="rounded-full" alt={p.platformId} />}
              <span className="font-bold text-sm capitalize">{p.platformId}</span>
            </div>
            <div className="text-[#f0b90b] font-black text-xl">{allTokens.filter((t) => t.platformId === p.platformId).length}</div>
            <div className="text-[#64748b] text-xs">on BSC</div>
          </div>
        ))}
        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl px-4 py-3 flex-shrink-0">
          <div className="text-[#64748b] text-xs mb-1">Total Available</div>
          <div className="text-[#f0b90b] font-black text-xl">{allTokens.length}</div>
          <div className="text-[#64748b] text-xs">on BSC chain</div>
        </div>
      </div>

      <CategoryTabs active={tabId} />

      {platformResponse.err && (
        <div role="status" className="mx-4 sm:mx-6 mb-3 text-xs text-yellow-500 bg-yellow-900/10 border border-yellow-800/40 rounded-xl p-3">
          Platform metadata is temporarily unavailable: {platformResponse.err}
        </div>
      )}

      {list.err && (
        <div className="mx-4 sm:mx-6 mb-3 text-xs text-yellow-500 bg-yellow-900/10 border border-yellow-800/40 rounded-xl p-3">
          Couldn&apos;t load {tabLabel ?? "the token list"}: {list.err}
          {tabId != null && (
            <> · <Link href="/trade" className="underline">show all</Link></>
          )}
        </div>
      )}

      <div className="px-4 sm:px-6 pb-10">
        <h2 className="mb-4 text-xl font-bold text-center">Select an Asset to Trade</h2>
        <StockList key={tabId ?? "all"} tokens={slim} category={tabLabel} />
      </div>

      <GlobalNav />
    </main>
  );
}
