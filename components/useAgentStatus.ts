"use client";

import { useEffect, useState } from "react";
import type { AgentPublicStatus } from "@/lib/agentPublicStatus";

export type AgentStatusResponse = AgentPublicStatus & { chainId: number };

const POLL_MS = 15_000;

/** Polls the public, owner-free agent status. Returns null until the first response. */
export function useAgentStatus(): { status: AgentStatusResponse | null; error: boolean } {
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/agent/status", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as AgentStatusResponse;
        if (!cancelled) { setStatus(data); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return { status, error };
}

export const STATE_STYLE: Record<string, { label: string; dot: string; text: string; ring: string; live: boolean }> = {
  MONITORING: { label: "Monitoring", dot: "bg-emerald-400", text: "text-emerald-300", ring: "border-emerald-400/30 bg-emerald-400/[0.06]", live: true },
  EVALUATING: { label: "Evaluating", dot: "bg-[#f2c94c]", text: "text-[#f2c94c]", ring: "border-[#d9a80a]/40 bg-[#d9a80a]/[0.08]", live: true },
  SUBMITTED: { label: "Submitted", dot: "bg-[#f2c94c]", text: "text-[#f2c94c]", ring: "border-[#d9a80a]/40 bg-[#d9a80a]/[0.08]", live: true },
  CONFIRMED: { label: "Trade confirmed", dot: "bg-emerald-400", text: "text-emerald-300", ring: "border-emerald-400/30 bg-emerald-400/[0.06]", live: false },
  FAILED: { label: "Attempt failed", dot: "bg-rose-400", text: "text-rose-300", ring: "border-rose-400/30 bg-rose-400/[0.06]", live: false },
  PAUSED: { label: "Paused", dot: "bg-amber-400", text: "text-amber-200", ring: "border-amber-400/30 bg-amber-400/[0.06]", live: false },
  IDLE: { label: "Idle", dot: "bg-slate-400", text: "text-slate-300", ring: "border-white/[0.1] bg-white/[0.03]", live: false },
  OFFLINE: { label: "Offline", dot: "bg-slate-500", text: "text-slate-400", ring: "border-white/[0.1] bg-white/[0.03]", live: false },
};
