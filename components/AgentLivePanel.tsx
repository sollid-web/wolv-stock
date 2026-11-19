"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEther, formatUnits } from "viem";
import { STATE_STYLE, useAgentStatus, type AgentStatusResponse } from "@/components/useAgentStatus";

const STAGES = [
  { key: "monitor", title: "Monitor", body: "Reads the Chainlink price and pool reserves every cycle." },
  { key: "evaluate", title: "Evaluate", body: "Compares the price with the owner's entry threshold." },
  { key: "policy", title: "Risk & policy", body: "Checks cap, slippage, impact and the signed policy." },
  { key: "submit", title: "Submit", body: "Signs a bounded intent and sends a UserOperation." },
  { key: "verify", title: "Verify", body: "Confirms the hook event and token delivery on-chain." },
] as const;

/** Index of the stage the agent is really at, or -1 when it is not running. */
function activeStage(status: AgentStatusResponse): number {
  switch (status.state) {
    case "MONITORING": return 1;
    case "EVALUATING": return 2;
    case "SUBMITTED": return 3;
    case "CONFIRMED": return 4;
    case "FAILED": return 3;
    default: return -1;
  }
}

function explorerTx(chainId: number, hash: string) {
  return `${chainId === 56 ? "https://bscscan.com" : "https://testnet.bscscan.com"}/tx/${hash}`;
}

