import { NextResponse } from "next/server";
import { submitOrder } from "@/lib/binance";
import { isSafeOrderId } from "@/lib/apiValidation";
import { EVM_ADDRESS_PATTERN } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request
) {
  try {
    const body = await request.json();
    const {
      requestId,
      userSignature,
      vendor,
      quoteId,
      toToken
    } = body;

    if (!requestId || !userSignature || !vendor || !quoteId || !toToken) {
      return NextResponse.json(
        { error: "Missing required parameters: requestId, userSignature, vendor, quoteId, toToken" },
        { status: 400 }
      );
    }

    if (typeof userSignature !== "string" || !/^0x(?:[a-fA-F0-9]{128}|[a-fA-F0-9]{130})$/.test(userSignature) ||
        typeof vendor !== "string" || vendor.length > 128 || /[\r\n]/.test(vendor) ||
        typeof quoteId !== "string" || !isSafeOrderId(quoteId) ||
        typeof toToken !== "string" || !EVM_ADDRESS_PATTERN.test(toToken)) {
      return NextResponse.json({ error: "Invalid signature, vendor, or quote ID" }, { status: 400 });
    }

    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Only supported spot tokenized assets can be submitted" }, { status: 400 });
    }

    // Basic UUID validation for requestId (should be UUID v4)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(requestId)) {
      return NextResponse.json(
        { error: "requestId must be a valid UUID v4" },
        { status: 400 }
      );
    }

    const result = await submitOrder(requestId, userSignature, vendor, quoteId);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Error in order submit API:", error);
    return NextResponse.json(
      { error: "Order service is temporarily unavailable" },
      { status: 502 }
    );
  }
}