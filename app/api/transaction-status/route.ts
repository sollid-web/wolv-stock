import { NextResponse } from "next/server";
import { getTransactionDetailByTxHash } from "@/lib/binance";

export const dynamic = "force-dynamic";

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const txHash = searchParams.get("txHash");
    if (!txHash || !TX_HASH_PATTERN.test(txHash)) {
      return NextResponse.json({ error: "Invalid transaction hash" }, { status: 400 });
    }

    const result = await getTransactionDetailByTxHash("56", txHash);
    if (result.data == null) {
      return NextResponse.json({ status: "pending" });
    }
    if (!Array.isArray(result.data)) {
      return NextResponse.json({ error: "Binance returned an invalid transaction detail" }, { status: 502 });
    }
    if (result.data.length === 0) {
      return NextResponse.json({ status: "pending" });
    }

    const transaction = result.data.find((item: unknown) =>
      isRecord(item) && typeof item.txHash === "string" && item.txHash.toLowerCase() === txHash.toLowerCase()
    ) ?? result.data[0];
    if (!isRecord(transaction) || typeof transaction.txStatus !== "string") {
      return NextResponse.json({ error: "Binance returned an invalid transaction status" }, { status: 502 });
    }

    switch (transaction.txStatus.toLowerCase()) {
      case "pending":
        return NextResponse.json({ status: "pending" });
      case "success":
        return NextResponse.json({ status: "success" });
      case "fail":
        return NextResponse.json({ status: "reverted" });
      default:
        return NextResponse.json({ error: "Binance returned an unsupported transaction status" }, { status: 502 });
    }
  } catch (error) {
    console.error("Binance transaction status lookup failed:", error);
    return NextResponse.json({ error: "Transaction status is temporarily unavailable" }, { status: 502 });
  }
}