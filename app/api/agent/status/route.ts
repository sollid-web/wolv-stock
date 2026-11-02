import { NextResponse } from "next/server";
import { buildCapabilityTelemetry } from "@/lib/agentTelemetry";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import {
  authorizeBawWalletRequest,
  getBawWalletSession,
  isBawWalletServerTokenConfigured,
} from "@/services/bawWalletAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const authorization = await authorizeBawWalletRequest(request, token);
  if (authorization === "not_configured") {
    return NextResponse.json(
      { error: "Agent status access is not configured." },
      { status: 503, headers: responseHeaders },
    );
  }
  if (authorization === "unauthorized") {
    return NextResponse.json(
      { error: "A valid operator authorization is required." },
      { status: 401, headers: responseHeaders },
    );
  }
  if (authorization === "storage_unavailable") {
    return NextResponse.json(
      { error: "Operator authorization storage is unavailable." },
      { status: 503, headers: responseHeaders },
    );
  }

  let ownerAddress: string | null = null;
  if (isBawWalletServerTokenConfigured(token)) {
    try {
      const session = await getBawWalletSession(request, token);
      ownerAddress = session?.address ?? null;
    } catch {
      ownerAddress = null;
    }
  }

  let emergencyStopEnabled = true;
  let sessionPlans: Record<string, unknown>[] = [];
  const databaseUrl =
    process.env.WOLV_AGENT_DATABASE_URL ??
    process.env.WOLV_TRADING_DATABASE_URL;
  if (databaseUrl) {
    let store: AgentMemoryStore | null = null;
    try {
      store = new AgentMemoryStore(databaseUrl);
      await store.initialize();
      const control = await store.getControlState(Date.now());
      emergencyStopEnabled = Boolean(control.emergency_stop);
      sessionPlans = ownerAddress
        ? await store.listAgentSessionPlans(ownerAddress, 20)
        : [];
    } catch (error) {
      console.error("Global emergency-stop state could not be loaded:", error);
      emergencyStopEnabled = true;
    } finally {
      await store?.close();
    }
  }

  const telemetry = buildCapabilityTelemetry({
    ownerAddress,
    emergencyStopEnabled,
  });

  return NextResponse.json(
    {
      telemetry,
      sessionPlans,
      volume: null,
      executionLogs: [],
      executionLogsNote: "Live execution volume and history are unavailable because no activity store is configured.",
      checkedAt: Date.now(),
    },
    { headers: responseHeaders }
  );
}