function ago(timestamp: number | null, now: number): string {
  if (timestamp === null) return "—";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function usd(value: number | null) {
  return value === null ? "—" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Live, public view of the autonomous agent built only from persisted state (/api/agent/status).
 * `variant="compact"` is used on the homepage; `"full"` at the top of /agent.
 */
export default function AgentLivePanel({ variant = "full" }: { variant?: "full" | "compact" }) {
  const { status, error } = useAgentStatus();
  const now = useNow();

  if (!status) {
    return (
      <section className="wolv-glass rounded-2xl p-5 sm:p-6" aria-busy={!error}>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#d9a80a]">Autonomous agent · live</p>
        <p className="mt-3 text-sm text-slate-400">{error ? "Agent status is temporarily unavailable." : "Loading live agent status…"}</p>
      </section>
    );
  }

  const style = STATE_STYLE[status.state] ?? STATE_STYLE.OFFLINE;
  const stage = activeStage(status);
  const confirmed = status.recentExecutions.filter((item) => item.status === "CONFIRMED" && item.transactionHash);
  const latest = confirmed[0] ?? null;
  const strategy = status.strategy;
  const nextRunIn = strategy?.nextRunAt ? Math.max(0, Math.round((strategy.nextRunAt - now) / 1000)) : null;
  const network = status.chainId === 56 ? "BSC Mainnet" : "BSC Testnet";

  return (
    <section aria-labelledby="agent-live-title" className="relative overflow-hidden rounded-2xl border border-[#d9a80a]/20 bg-gradient-to-br from-[#0e1016] via-[#0b1017] to-[#130f06] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-7">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#d9a80a]/45 to-transparent" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#d9a80a]">Autonomous agent · live · {network}</p>
          <h2 id="agent-live-title" className="mt-2 text-xl font-black tracking-tight text-white sm:text-2xl">{status.headline}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-300">{status.detail}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold ${style.ring} ${style.text}`}>
          <span className="relative flex size-2">
            {style.live && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${style.dot}`} />}
            <span className={`relative inline-flex size-2 rounded-full ${style.dot}`} />
          </span>
          {style.label}
        </span>
      </div>

      <ol className="relative mt-6 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Agent decision pipeline">
        {STAGES.map((item, index) => {
          const done = stage > index || (status.state === "CONFIRMED" && index <= 4);
          const current = stage === index && status.state !== "CONFIRMED";
          const failed = status.state === "FAILED" && index === stage;
          return (
            <li key={item.key} className={`rounded-xl border p-3 transition ${
              failed ? "border-rose-400/35 bg-rose-400/[0.05]"
                : current ? "border-[#d9a80a]/45 bg-[#d9a80a]/[0.08] shadow-[0_0_24px_rgba(217,168,10,0.12)]"
                  : done ? "border-emerald-400/20 bg-emerald-400/[0.04]"
                    : "border-white/[0.06] bg-black/20"
            } ${index === 4 ? "col-span-2 sm:col-span-1" : ""}`} aria-current={current ? "step" : undefined}>
              <div className="flex items-center gap-2">
                <span className={`grid size-5 place-items-center rounded-full text-[10px] font-black ${
                  failed ? "bg-rose-400/20 text-rose-200" : current ? "bg-[#d9a80a] text-[#111]" : done ? "bg-emerald-400/20 text-emerald-200" : "bg-white/[0.06] text-slate-500"
                }`}>{failed ? "!" : done ? "✓" : index + 1}</span>
                <span className={`text-xs font-bold ${current ? "text-[#f2c94c]" : done ? "text-emerald-200" : stage < 0 ? "text-slate-500" : "text-slate-300"}`}>{item.title}</span>
              </div>
              {variant === "full" && <p className="mt-2 text-[11px] leading-4 text-slate-500">{item.body}</p>}
            </li>
          );
        })}
      </ol>

      <div className={`relative mt-5 grid gap-3 ${variant === "full" ? "lg:grid-cols-3" : "md:grid-cols-3"}`}>
        <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last decision</div>
          <div className="mt-1 text-sm font-bold text-white">{strategy?.lastDecisionLabel ?? "No evaluation recorded yet"}</div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-400">
            {strategy?.priceUsd !== null && strategy?.priceUsd !== undefined && <span>Observed {usd(strategy.priceUsd)}</span>}
            {strategy?.entryUsd !== null && strategy?.entryUsd !== undefined && <span>Entry ≤ {usd(strategy.entryUsd)}</span>}
            <span>{strategy?.lastEvaluatedAt ? ago(strategy.lastEvaluatedAt, now) : ""}</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Strategy</div>
          <div className="mt-1 truncate text-sm font-bold text-white">{strategy?.name ?? "None enabled"}</div>
          <div className="mt-2 text-xs tabular-nums text-slate-400">
            {strategy
              ? status.state === "PAUSED" || status.state === "OFFLINE"
                ? `Every ${strategy.intervalSeconds}s when released`
                : nextRunIn !== null ? `Next cycle in ${nextRunIn}s · every ${strategy.intervalSeconds}s` : `Every ${strategy.intervalSeconds}s`
              : "Configure one from the command center"}
          </div>
        </div>
        <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Verified autonomous trades</div>
          <div className="mt-1 text-2xl font-black tabular-nums text-[#f2c94c]">{status.totals.confirmed}</div>
          <div className="mt-1 text-xs text-slate-400">
            {status.totals.failed > 0 ? `${status.totals.failed} rejected safely · ` : ""}worker seen {status.workerLastSeenAgoSeconds === null ? "never" : `${status.workerLastSeenAgoSeconds}s ago`}
          </div>
        </div>
      </div>

      {variant === "full" && confirmed.length > 0 && (
        <div className="relative mt-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Latest verified executions</h3>
          <ul className="mt-2 divide-y divide-white/[0.06] rounded-xl border border-white/[0.07] bg-black/20">
            {confirmed.slice(0, 5).map((item) => (
              <li key={item.transactionHash} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
                <span className="tabular-nums text-slate-400">{ago(item.settledAt ?? item.createdAt, now)}</span>
                <span className="tabular-nums text-slate-200">
                  {item.amountIn ? `${formatEther(BigInt(item.amountIn))} BNB` : ""}
                  {item.receivedAmount ? ` → ${Number(formatUnits(BigInt(item.receivedAmount), 18)).toFixed(6)} ETH` : ""}
                </span>
                <a href={explorerTx(status.chainId, item.transactionHash!)} target="_blank" rel="noreferrer" className="font-mono text-[#d9a80a] underline decoration-[#d9a80a]/40 underline-offset-2 hover:text-[#f2c94c]">
                  {item.transactionHash!.slice(0, 10)}…{item.transactionHash!.slice(-6)} ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative mt-5 flex flex-wrap items-center gap-3">
        {variant === "compact" ? (
          <Link href="/agent" className="inline-flex min-h-10 items-center rounded-lg bg-[#d9a80a] px-4 text-xs font-black text-[#111] transition hover:bg-[#f2c94c]">
            Open agent command center <span aria-hidden="true" className="ml-2">→</span>
          </Link>
        ) : null}
        {latest?.transactionHash && (
          <a href={explorerTx(status.chainId, latest.transactionHash)} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-lg border border-white/[0.12] px-4 text-xs font-bold text-slate-200 transition hover:border-[#d9a80a]/40 hover:text-[#f2c94c]">
            Inspect latest on-chain trade ↗
          </a>
        )}
        <span className="text-[11px] text-slate-500">Status is read from the worker&apos;s persisted records; nothing here is simulated.</span>
      </div>
    </section>
  );
}
