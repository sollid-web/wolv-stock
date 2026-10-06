import { getRWATokenList } from "@/lib/binance";
import Homepage from "@/components/Homepage";
import GlobalNav from "@/components/GlobalNav";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { isRwaAssetListResponse } from "@/lib/rwaAssetResponse";
import { getOpportunityRows } from "@/lib/opportunityMonitor";
import { parseRwaAssetRecords } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

export default async function Home() {
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

  const rows = feedUnavailable ? [] : await getOpportunityRows(tokens, 8);

  return (
    <>
      <Homepage rows={rows} assetCount={tokens.length} feedUnavailable={feedUnavailable} />
      <GlobalNav />
    </>
  );
}
