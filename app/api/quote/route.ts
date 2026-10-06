import { NextResponse } from "next/server";
import { getAggregatorQuote } from "@/lib/binance";
import { EVM_ADDRESS_PATTERN, isPositiveUint256, MINIMUM_ORDER_USDT, MINIMUM_ORDER_WEI } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { createQuoteBinding } from "@/lib/quoteBinding";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const toToken = searchParams.get("toToken");
    const amount = searchParams.get("amount");
    const userWalletAddress = searchParams.get("userWalletAddress");

    if (!toToken || !amount || !userWalletAddress) {
      return NextResponse.json(
        { error: "Missing required parameters: toToken, amount, userWalletAddress" },
        { status: 400 }
      );
    }

    if (!EVM_ADDRESS_PATTERN.test(toToken) || !EVM_ADDRESS_PATTERN.test(userWalletAddress) || !isPositiveUint256(amount)) {
      return NextResponse.json({ error: "Invalid token, wallet, or amount" }, { status: 400 });
    }

    if (BigInt(amount) < MINIMUM_ORDER_WEI) {
      return NextResponse.json({ error: `Minimum order amount is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).` }, { status: 400 });
    }

    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Only supported spot tokenized assets can be quoted" }, { status: 400 });
    }

    // Validate that userWalletAddress is not the dead address for trading
    const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    if (userWalletAddress?.toLowerCase() === DEAD_ADDRESS.toLowerCase()) {
      return NextResponse.json(
        { error: "Cannot use dead address for real trading" },
        { status: 400 }
      );
    }

    const result = await getAggregatorQuote(toToken, amount, userWalletAddress);
    // Binance returns best-first route candidates. Keep the current best quote
    // contract intact while exposing bounded display-only metadata for the terminal.
    const rawRoutes: Record<string, unknown>[] = Array.isArray(result?.data)
      ? (result.data as unknown[]).filter(isRecord).slice(0, 8)
      : [];
    const quote = rawRoutes[0] ?? null;
    if (!quote) {
      return NextResponse.json(
        { error: "No quote returned from aggregator" },
        { status: 502 }
      );
    }
    const rawQuoteId = typeof quote.quoteId === "string"
      ? quote.quoteId
      : typeof quote.orderId === "string" ? quote.orderId : null;
    if (!rawQuoteId) {
      return NextResponse.json({ error: "Quote response is missing a quote ID" }, { status: 502 });
    }
    const quoteFetchedAt = Date.now();
    const approveTarget = typeof quote.approveTarget === "string" && EVM_ADDRESS_PATTERN.test(quote.approveTarget)
      ? quote.approveTarget
      : undefined;
    const availableRoutes = rawRoutes.map((route) => {
      const fromToken = isRecord(route.fromToken) ? route.fromToken : {};
      const toToken = isRecord(route.toToken) ? route.toToken : {};
      return {
        quoteId: typeof route.quoteId === "string" ? route.quoteId : undefined,
        vendorName: typeof route.vendorName === "string" ? route.vendorName.slice(0, 80) : "Aggregator route",
        executionMode: typeof route.executionMode === "string" ? route.executionMode : "RFQ",
        fromTokenAmount: typeof route.fromTokenAmount === "string" ? route.fromTokenAmount : undefined,
        toTokenAmount: typeof route.toTokenAmount === "string" ? route.toTokenAmount : undefined,
        fromToken: {
          decimal: typeof fromToken.decimal === "string" || typeof fromToken.decimal === "number" ? fromToken.decimal : undefined,
          tokenUnitPrice: typeof fromToken.tokenUnitPrice === "string" || typeof fromToken.tokenUnitPrice === "number" ? fromToken.tokenUnitPrice : undefined,
          tokenSymbol: typeof fromToken.tokenSymbol === "string" ? fromToken.tokenSymbol.slice(0, 24) : undefined,
        },
        toToken: {
          decimal: typeof toToken.decimal === "string" || typeof toToken.decimal === "number" ? toToken.decimal : undefined,
          tokenUnitPrice: typeof toToken.tokenUnitPrice === "string" || typeof toToken.tokenUnitPrice === "number" ? toToken.tokenUnitPrice : undefined,
          tokenSymbol: typeof toToken.tokenSymbol === "string" ? toToken.tokenSymbol.slice(0, 24) : undefined,
        },
        priceImpactPercent: typeof route.priceImpactPercent === "string" || typeof route.priceImpactPercent === "number" ? route.priceImpactPercent : undefined,
      };
    });
    return NextResponse.json({
      ...quote,
      availableRoutes,
      quoteFetchedAt,
      quoteBinding: createQuoteBinding({
        toToken,
        amount,
        wallet: userWalletAddress,
        quoteId: rawQuoteId,
        approveTarget,
      }, quoteFetchedAt),
    });
  } catch (error: unknown) {
    console.error("Error in quote API:", error);
    const message = error instanceof Error ? error.message : "";
    if (/API error 40375:/i.test(message)) {
      return NextResponse.json({ error: `Minimum order amount is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).` }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Quote service is temporarily unavailable" },
      { status: 502 }
    );
  }
}
