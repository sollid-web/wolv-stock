"use client";

import { useState } from "react";
import { formatUnits } from "viem";

type Check = { label: string; outcome: "pass" | "fail" | "wait" | "skipped"; detail: string };
type Result = {
  simulated: true;
  decision: string;
  decisionLabel: string;
  wouldSubmit: boolean;
  observedPriceUsd: number;
  entryPriceUsd: number;
  priceImpactBps: number | null;
  minimumOutput: string | null;
  checks: Check[];
  chainId: number;
};

const OUTCOME_STYLE: Record<Check["outcome"], { icon: string; tone: string }> = {
  pass: { icon: "✓", tone: "bg-emerald-400/15 text-emerald-200" },
  fail: { icon: "✕", tone: "bg-rose-400/15 text-rose-200" },
  wait: { icon: "…", tone: "bg-[#d9a80a]/15 text-[#f2c94c]" },
  skipped: { icon: "–", tone: "bg-white/[0.06] text-slate-500" },
};

/**
 * Lets anyone, with or without a wallet, see how the agent would decide right now. Runs the
 * production decision logic against the live testnet market; never signs or sends anything.
 */
export default function AgentSimulator() {
  const [amountBnb, setAmountBnb] = useState("0.001");
  const [entryPriceUsd, setEntryPriceUsd] = useState("1900");
  const [slippageBps, setSlippageBps] = useState("100");
  const [maxPriceImpactBps, setMaxPriceImpactBps] = useState("100");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(override?: { entryPriceUsd?: string }) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/agent/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountBnb,
          entryPriceUsd: Number(override?.entryPriceUsd ?? entryPriceUsd),
          slippageBps: Number(slippageBps),
          maxPriceImpactBps: Number(maxPriceImpactBps),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Simulation failed.");
      setResult(data as Result);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : "Simulation failed.");
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-white/[0.1] bg-black/30 px-3 py-2 text-sm tabular-nums text-white outline-none transition focus:border-[#d9a80a]/60";

  return (
    <section aria-labelledby="agent-sim-title" className="wolv-glass mt-8 rounded-2xl p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#d9a80a]">Try it without a wallet</p>
          <h2 id="agent-sim-title" className="mt-1 text-lg font-black text-white sm:text-xl">Simulate an agent decision</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
            Set a hypothetical policy and run the agent&apos;s production decision logic against the live BSC Testnet market (Chainlink price and PancakeSwap reserves).
          </p>
        </div>
        <span className="rounded-full border border-[#d9a80a]/40 bg-[#d9a80a]/[0.1] px-3 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-[#f2c94c]">Simulation</span>
      </div>

      <form className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label className="text-xs font-semibold text-slate-400">Trade size (BNB)
          <input className={input} inputMode="decimal" value={amountBnb} onChange={(event) => setAmountBnb(event.target.value)} />
        </label>
        <label className="text-xs font-semibold text-slate-400">Buy when ETH ≤ (USD)
          <input className={input} inputMode="decimal" value={entryPriceUsd} onChange={(event) => setEntryPriceUsd(event.target.value)} />
        </label>
        <label className="text-xs font-semibold text-slate-400">Max slippage (bps)
          <input className={input} inputMode="numeric" value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} />
        </label>
        <label className="text-xs font-semibold text-slate-400">Max price impact (bps)
          <input className={input} inputMode="numeric" value={maxPriceImpactBps} onChange={(event) => setMaxPriceImpactBps(event.target.value)} />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={busy} className="wolv-connect-button min-h-10 w-full rounded-lg px-4 text-sm font-black disabled:cursor-wait">
            {busy ? "Simulating…" : "Run simulation"}
          </button>
        </div>
      </form>

      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{error}</p>}

      {result && (
        <div className="mt-5 rounded-xl border border-white/[0.08] bg-black/25 p-4 sm:p-5" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Simulated decision</div>
              <div className={`mt-1 text-base font-black ${result.wouldSubmit ? "text-emerald-300" : result.decision === "TRIGGER_NOT_MET" ? "text-[#f2c94c]" : "text-rose-300"}`}>
                {result.wouldSubmit ? "Would submit a bounded trade" : result.decisionLabel}
              </div>
            </div>
            <div className="text-right text-xs tabular-nums text-slate-400">
              Live ETH ${result.observedPriceUsd.toFixed(2)} · entry ${result.entryPriceUsd.toFixed(2)}
              {result.minimumOutput && <div className="mt-1 text-slate-300">Minimum output {Number(formatUnits(BigInt(result.minimumOutput), 18)).toFixed(6)} ETH</div>}
            </div>
          </div>
          <ul className="mt-4 grid gap-2">
            {result.checks.map((check) => (
              <li key={check.label} className="flex gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-black ${OUTCOME_STYLE[check.outcome].tone}`}>{OUTCOME_STYLE[check.outcome].icon}</span>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-white">{check.label}</div>
                  <div className="text-[11px] leading-4 text-slate-400">{check.detail}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {result.decision === "TRIGGER_NOT_MET" && (
              <button type="button" disabled={busy} onClick={() => { const next = Math.ceil(result.observedPriceUsd).toString(); setEntryPriceUsd(next); void run({ entryPriceUsd: next }); }}
                className="rounded-lg border border-[#d9a80a]/35 px-3 py-2 text-xs font-bold text-[#f2c94c] transition hover:bg-[#d9a80a]/[0.1]">
                Set entry to the live price and re-run
              </button>
            )}
            <p className="text-[11px] text-slate-500">Simulation only: no wallet, signature or transaction is involved, and no profit is implied.</p>
          </div>
        </div>
      )}
    </section>
  );
}
