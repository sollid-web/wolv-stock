"use client";

import { useEffect, useState } from "react";

interface VolumeStats {
  totalVolume7d: number;
  cap: number;
  remaining: number;
  utilizationPercent: number;
  perTradeLimit: number;
  maxPerTradeRemaining: number;
}

interface SessionKey {
  status: string;
  reason: string;
  expiresAt?: number;
}

interface ExecutionLogEntry {
  id: string;
  timestamp: number;
  type: "trade_attempt" | "slippage_check" | "user_op" | "session_key";
  status: "success" | "failed" | "pending";
  details: string;
  bnbAmount?: number;
}

interface AgentStatusResponse {
  telemetry: {
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
    sessionKey: SessionKey;
    x402: { status: string; reason: string };
    walletProviders: {
      altana: { sdkAvailable: boolean; configured: boolean };
      twak: { sdkAvailable: boolean; configured: boolean };
    };
    recentTransactions: string[];
  };
  volume: VolumeStats;
  executionLogs: ExecutionLogEntry[];
  checkedAt: number;
  fallback?: boolean;
}

type AgentStatus =
  | "running"
  | "paused"
  | "circuit_breaker";

function computeAgentStatus(
  telemetry: NonNullable<AgentStatusResponse["telemetry"]>,
  volume: VolumeStats
): AgentStatus {
  // Circuit breaker active when rolling volume hits the 7-day cap
  if (volume.remaining <= 0 || volume.utilizationPercent >= 100) return "circuit_breaker";
  // Paused when agent identity or commerce is disabled/not registered
  if (
    telemetry.agentIdentity.status !== "registered" ||
    telemetry.commerce.status === "disabled"
  ) {
    return "paused";
  }
  return "running";
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "circuit_breaker":
      return "Circuit Breaker Active";
    default:
      return "Unknown";
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBnb(amount: number): string {
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} BNB`;
}

function typeIcon(type: ExecutionLogEntry["type"]): string {
  switch (type) {
    case "trade_attempt":
      return "trade";
    case "slippage_check":
      return "slip";
    case "user_op":
      return "op";
    case "session_key":
      return "key";
  }
}

function statusColor(status: ExecutionLogEntry["status"]): string {
  switch (status) {
    case "success":
      return "text-[#4ade80]";
    case "failed":
      return "text-[#f87171]";
    case "pending":
      return "text-[#fbbf24]";
  }
}

export default function AgentDashboard() {
  const [data, setData] = useState<AgentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/agent/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Agent status could not be loaded.");
        return response.json();
      })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Agent status could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);

  const telemetry = data?.telemetry;
  const volume = data?.volume;
  const executionLogs = data?.executionLogs ?? [];
  const agentStatus = (telemetry && volume ? computeAgentStatus(telemetry, volume) : null);

  const isRunning = agentStatus === "running";
  const isPaused = agentStatus === "paused";
  const isCircuitBreaker = agentStatus === "circuit_breaker";
  const sessionKey = telemetry?.sessionKey;
  const sessionExpiry = sessionKey?.expiresAt ? new Date(sessionKey.expiresAt).toLocaleDateString() : "—";

  const volumePercent = volume
    ? Math.min(100, Math.max(0, volume.utilizationPercent))
    : 0;

  return (
    <section className="wolv-glass rounded-2xl p-5 mb-8 border border-[#FFC700]/10 shadow-[0_0_40px_rgba(217,168,10,.08)]">
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
        <div>
          <p className="mb-1 inline-flex items-center gap-2 rounded-full border border-[#FFC700]/25 bg-[#FFC700]/[0.06] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#FFC700]">
            <span className="size-1.5 rounded-full bg-[#FFC700]" />
            Agent status · BNB Smart Chain
          </p>
          <h2 className="text-lg font-black tracking-tight text-white sm:text-xl">Autonomous agent guardrails</h2>
        </div>

        <div className="flex items-center gap-2.5">
          <span
            className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[10px] font-bold transition
              ${isRunning
                ? "bg-emerald-500/[0.08] border border-emerald-500/20 text-emerald-300 shadow-[0_0_12px_rgba(34,197,94,.12)]"
                : isPaused
                ? "bg-amber-500/[0.08] border border-amber-500/20 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,.12)]"
                : "bg-rose-500/[0.08] border border-rose-500/20 text-rose-300 shadow-[0_0_12px_rgba(248,113,113,.12)]"}
            `}
            title={statusLabel(agentStatus ?? "paused")}
          >
            <span
              className="h-1.5 w-1.5 rounded-full bg-current animate-pulse"
              aria-hidden="true"
            />
            {statusLabel(agentStatus ?? "paused")}
          </span>
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">
          {error}
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {/* Rolling Volume Guardrail */}
        <section className="wolv-glass-control rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Rolling volume (7-day)</p>
            <p className="text-xs font-semibold text-[#FFC700]">
              {volume ? formatBnb(volume.totalVolume7d) : "—"}
            </p>
          </div>
          <div className="w-full bg-white/[0.05] rounded-full h-2 overflow-hidden border border-white/[0.08] mb-2">
            <div
              className="h-full bg-gradient-to-r from-[#FFC700] to-[#d9a80a] transition-all duration-500"
              style={{ width: `${volumePercent}%` }}
              role="progressbar"
              aria-valuenow={volume ? Math.round(volume.utilizationPercent) : 0}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <div className="flex justify-between text-[10px] text-slate-400">
            <span>0 BNB used</span>
            <span>{volume ? volume.totalVolume7d.toFixed(3) : "—"} / {volume ? volume.cap.toFixed(1) : "—"} BNB cap</span>
            <span>{volume ? volume.remaining.toFixed(3) : "—"} remaining</span>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Per-trade limit: {volume ? formatBnb(volume.perTradeLimit) : "—"} · Max executable this cycle:
            {volume ? formatBnb(volume.maxPerTradeRemaining) : "—"}
          </p>
        </section>

        {/* Agent Status */}
        <section className="wolv-glass-control rounded-xl p-4 flex flex-col justify-between">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Agent status</p>
            <p className="text-sm font-bold text-white">{statusLabel(agentStatus ?? "paused")}</p>
            <p className="mt-1 text-xs text-slate-400">{telemetry?.executionMode ?? "—"}</p>
          </div>
          <div className="mt-4 rounded-lg border border-white/[0.06] bg-black/30 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Session key</p>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-slate-500">Status</dt>
                <dd className={`text-right font-semibold ${sessionKey?.status === "enabled" ? "text-emerald-400" : "text-slate-400"}`}>
                  {sessionKey?.status ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Expires</dt>
                <dd className="text-right font-mono text-[10px] text-slate-300">{sessionExpiry}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">x402 settlement</dt>
                <dd className="text-right font-semibold text-slate-400">
                  {telemetry?.x402.status ?? "—"}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Session providers */}
        <section className="wolv-glass-control rounded-xl p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Session providers</p>
          <dl className="space-y-1.5 text-xs">
            {Object.entries(telemetry?.walletProviders ?? {}).map(([name, provider]) => (
              <div key={name} className="flex items-start justify-between gap-3 border-b border-white/[0.05] pb-2 last:border-0 last:pb-0">
                <dt className="text-slate-400">{name === "altana" ? "Altana" : "TWAK"}</dt>
                <dd className="flex items-center gap-2 text-right text-slate-300">
                  <span
                    className={`inline-flex h-3 w-3 rounded-full ${
                      provider.sdkAvailable && provider.configured ? "bg-emerald-500" : "bg-slate-700"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="text-[10px] font-mono">
                    {provider.sdkAvailable && provider.configured ? "configured" : provider.sdkAvailable ? "available" : "unavailable"}
                  </span>
                </dd>
              </div>
            ))}
            <p className="mt-3 text-[10px] leading-5 text-slate-400">
              Providers are not configured to sign from this route — every trade still requires wallet confirmation.
            </p>
          </dl>
        </section>
      </div>

      {/* Execution Logs */}
      <section className="wolv-glass-control rounded-xl mt-4 border border-[#FFC700]/10">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3 mb-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Execution log</p>
            <span className={`text-xs font-bold ${
              data?.fallback ? "text-[#FFC700]" : "text-emerald-400"
            }`}>
              {data?.fallback ? "Live feed · cached state" : "Live feed"}
            </span>
          </div>
          <span className="text-[10px] text-slate-500">{data?.checkedAt ? new Date(data.checkedAt).toLocaleTimeString() : "—"}</span>
        </div>
        <div className="max-h-48 overflow-y-auto pr-2 space-y-2 sm:max-h-52 md:max-h-60">
          {executionLogs.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">No recent agent activity.</p>
          ) : (
            <ul>
              {executionLogs.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2.5 py-1 border-b border-white/[0.04] last:border-0">
                  <div className="flex shrink-0 items-center h-5 w-5 rounded-full border border-white/[0.08] bg-black/20 flex-shrink-0 justify-center text-[10px] font-bold text-[#FFC700]">
                    {typeIcon(entry.type)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-300 leading-tight">{entry.details}</p>
                    <span className={`flex items-center gap-1 text-[10px] ${statusColor(entry.status)}`}>
                      <span className="h-1 w-1 rounded-full bg-current" aria-hidden="true" />
                      {entry.type === "trade_attempt" && entry.bnbAmount != null
                        ? `${formatBnb(entry.bnbAmount)} · ${formatTime(entry.timestamp)}`
                        : formatTime(entry.timestamp)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </section>
  );
}