"use client";

import { useState } from "react";

export type ExecutionMode = "MANUAL" | "AUTONOMOUS";

export type ExecutionModePolicyToggleProps = {
  initialMode?: ExecutionMode;
  initialMaxPerRun?: string;
  initialRollingLimit?: string;
  onChange?: (policy: {
    executionMode: ExecutionMode;
    maxPerRun: string;
    rollingLimit: string;
  }) => void;
};

const fieldClass = "wolv-glass-control min-h-11 w-full rounded-xl px-3 text-sm font-semibold tabular-nums text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-[#d9a80a]/60 focus:ring-1 focus:ring-[#d9a80a]/25";

export default function ExecutionModePolicyToggle({
  initialMode = "MANUAL",
  initialMaxPerRun = "50",
  initialRollingLimit = "500",
  onChange,
}: ExecutionModePolicyToggleProps) {
  const [mode, setMode] = useState<ExecutionMode>(initialMode);
  const [maxPerRun, setMaxPerRun] = useState(initialMaxPerRun);
  const [rollingLimit, setRollingLimit] = useState(initialRollingLimit);

  function updatePolicy(next: Partial<{
    executionMode: ExecutionMode;
    maxPerRun: string;
    rollingLimit: string;
  }>) {
    const policy = {
      executionMode: next.executionMode ?? mode,
      maxPerRun: next.maxPerRun ?? maxPerRun,
      rollingLimit: next.rollingLimit ?? rollingLimit,
    };
    onChange?.(policy);
  }

  function selectMode(nextMode: ExecutionMode) {
    setMode(nextMode);
    updatePolicy({ executionMode: nextMode });
  }

  function updateMaxPerRun(value: string) {
    setMaxPerRun(value);
    updatePolicy({ maxPerRun: value });
  }

  function updateRollingLimit(value: string) {
    setRollingLimit(value);
    updatePolicy({ rollingLimit: value });
  }

  return (
    <section
      aria-labelledby="execution-policy-title"
      className="wolv-glass relative isolate overflow-hidden rounded-2xl p-5 shadow-[0_24px_70px_rgba(0,0,0,.32)] sm:p-6"
    >
      <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-24 -z-10 size-64 rounded-full bg-[#d9a80a]/[0.07] blur-3xl" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#d9a80a]">Execution policy · v8 / v9</p>
          <h2 id="execution-policy-title" className="mt-2 text-lg font-black tracking-tight text-white sm:text-xl">
            Dual-layer execution
          </h2>
          <p className="mt-1 max-w-lg text-xs leading-5 text-slate-400">
            Set the review mode and exposure limits. These controls are a local policy preview; no execution is initiated here.
          </p>
        </div>
        <span className="rounded-full border border-white/[0.09] bg-black/20 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.13em] text-slate-500">
          BSC · 56
        </span>
      </div>

      <div
        aria-label="Execution mode"
        className="relative mt-5 grid grid-cols-2 rounded-xl border border-white/10 bg-white/[0.035] p-1.5 backdrop-blur-lg"
        role="group"
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute bottom-1.5 top-1.5 w-[calc(50%-0.375rem)] rounded-lg bg-gradient-to-br from-[#d9a80a]/55 via-white/20 to-sky-300/40 p-px shadow-[0_0_24px_rgba(217,168,10,.12)] transition-transform duration-300 ease-out motion-reduce:transition-none ${
            mode === "AUTONOMOUS" ? "translate-x-full" : "translate-x-0"
          }`}
        >
          <span className="block size-full rounded-[7px] border border-white/[0.08] bg-gradient-to-br from-white/[0.12] via-white/[0.055] to-[#d9a80a]/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,.1)]" />
        </span>
        <button
          aria-pressed={mode === "MANUAL"}
          className={`relative z-10 flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold transition-colors ${
            mode === "MANUAL" ? "text-white" : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => selectMode("MANUAL")}
          type="button"
        >
          <span className={`size-1.5 rounded-full ${mode === "MANUAL" ? "bg-[#f2c94c] shadow-[0_0_10px_rgba(217,168,10,.8)]" : "bg-slate-600"}`} />
          Manual
        </button>
        <button
          aria-pressed={mode === "AUTONOMOUS"}
          className={`relative z-10 flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold transition-colors ${
            mode === "AUTONOMOUS" ? "text-white" : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => selectMode("AUTONOMOUS")}
          type="button"
        >
          <span className={`size-1.5 rounded-full ${mode === "AUTONOMOUS" ? "bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,.8)]" : "bg-slate-600"}`} />
          Autonomous Agent
        </button>
      </div>

      {mode === "AUTONOMOUS" && (
        <div id="autonomous-policy-fields" className="mt-5 grid gap-3 animate-[home-reveal_.25s_ease-out_both] sm:grid-cols-2">
          <label className="group rounded-xl border border-white/[0.07] bg-black/20 p-3.5 transition hover:border-[#d9a80a]/25 hover:bg-white/[0.035]">
            <span className="flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
              Max per-run exposure
              <span className="text-[#d9a80a]/70">USDT</span>
            </span>
            <span className="mt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">$</span>
              <input
                aria-label="Maximum per-run exposure in USDT"
                className={fieldClass}
                inputMode="decimal"
                min="0"
                onChange={(event) => updateMaxPerRun(event.target.value)}
                placeholder="50.00"
                step="any"
                type="number"
                value={maxPerRun}
              />
            </span>
          </label>
          <label className="group rounded-xl border border-white/[0.07] bg-black/20 p-3.5 transition hover:border-[#d9a80a]/25 hover:bg-white/[0.035]">
            <span className="flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
              Rolling exposure limit
              <span className="text-[#d9a80a]/70">USDT</span>
            </span>
            <span className="mt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">$</span>
              <input
                aria-label="Rolling exposure limit in USDT"
                className={fieldClass}
                inputMode="decimal"
                min="0"
                onChange={(event) => updateRollingLimit(event.target.value)}
                placeholder="500.00"
                step="any"
                type="number"
                value={rollingLimit}
              />
            </span>
          </label>
        </div>
      )}

      <div className={`mt-4 flex items-start gap-2.5 rounded-xl border p-3 text-[10px] leading-5 ${
        mode === "AUTONOMOUS"
          ? "border-sky-300/15 bg-sky-300/[0.04] text-sky-100/70"
          : "border-white/[0.07] bg-white/[0.025] text-slate-400"
      }`}>
        <span aria-hidden="true" className="mt-0.5 text-[#d9a80a]">◇</span>
        {mode === "AUTONOMOUS"
          ? "Autonomous mode is a policy preview only. Live signing and submission remain blocked until a scoped delegated policy and supported execution adapter are verified."
          : "Manual mode prepares user-reviewed proposals. Your connected wallet remains responsible for transaction signing."}
      </div>
    </section>
  );
}
