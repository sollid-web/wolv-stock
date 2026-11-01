import { NextResponse } from "next/server";
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isPositiveUint256, isSafeOrderId, normalizeUint256 } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { BrowserTradeIntentStoreError, getDefaultBrowserTradeIntentStore } from "@/services/browserTradeIntentStore";
import { rejectUnsupportedBrowserExecution } from "@/services/browserTradeExecutionBoundary";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tokenContractAddress = searchParams.get("tokenContractAddress");
    const toToken = searchParams.get("toToken");
    const approveAmount = searchParams.get("approveAmount");
    const wallet = searchParams.get("userWalletAddress");
    const quoteId = searchParams.get("quoteId");
    const quoteBinding = searchParams.get("quoteBinding");
    const executionId = searchParams.get("executionIntentId");
    const vendor = searchParams.get("vendor");

    if (!tokenContractAddress || !toToken || !approveAmount || !wallet || !quoteId || !quoteBinding || !executionId) {
      return NextResponse.json({ error: "Missing required trade intent parameters" }, { status: 400 });
    }
    if (
      tokenContractAddress.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase() ||
      !EVM_ADDRESS_PATTERN.test(toToken) ||
      !EVM_ADDRESS_PATTERN.test(wallet) ||
      !isPositiveUint256(approveAmount) ||
      !isSafeOrderId(quoteId) ||
      (vendor !== null && (vendor.length > 128 || /[\r\n]/.test(vendor)))
    ) return NextResponse.json({ error: "Invalid approval token, target asset, wallet, amount, or quote ID" }, { status: 400 });
    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Approvals are limited to supported spot tokenized assets" }, { status: 400 });
    }

    const result = await rejectUnsupportedBrowserExecution({
      executionId,
      quoteId,
      quoteBinding,
      wallet,
      toToken,
      amount: normalizeUint256(approveAmount)!,
      operation: "APPROVAL",
      store: getDefaultBrowserTradeIntentStore(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      error: "Approval transaction retrieval is disabled because the Binance approval spender and transaction formats are not independently verified.",
      code: result.code,
    }, { status: 501 });
  } catch (error: unknown) {
    if (error instanceof BrowserTradeIntentStoreError) {
      console.error("Browser trade intent store failed:", error);
      return NextResponse.json({ error: "Durable trade-intent storage is unavailable." }, { status: 503 });
    }
    console.error("Error in approve-transaction API:", error);
    return NextResponse.json({ error: "Approval transaction retrieval is disabled." }, { status: 503 });
  }
}
