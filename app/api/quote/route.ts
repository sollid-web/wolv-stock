import { NextResponse } from "next/server";
import { MINIMUM_ORDER_USDT } from "@/lib/apiValidation";
import { getAggregatorQuote, getRWATokenList } from "@/lib/binance";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { BrowserTradeIntentStoreError, getDefaultBrowserTradeIntentStore } from "@/services/browserTradeIntentStore";
import { handleBrowserTradeQuoteRequest } from "@/services/browserTradeQuote";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const result = await handleBrowserTradeQuoteRequest(request, {
        getQuote: getAggregatorQuote,
        getAssetList: getRWATokenList,
        isSpotToken: isSpotRwaTokenAddress,
        store: getDefaultBrowserTradeIntentStore,
    });
    if (result.status >= 500) console.error("Browser trade quote unavailable:", result.body.code ?? result.body.error);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    if (error instanceof BrowserTradeIntentStoreError) {
      console.error("Browser trade intent store failed:", error);
      return NextResponse.json(
        { error: "Durable trade-intent storage is unavailable; quote retrieval is disabled." },
        { status: 503 },
      );
    }
    console.error("Error in quote API:", error);
    const message = error instanceof Error ? error.message : "";
    if (/API error 40375:/i.test(message)) {
      return NextResponse.json(
        { error: `Minimum order amount is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).` },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "Quote service is temporarily unavailable" }, { status: 502 });
  }
}
