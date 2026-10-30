"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { AgentStrategy } from "@/lib/agentStrategies";
import AgentWalletPanel from "@/components/AgentWalletPanel";

type AgentTelemetry = {
  executionMode: string;
  agentIdentity: { standard: string; registrationId: number | null; status: string };
  commerce: { standard: string; jobId: string | null; status: string };
  sessionKey: { status: string; reason: string };
  x402: { status: string; reason: string };
  walletProviders: {
    altana: { sdkAvailable: boolean; configured: boolean };
    twak: { sdkAvailable: boolean; configured: boolean };
  };
  recentTransactions: string[];
};

type AgentResponse = {
  requestId: string;
  status: string;
  strategy: AgentStrategy;
  execution: { mode: string; transactionBroadcast: boolean; automatedExecution: boolean };
  mockTrigger?: { triggered: boolean; changePercent: number };
};

const panelClass = "wolv-glass rounded-2xl p-5";
const fieldClass = "wolv-glass-control w-full rounded-xl px-3 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-[#FFC700]/60 focus:ring-1 focus:ring-[#FFC700]/30";

export default function AgentTerminal() {
  const { address, isConnected } = useAccount();
  const [telemetry, setTelemetry] = useState<AgentTelemetry | null>(null);
  const [telemetryError, setTelemetryError] = useState("");
  const [requestText, setRequestText] = useState(
    "Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%"
  );
  const [referencePrice, setReferencePrice] = useState("100");
  const [currentPrice, setCurrentPrice] = useState("98");
  const [draft, setDraft] = useState<AgentResponse | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/agent/execute", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Agent status could not be loaded.");
        return data as AgentTelemetry;
      })
      .then((data) => {
        if (active) setTelemetry(data);
      })
      .catch((cause: unknown) => {
        if (active) setTelemetryError(cause instanceof Error ? cause.message : "Agent status could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(action: "preview" | "simulate") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          strategy: requestText,
          ...(action === "simulate" ? { referencePrice, currentPrice } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The strategy request failed.");
      const result = data as AgentResponse;
      setDraft(result);
      if (action === "simulate") {
        setMessage(result.mockTrigger?.triggered
          ? "Mock threshold met. No transaction was sent; continue to the trade terminal for wallet review."
          : "Mock threshold not met. No transaction was sent.");
      } else {
        setMessage("Local strategy draft created. It is not saved to a scheduler and will not execute automatically.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The strategy request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-10 sm:px-6 sm:pt-14">
      <header className="mb-8">
        <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#FFC700]/25 bg-[#FFC700]/[0.06] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#FFC700]">
          <span className="size-1.5 rounded-full bg-[#FFC700]" />
          Agent terminal · BNB Smart Chain
        </p>
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">Strategy control</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
          Draft conditional spot strategies and test their thresholds locally. A matched rule never broadcasts; every trade still goes through WOLV&apos;s existing quote, simulation, and wallet-confirmation flow.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
        <section className={panelClass} aria-labelledby="strategy-heading">
          <h2 id="strategy-heading" className="text-lg font-bold text-white">Strategy request</h2>
          <label htmlFor="agent-strategy" className="mt-5 block text-xs font-semibold text-slate-300">Natural-language buy rule</label>
          <textarea
            id="agent-strategy"
            className={`${fieldClass} mt-2 min-h-28 resize-y`}
            value={requestText}
            onChange={(event) => setRequestText(event.target.value)}
            maxLength={500}
            aria-describedby="agent-strategy-help"
          />
          <p id="agent-strategy-help" className="mt-2 text-xs leading-5 text-slate-400">
            Supported example: “Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%.” Structured buy/sell fields are also accepted by the API.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-300">
              Mock reference price
              <input className={`${fieldClass} mt-2`} inputMode="decimal" value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-slate-300">
              Mock current price
              <input className={`${fieldClass} mt-2`} inputMode="decimal" value={currentPrice} onChange={(event) => setCurrentPrice(event.target.value)} />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void submit("preview")}
              disabled={busy}
              className="min-h-11 rounded-xl bg-[#FFC700] px-4 text-xs font-black text-[#141414] transition hover:bg-[#ffda45] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Checking…" : "Create local draft"}
            </button>
            <button
              type="button"
              onClick={() => void submit("simulate")}
              disabled={busy}
              className="min-h-11 rounded-xl border border-[#FFC700]/35 bg-[#FFC700]/[0.06] px-4 text-xs font-bold text-[#FFC700] transition hover:bg-[#FFC700]/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Simulate mock trigger
            </button>
          </div>
          {error && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{error}</p>}
          {message && <p role="status" className="mt-4 rounded-lg border border-[#FFC700]/20 bg-[#FFC700]/[0.05] p-3 text-xs leading-5 text-[#ffe28a]">{message}</p>}
          {draft && (
            <div className="wolv-glass-control mt-4 rounded-xl p-4 text-xs text-slate-300">
              <p className="font-semibold text-white">{draft.strategy.side.toUpperCase()} {draft.strategy.ticker} · {draft.strategy.amount} {draft.strategy.amountUnit}</p>
              <p className="mt-1">Trigger: {draft.strategy.triggerDirection} {draft.strategy.triggerPercent}% · max slippage {draft.strategy.maxSlippagePercent}%</p>
              <p className="mt-2 break-all font-mono text-[10px] text-slate-400">Draft {draft.requestId}</p>
              {draft.mockTrigger?.triggered && <Link href="/trade" className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-[#FFC700]/30 px-3 font-bold text-[#FFC700] hover:bg-[#FFC700]/[0.08]">Open trade terminal for wallet review</Link>}
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <AgentWalletPanel />
          <section className={panelClass} aria-labelledby="telemetry-heading">
            <h2 id="telemetry-heading" className="text-lg font-bold text-white">Agent telemetry</h2>
            {telemetryError && <p role="alert" className="mt-3 text-xs text-rose-200">{telemetryError}</p>}
            <dl className="mt-4 space-y-3 text-xs">
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <dt className="text-slate-400">ERC-8004 registration</dt>
                <dd className="text-right font-semibold text-slate-300">{telemetry?.agentIdentity.registrationId ?? "Not registered"}</dd>
              </div>
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <dt className="text-slate-400">ERC-8183 job</dt>
                <dd className="text-right font-semibold text-slate-300">{telemetry?.commerce.jobId ?? "No job created"}</dd>
              </div>
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <dt className="text-slate-400">Session key</dt>
                <dd className="text-right font-semibold text-amber-200">{telemetry?.sessionKey.status ?? "Checking…"}</dd>
              </div>
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <dt className="text-slate-400">x402 settlement</dt>
                <dd className="text-right font-semibold text-slate-300">{telemetry?.x402.status ?? "Checking…"}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-slate-400">Connected wallet</dt>
                <dd className="max-w-[60%] break-all text-right font-mono text-[10px] text-slate-200">
                  {isConnected && address ? address : "Not connected"}
                </dd>
              </div>
            </dl>
            <p className="wolv-glass-control mt-4 rounded-lg p-3 text-[10px] leading-5 text-slate-300">
              Altana SDK: {telemetry?.walletProviders.altana.sdkAvailable ? "available" : "unavailable"} · TWAK SDK: {telemetry?.walletProviders.twak.sdkAvailable ? "available" : "unavailable"}. Neither session provider is configured or allowed to sign here.
            </p>
          </section>

          <section className={panelClass} aria-labelledby="transactions-heading">
            <h2 id="transactions-heading" className="text-lg font-bold text-white">Recent automated transactions</h2>
            <p className="mt-3 text-xs leading-5 text-slate-300">
              No transaction hashes. This wallet-confirmation mode does not sign, broadcast, or store agent transactions.
            </p>
            {telemetry?.recentTransactions.length ? (
              <ul className="mt-3 space-y-2">
                {telemetry.recentTransactions.map((hash) => (
                  <li key={hash} className="break-all font-mono text-[10px] text-[#FFC700]">{hash}</li>
                ))}
              </ul>
            ) : null}
          </section>
        </aside>
      </div>
    </main>
  );
}
