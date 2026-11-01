import { NextResponse } from "next/server";
import { EVM_ADDRESS_PATTERN, isPositiveUint256, isSafeOrderId, normalizeUint256 } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { BrowserTradeIntentStoreError, getDefaultBrowserTradeIntentStore } from "@/services/browserTradeIntentStore";
import { rejectUnsupportedBrowserExecution } from "@/services/browserTradeExecutionBoundary";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const toToken = searchParams.get("toToken");
    const amountInput = searchParams.get("amount");
    const wallet = searchParams.get("userWalletAddress");
    const quoteId = searchParams.get("quoteId");
    const quoteBinding = searchParams.get("quoteBinding");
    const executionId = searchParams.get("executionIntentId");

    if (!toToken || !amountInput || !wallet || !quoteId || !quoteBinding || !executionId) {
      return NextResponse.json(
        { error: "Missing required trade intent parameters" },
        { status: 400 },
      );
    }
    if (
      !EVM_ADDRESS_PATTERN.test(toToken) ||
      !EVM_ADDRESS_PATTERN.test(wallet) ||
      !isPositiveUint256(amountInput) ||
      !isSafeOrderId(quoteId)
    ) return NextResponse.json({ error: "Invalid token, wallet, amount, or quote ID" }, { status: 400 });
    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Only supported spot tokenized assets can be swapped" }, { status: 400 });
    }

    const result = await rejectUnsupportedBrowserExecution({
      executionId,
      quoteId,
      quoteBinding,
      wallet,
      toToken,
      amount: normalizeUint256(amountInput)!,
      operation: "SWAP",
      store: getDefaultBrowserTradeIntentStore(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      error: "Binance SWAP transaction schema is not documented or fixture-verified; transaction creation and execution are disabled.",
      code: result.code,
    }, { status: 501 });
  } catch (error: unknown) {
    if (error instanceof BrowserTradeIntentStoreError) {
      console.error("Browser trade intent store failed:", error);
      return NextResponse.json({ error: "Durable trade-intent storage is unavailable." }, { status: 503 });
    }
    console.error("Error in swap API:", error);
    return NextResponse.json({ error: "Swap execution is disabled." }, { status: 503 });
  }
}
