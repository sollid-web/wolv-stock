import { getRWATokenList, getRWAPlatforms } from "@/lib/binance";
import Link from "next/link";
import StockList from "@/components/StockList";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [platforms, tokens] = await Promise.all([getRWAPlatforms(), getRWATokenList()]);
  const allTokens: any[] = tokens?.data ?? [];
  const slim = allTokens.map((t) => ({
    tokenContractAddress: t.tokenContractAddress,
    tokenLogoUrl: t.tokenLogoUrl,
    underlyingTicker: t.underlyingTicker,
    underlyingName: t.underlyingName,
    tokenName: t.tokenName,
    platformId: t.platformId,
  }));

  return (
    <main className="min-h-screen bg-[#07070f] text-white">
      <nav className="border-b border-[#1b1b35] bg-[#0e0e1c] px-4 sm:px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#f0b90b] flex items-center justify-center font-black text-black text-sm">W</div>
          <span className="font-bold text-lg tracking-wide">WOLV Stock Terminal</span>
        </div>
        <Link href="/gap" className="text-xs font-bold px-3 py-1 rounded-full bg-[#f0b90b]/10 border border-[#f0b90b]/30 text-[#f0b90b]">
          📊 Executable Prices
        </Link>
      </nav>

      <div className="px-4 sm:px-6 py-4 flex gap-3 overflow-x-auto">
        {platforms?.data?.map((p: any) => (
          <div key={p.platformId} className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl px-4 py-3 flex-shrink-0">
            <div className="flex items-center gap-2 mb-1">
              <img src={p.logoUrl} className="w-5 h-5 rounded-full" alt={p.platformId} />
              <span className="font-bold text-sm capitalize">{p.platformId}</span>
            </div>
            <div className="text-[#f0b90b] font-black text-xl">{p.tickerCount}</div>
            <div className="text-[#64748b] text-xs">tokenized stocks</div>
          </div>
        ))}
        <div className="bg-[#0e0e1c] border border-[#1b1b35] rounded-xl px-4 py-3 flex-shrink-0">
          <div className="text-[#64748b] text-xs mb-1">Total Available</div>
          <div className="text-[#f0b90b] font-black text-xl">{allTokens.length}</div>
          <div className="text-[#64748b] text-xs">on BSC chain</div>
        </div>
      </div>

      <StockList tokens={slim} />
    </main>
  );
}
