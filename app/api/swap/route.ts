import { NextResponse } from "next/server";
import { getAggregatorSwap } from "@/lib/binance";
import { EVM_ADDRESS_PATTERN, isPositiveUint256, isSafeOrderId } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { verifyQuoteBinding } from "@/lib/quoteBinding";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const toToken = searchParams.get("toToken");
    const amount = searchParams.get("amount");
    const userWalletAddress = searchParams.get("userWalletAddress");
    const quoteId = searchParams.get("quoteId");
    const quoteBinding = searchParams.get("quoteBinding");

    if (!toToken || !amount || !userWalletAddress || !quoteId || !quoteBinding) {
      return NextResponse.json(
        { error: "Missing required parameters: toToken, amount, userWalletAddress, quoteId, quoteBinding" },
        { status: 400 }
      );
    }

    if (!EVM_ADDRESS_PATTERN.test(toToken) || !EVM_ADDRESS_PATTERN.test(userWalletAddress) || !isPositiveUint256(amount) || !isSafeOrderId(quoteId)) {
      return NextResponse.json({ error: "Invalid token, wallet, amount, or quote ID" }, { status: 400 });
    }

    const binding = verifyQuoteBinding(quoteBinding, { toToken, amount, wallet: userWalletAddress, quoteId });
    if (!binding.ok) {
      return NextResponse.json({ error: binding.reason }, { status: 409 });
    }

    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Only supported spot tokenized assets can be swapped" }, { status: 400 });
    }

    // Validate that userWalletAddress is not the dead address for trading
    const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    if (userWalletAddress?.toLowerCase() === DEAD_ADDRESS.toLowerCase()) {
      return NextResponse.json(
        { error: "Cannot use dead address for real trading" },
        { status: 400 }
      );
    }

    const result = await getAggregatorSwap(toToken, amount, userWalletAddress, quoteId);
    const resultData = (result as { data?: unknown }).data;
    if (resultData && typeof resultData === "object" && !Array.isArray(resultData)) {
      const executionMode = "executionMode" in resultData ? (resultData as { executionMode?: unknown }).executionMode : undefined;
      const tx = "tx" in resultData ? (resultData as { tx?: unknown }).tx : undefined;
      if (executionMode === "SWAP" && binding.approveTarget) {
        const destination = tx && typeof tx === "object" && "to" in tx ? (tx as { to?: unknown }).to : undefined;
        if (typeof destination !== "string" || !EVM_ADDRESS_PATTERN.test(destination) || destination.toLowerCase() !== binding.approveTarget.toLowerCase()) {
          return NextResponse.json({ error: "Swap destination does not match the quoted Binance route" }, { status: 409 });
        }
      }
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Error in swap API:", error);
    return NextResponse.json(
      { error: "Swap service is temporarily unavailable" },
      { status: 502 }
    );
  }
}
