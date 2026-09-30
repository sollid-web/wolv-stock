import { NextResponse } from "next/server";
import { normalizeUint256, EVM_ADDRESS_PATTERN } from "@/lib/apiValidation";
import { simulateBscTransaction } from "@/lib/binance";

export const dynamic = "force-dynamic";

const DATA_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;

type SimulationResponse = {
  data?: {
    status?: unknown;
    failReason?: unknown;
    balanceChanges?: unknown;
    allowanceChanges?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid transaction simulation request" }, { status: 400 });
    }

    const { from, to, data } = body;
    const rawValue = body.value == null ? "0" : String(body.value);
    const value = normalizeUint256(rawValue);
    if (
      typeof from !== "string" || !EVM_ADDRESS_PATTERN.test(from) ||
      typeof to !== "string" || !EVM_ADDRESS_PATTERN.test(to) ||
      typeof data !== "string" || data.length > 200_000 || !DATA_PATTERN.test(data) ||
      value === null
    ) {
      return NextResponse.json({ error: "Invalid transaction simulation request" }, { status: 400 });
    }

    const response = await simulateBscTransaction(from, to, data, value) as SimulationResponse;
    const simulation = response.data;
    if (!simulation || typeof simulation.status !== "string") {
      return NextResponse.json({ error: "Simulation service returned an invalid response" }, { status: 502 });
    }

    return NextResponse.json({
      status: simulation.status,
      failReason: typeof simulation.failReason === "string" ? simulation.failReason : null,
      balanceChanges: Array.isArray(simulation.balanceChanges) ? simulation.balanceChanges : [],
      allowanceChanges: Array.isArray(simulation.allowanceChanges) ? simulation.allowanceChanges : [],
    });
  } catch (error) {
    console.error("Transaction simulation failed:", error);
    return NextResponse.json({ error: "Transaction preflight is temporarily unavailable" }, { status: 502 });
  }
}