import { NextResponse } from "next/server";

type StatusTelemetry = {
  executionMode: string;
  agentIdentity: {
    standard: string;
    registrationId: number | null;
    status: string;
  };
  commerce: {
    standard: string;
    jobId: string | null;
    status: string;
  };
  sessionKey: {
    status: string;
    reason: string;
    expiresAt?: number;
  };
  x402: {
    status: string;
    reason: string;
  };
  walletProviders: {
    altana: { sdkAvailable: boolean; configured: boolean };
    twak: { sdkAvailable: boolean; configured: boolean };
  };
  recentTransactions: string[];
};

type VolumeStats = {
  totalVolume7d: number; // in BNB
  cap: number; // 1.0 BNB
  remaining: number; // in BNB
  utilizationPercent: number;
  perTradeLimit: number; // 0.5 BNB
  maxPerTradeRemaining: number; // in BNB
};

type ExecutionLogEntry = {
  id: string;
  timestamp: number;
  type: "trade_attempt" | "slippage_check" | "user_op" | "session_key";
  status: "success" | "failed" | "pending";
  details: string;
  bnbAmount?: number;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "Cache-Control": "no-store" };

const MOCK_VOLUME_7D = 0.642; // BNB
const VOLUME_CAP_7D = 1.0; // BNB
const PER_TRADE_LIMIT = 0.5; // BNB

function buildMockExecutionLogs(): ExecutionLogEntry[] {
  const now = Date.now();
  return [
    {
      id: "log-1",
      timestamp: now - 120_000,
      type: "trade_attempt",
      status: "success",
      details: "Trade executed: 0.15 BNB into AAPL tokenized stock",
      bnbAmount: 0.15,
    },
    {
      id: "log-2",
      timestamp: now - 210_000,
      type: "slippage_check",
      status: "success",
      details: "Slippage check passed: 0.42% within 2% tolerance",
    },
    {
      id: "log-3",
      timestamp: now - 330_000,
      type: "user_op",
      status: "pending",
      details: "UserOperation submitted for 0.25 BNB ETH token",
    },
    {
      id: "log-4",
      timestamp: now - 45_000,
      type: "session_key",
      status: "success",
      details: "Session key refreshed, valid until 2026-11-10",
    },
  ];
}

function getVolumeStats(): VolumeStats {
  const totalVolume7d = MOCK_VOLUME_7D;
  const cap = VOLUME_CAP_7D;
  const remaining = Math.max(0, cap - totalVolume7d);
  const utilizationPercent = (totalVolume7d / cap) * 100;
  const perTradeLimit = PER_TRADE_LIMIT;
  const maxPerTradeRemaining = Math.min(perTradeLimit, remaining);

  return {
    totalVolume7d,
    cap,
    remaining,
    utilizationPercent,
    perTradeLimit,
    maxPerTradeRemaining,
  };
}

export async function GET() {
  try {
    // Attempt to fetch live telemetry from the agent execute endpoint
    // This mirrors the structure already established in /api/agent
    let telemetry: StatusTelemetry;

    try {
      const resp = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/agent`, {
        cache: "no-store",
      });
      if (!resp.ok) throw new Error("Unresponsive");
      const data = await resp.json();
      telemetry = data as StatusTelemetry;
    } catch {
      // Fallback to mock telemetry if RPC/agent is unresponsive
      telemetry = {
        executionMode: "wallet-confirmation",
        agentIdentity: { standard: "ERC-8004", registrationId: null, status: "not-registered" },
        commerce: { standard: "ERC-8183", jobId: null, status: "disabled" },
        sessionKey: {
          status: "checking",
          reason: "Agent status could not be verified; using cached state.",
          expiresAt: Date.now() + 30_000,
        },
        x402: { status: "disabled", reason: "No autonomous commerce job is created in wallet-confirmation mode." },
        walletProviders: {
          altana: { sdkAvailable: true, configured: false },
          twak: { sdkAvailable: true, configured: false },
        },
        recentTransactions: [],
      };
    }

    const volumeStats = getVolumeStats();
    const executionLogs = buildMockExecutionLogs();

    return NextResponse.json(
      {
        telemetry,
        volume: volumeStats,
        executionLogs,
        checkedAt: Date.now(),
      },
      { headers: responseHeaders }
    );
  } catch (error) {
    // Ultimate fallback: return all mock values when even the mock infrastructure fails
    console.error("Agent status endpoint error:", error);

    return NextResponse.json(
      {
        telemetry: {
          executionMode: "wallet-confirmation",
          agentIdentity: { standard: "ERC-8004", registrationId: null, status: "not-registered" },
          commerce: { standard: "ERC-8183", jobId: null, status: "disabled" },
          sessionKey: {
            status: "error",
            reason: "Agent status unavailable; using fallback values.",
            expiresAt: Date.now() + 60_000,
          },
          x402: { status: "disabled", reason: "No autonomous commerce job is created in wallet-confirmation mode." },
          walletProviders: {
            altana: { sdkAvailable: true, configured: false },
            twak: { sdkAvailable: true, configured: false },
          },
          recentTransactions: [],
        },
        volume: {
          totalVolume7d: MOCK_VOLUME_7D,
          cap: VOLUME_CAP_7D,
          remaining: VOLUME_CAP_7D - MOCK_VOLUME_7D,
          utilizationPercent: (MOCK_VOLUME_7D / VOLUME_CAP_7D) * 100,
          perTradeLimit: PER_TRADE_LIMIT,
          maxPerTradeRemaining: Math.min(PER_TRADE_LIMIT, VOLUME_CAP_7D - MOCK_VOLUME_7D),
        },
        executionLogs: buildMockExecutionLogs(),
        checkedAt: Date.now(),
        fallback: true,
      },
      { headers: responseHeaders }
    );
  }
}