import { NextResponse } from "next/server";
import { buildCapabilityTelemetry } from "@/lib/agentTelemetry";
import { MAX_ROLLING_VOLUME_BNB, MAX_TRADE_BNB } from "@/services/agentWorker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "Cache-Control": "no-store" };

const VOLUME_CAP_7D = Number(MAX_ROLLING_VOLUME_BNB) / 1e18;
const PER_TRADE_LIMIT = Number(MAX_TRADE_BNB) / 1e18;

export async function GET() {
  const telemetry = buildCapabilityTelemetry();

  // No execution has ever been recorded (the executor is kill-switched off and
  // no durable log store exists), so the volume ledger starts at zero.
  const volume = {
    totalVolume7d: 0,
    cap: VOLUME_CAP_7D,
    remaining: VOLUME_CAP_7D,
    utilizationPercent: 0,
    perTradeLimit: PER_TRADE_LIMIT,
    maxPerTradeRemaining: PER_TRADE_LIMIT,
  };

  return NextResponse.json(
    {
      telemetry,
      volume,
      executionLogs: [],
      executionLogsNote: "No execution log store exists yet; entries appear only after execution is enabled.",
      checkedAt: Date.now(),
    },
    { headers: responseHeaders }
  );
}
