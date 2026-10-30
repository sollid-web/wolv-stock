import { NextResponse } from "next/server";
import { buildCapabilityTelemetry } from "@/lib/agentTelemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "Cache-Control": "no-store" };

export async function GET() {
  const telemetry = buildCapabilityTelemetry();

  return NextResponse.json(
    {
      telemetry,
      volume: null,
      executionLogs: [],
      executionLogsNote: "Live execution volume and history are unavailable because no activity store is configured.",
      checkedAt: Date.now(),
    },
    { headers: responseHeaders }
  );
}
