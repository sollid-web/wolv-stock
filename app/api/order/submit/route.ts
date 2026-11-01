import { NextResponse } from "next/server";
import { isSafeOrderId, EVM_ADDRESS_PATTERN, isPositiveUint256, normalizeUint256 } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { BrowserTradeIntentStoreError, getDefaultBrowserTradeIntentStore } from "@/services/browserTradeIntentStore";
import { rejectUnsupportedBrowserExecution } from "@/services/browserTradeExecutionBoundary";

export const dynamic = "force-dynamic";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) return NextResponse.json({ error: "Invalid RFQ submission request" }, { status: 400 });
    const {
      requestId,
      userSignature,
      vendor,
      quoteId,
      toToken,
      amount,
      userWalletAddress,
      quoteBinding,
      executionIntentId,
    } = body;

    if (
      typeof requestId !== "string" ||
      typeof userSignature !== "string" ||
      typeof vendor !== "string" ||
      typeof quoteId !== "string" ||
      typeof toToken !== "string" ||
      typeof amount !== "string" ||
      typeof userWalletAddress !== "string" ||
      typeof quoteBinding !== "string" ||
      typeof executionIntentId !== "string"
    ) return NextResponse.json({ error: "Missing required RFQ submission parameters" }, { status: 400 });

    if (
      !UUID_V4_PATTERN.test(requestId) ||
      !/^0x(?:[a-fA-F0-9]{128}|[a-fA-F0-9]{130})$/.test(userSignature) ||
      vendor.length > 128 ||
      /[\r\n]/.test(vendor) ||
      !isSafeOrderId(quoteId) ||
      !EVM_ADDRESS_PATTERN.test(toToken) ||
      !isPositiveUint256(amount) ||
      !EVM_ADDRESS_PATTERN.test(userWalletAddress)
    ) return NextResponse.json({ error: "Invalid RFQ signature, vendor, or trade parameters" }, { status: 400 });
    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Only supported spot tokenized assets can be submitted" }, { status: 400 });
    }

    const result = await rejectUnsupportedBrowserExecution({
      executionId: executionIntentId,
      quoteId,
      quoteBinding,
      wallet: userWalletAddress,
      toToken,
      amount: normalizeUint256(amount)!,
      operation: "RFQ",
      store: getDefaultBrowserTradeIntentStore(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      error: "Binance RFQ typed-data schema is not documented or fixture-verified; signing and order submission are disabled.",
      code: result.code,
    }, { status: 501 });
  } catch (error: unknown) {
    if (error instanceof BrowserTradeIntentStoreError) {
      console.error("Browser trade intent store failed:", error);
      return NextResponse.json({ error: "Durable trade-intent storage is unavailable." }, { status: 503 });
    }
    console.error("Error in order submit API:", error);
    return NextResponse.json({ error: "RFQ order submission is disabled." }, { status: 503 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
