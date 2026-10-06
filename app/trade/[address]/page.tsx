import Link from "next/link";
import Image from "next/image";
import { getRWATokenList } from "@/lib/binance";
import TradeButton from "@/components/TradeButton";
import GlobalNav from "@/components/GlobalNav";
import BackButton from "@/components/BackButton";
import SmartRouterStatus from "@/components/SmartRouterStatus";
import { isSpotEligibleAsset } from "@/lib/compliance";
import { isRwaToken } from "@/lib/rwaTypes";
import AssetFeedUnavailable from "@/components/AssetFeedUnavailable";

export const dynamic = "force-dynamic";

export default async function TradePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const tokens = await getRWATokenList().catch((error: unknown) => {
    console.error("Trade detail RWA list unavailable:", error);
    return null;
  });
  if (!tokens) {
    return (
      <AssetFeedUnavailable
        title="Trading asset list unavailable"
        description="WOLV could not verify this asset as a supported spot token. Trading stays unavailable until the live asset feed can be checked."
        backHref="/trade"
        backLabel="Back to trade markets"
      />
    );
  }
  const rawTokens: unknown[] = Array.isArray(tokens?.data) ? tokens.data as unknown[] : [];
  const token = rawTokens.filter(isRwaToken).find((t) =>
    t.tokenContractAddress.toLowerCase() === address.toLowerCase() && isSpotEligibleAsset(t)
  );

  if (!token) {
    return (
      <main className="min-h-screen bg-[#07070f] text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="text-[#64748b]">Asset not found. Please check the asset address or return to the trade page to select an asset.</p>
          <Link href="/trade" className="text-[#d9a80a] text-sm mt-4 block">← Back to Trade Page</Link>
        </div>
      </main>
    );
  }

  const tokenInfo = {
    address: token.tokenContractAddress,
    symbol: token.underlyingTicker || "UNKNOWN",
    name: token.underlyingName || token.tokenName || "Unknown Token",
  };

  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-0">
      <nav className="sticky top-0 z-10 flex items-center gap-4 border-b border-white/[0.1] bg-[#070711]/72 px-4 py-4 backdrop-blur-2xl sm:px-6">
        <BackButton fallbackHref="/trade" className="text-[#64748b] text-xl" />
        {token.tokenLogoUrl && (
          <Image
            src={token.tokenLogoUrl}
            width={32}
            height={32}
            className="w-8 h-8 rounded-full"
            alt={token.underlyingTicker ?? "Asset"}
          />
        )}
        <div className="min-w-0">
          <div className="font-black text-lg">{tokenInfo.symbol}</div>
          <div className="text-xs text-[#64748b] truncate">
            {tokenInfo.name}
          </div>
        </div>
      </nav>

      <div className="mx-auto w-full max-w-5xl px-4 pt-6 sm:px-6">
        <SmartRouterStatus ticker={tokenInfo.symbol} />
        <TradeButton token={tokenInfo} />
      </div>

      <GlobalNav />
    </main>
  );
}
