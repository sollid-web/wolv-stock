import App from "@/components/App";
import { getRWATokenList } from "@/lib/binance";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { parseRwaAssetRecords } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

export default async function Trade() {
  let assets: Record<string, unknown>[] = [];
  let feedError: string | null = null;

  try {
    const response: unknown = await getRWATokenList();
    const records = filterSpotEligibleAssets(parseRwaAssetRecords(response));
    assets = records.map((token) => ({
      address: token.tokenContractAddress,
      ticker: token.underlyingTicker || token.symbol || "ASSET",
      symbol: token.symbol || token.underlyingTicker || "ASSET",
      name: token.underlyingName || token.tokenName || token.name || token.underlyingTicker,
      platform: token.platformId,
      tokenPrice: token.tokenPrice ?? null,
      referencePrice: token.referencePrice ?? null,
      tokenToShareRatio: token.tokenToShareRatio ?? null,
      decimals: token.decimals ?? null,
      volume24H: token.volume24H ?? null,
      marketCap: token.marketCap ?? null,
      marketStatus: token.statusInfo?.marketStatus ?? null,
      openState: token.statusInfo?.openState ?? null,
    }));
  } catch (error: unknown) {
    console.error("Trade terminal RWA list unavailable:", error);
    feedError = "The live Binance asset feed is unavailable. No fallback symbols or prices are shown.";
  }

  return <App assets={assets} feedError={feedError} />;
}
