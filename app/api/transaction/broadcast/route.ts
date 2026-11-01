import { NextResponse } from "next/server";
import { EVM_ADDRESS_PATTERN } from "@/lib/apiValidation";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid transaction broadcast request" }, { status: 400 });
    }

    const { address, signedTransaction } = body;
    if (
      typeof address !== "string" || !EVM_ADDRESS_PATTERN.test(address) ||
      typeof signedTransaction !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(signedTransaction)
    ) {
      return NextResponse.json({ error: "Invalid wallet address or signed transaction" }, { status: 400 });
    }

    return NextResponse.json({
      error: "Direct transaction broadcast is disabled until the SWAP transaction intent and recovery formats are verified.",
      code: "UNSUPPORTED_SWAP_SCHEMA",
    }, { status: 501 });
  } catch (error) {
    console.error("Binance transaction broadcast failed:", error);
    return NextResponse.json({ error: "Transaction broadcast is temporarily unavailable" }, { status: 502 });
  }
}