"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { AgentStrategy } from "@/lib/agentStrategies";
import { isFreshQuote } from "@/lib/tradeReadiness";
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

type AgentQuoteResult = {
  status: "QUOTED" | "REJECTED";
  eligibility?: "ELIGIBLE" | "REJECTED";
  rejectionReasons: string[];
  direction?: "BUY" | "SELL";
  chainId?: string;
  tokenAddress?: string;
  underlyingTicker?: string;
  walletAddress?: string;
  fromTokenAddress?: string;
  toTokenAddress?: string;
  fromCoinSymbol?: string;
  fromCoinAmount?: string;
  toCoinSymbol?: string;
  toCoinAmount?: string;
  slippage?: number;
  slippageBps?: number;
  tokenPriceUsd?: number;
  referencePrice?: number;
  referenceGapPercent?: number | null;
  quoteFetchedAt?: number;
  expiresAt?: number;
  quoteBindingId?: string;
  quoteBinding?: string;
  error?: string;
  code?: string;
};

type BawApproval = {
  executionId: string;
  approvalReference: string;
  approvalToken: string;
  expiresAt: number;
  trade: {
    walletAddress: string;
    tokenAddress: string;
    tokenSymbol: string;
    direction: "BUY" | "SELL";
    chainId: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    requestedInputAmount: string;
    expectedOutputAmount: string;
    minimumOutputAmount: string;
    slippageBps: number;
    quoteExpiresAt: number;
    referencePrice: number;
  };
};

type BawExecutionRecord = {
  executionId: string;
  approvalReference: string;
  walletAddress: string;
  tokenAddress: string;
  underlyingTicker: string;
  tokenSymbol: string;
  direction: "BUY" | "SELL";
  chainId: string;
  requestedInputAmount: string;
  expectedOutputAmount: string;
  minimumOutputAmount: string;
  state: string;
  providerOrderId: string | null;
  actualExecutedInput: string | null;
  actualReceivedOutput: string | null;
  refunds: { tokenAddress: string; amount: string; symbol: string }[];
  averageExecutionPrice: string | null;
  transactionHash: string | null;
  failureReason: string | null;
  submittedAt: number | null;
  completedAt: number | null;
};

const panelClass = "wolv-glass rounded-2xl p-5";
const fieldClass = "wolv-glass-control w-full rounded-xl px-3 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-[#FFC700]/60 focus:ring-1 focus:ring-[#FFC700]/30";

export default function AgentTerminal() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
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
  const [bawSessionAuthenticated, setBawSessionAuthenticated] = useState(false);
  const [bawSessionAddress, setBawSessionAddress] = useState<string>();
  const [bawSessionError, setBawSessionError] = useState("");
  const [quoteDirection, setQuoteDirection] = useState<"BUY" | "SELL">("BUY");
  const [quoteTokenAddress, setQuoteTokenAddress] = useState("");
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteSlippageBps, setQuoteSlippageBps] = useState("100");
  const [quoteResult, setQuoteResult] = useState<AgentQuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteNow, setQuoteNow] = useState(0);
  const [bawApproval, setBawApproval] = useState<BawApproval | null>(null);
  const [bawExecution, setBawExecution] = useState<BawExecutionRecord | null>(null);
  const [bawExecutionBusy, setBawExecutionBusy] = useState(false);
  const [bawExecutionError, setBawExecutionError] = useState("");
  const [securityAuditAcknowledged, setSecurityAuditAcknowledged] = useState(false);

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

  useEffect(() => {
    let active = true;
    fetch("/api/agent/session", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "BAW session is not authorized.");
        return data as { authenticated: boolean; address: string };
      })
      .then((session) => {
        if (!active) return;
        setBawSessionAuthenticated(session.authenticated);
        setBawSessionAddress(session.address);
      })
      .catch(() => {
        if (active) {
          setBawSessionAuthenticated(false);
          setBawSessionAddress(undefined);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!quoteResult || quoteResult.status !== "QUOTED") return;
    const timer = window.setInterval(() => setQuoteNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [quoteResult]);

  useEffect(() => {
    if (!bawExecution || !bawSessionAuthenticated || !["APPROVED", "SUBMITTING", "SUBMITTED", "PENDING", "UNKNOWN"].includes(bawExecution.state)) return;
    let active = true;
    const timer = window.setInterval(() => {
      fetch(`/api/agent/executions?executionId=${encodeURIComponent(bawExecution.executionId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Execution status could not be verified.");
          return data.execution as BawExecutionRecord;
        })
        .then((record) => {
          if (active) setBawExecution(record);
        })
        .catch((cause: unknown) => {
          if (active) setBawExecutionError(cause instanceof Error ? cause.message : "Execution status could not be verified.");
        });
    }, 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [bawSessionAuthenticated, bawExecution]);

  useEffect(() => {
    if (!bawSessionAuthenticated || !bawSessionAddress) return;
    if (isConnected && address?.toLowerCase() === bawSessionAddress.toLowerCase()) return;
    fetch("/api/agent/session", { method: "DELETE", credentials: "same-origin" })
      .catch(() => undefined)
      .finally(() => {
        setBawSessionAuthenticated(false);
        setBawSessionAddress(undefined);
      });
  }, [address, bawSessionAddress, bawSessionAuthenticated, isConnected]);

  async function authenticateBawSession(): Promise<boolean> {
    setBawSessionError("");
    if (!isConnected || !address) {
      setBawSessionError("Connect a browser wallet before authorizing operator access.");
      return false;
    }
    try {
      const challengeResponse = await fetch("/api/agent/session/challenge", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok || typeof challenge.message !== "string") {
        throw new Error(typeof challenge.error === "string" ? challenge.error : "Wallet authentication is not configured.");
      }
      const signature = await signMessageAsync({ message: challenge.message });
      const response = await fetch("/api/agent/session", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, message: challenge.message, signature }),
      });
      const session = await response.json();
      if (!response.ok || session.authenticated !== true) {
        throw new Error(typeof session.error === "string" ? session.error : "Browser-wallet authorization failed.");
      }
      setBawSessionAuthenticated(true);
      setBawSessionAddress(session.address);
      return true;
    } catch (cause) {
      setBawSessionError(cause instanceof Error ? cause.message : "Browser-wallet authorization failed.");
      return false;
    }
  }

  async function signOutBawSession(): Promise<void> {
    try {
      await fetch("/api/agent/session", { method: "DELETE", credentials: "same-origin" });
    } catch {
      setBawSessionError("The session could not be revoked by the server; it will expire automatically.");
    } finally {
      setBawSessionAuthenticated(false);
      setBawSessionAddress(undefined);
      setQuoteResult(null);
      setBawApproval(null);
      setBawExecution(null);
    }
  }

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

  async function submitQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuoteBusy(true);
    setQuoteError("");
    setQuoteResult(null);
    setBawApproval(null);
    setBawExecution(null);
    setBawExecutionError("");
    setSecurityAuditAcknowledged(false);
    try {
      const response = await fetch("/api/agent/quote", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          direction: quoteDirection,
          tokenAddress: quoteTokenAddress.trim(),
          amount: quoteAmount.trim(),
          chainId: "56",
          slippageBps: Number(quoteSlippageBps),
        }),
      });
      const data = await response.json() as AgentQuoteResult;
      if (!response.ok) {
        setQuoteResult(data.status === "REJECTED" ? data : null);
        if (data.status !== "REJECTED") {
          setQuoteError(data.error ?? "The BAW quote request was rejected.");
        }
        return;
      }
      setQuoteNow(Date.now());
      setQuoteResult(data);
    } catch (cause) {
      setQuoteError(cause instanceof Error ? cause.message : "The BAW quote request failed.");
    } finally {
      setQuoteBusy(false);
    }
  }

  async function prepareBawApproval() {
    if (!quoteResult || quoteResult.status !== "QUOTED" || quoteResult.eligibility !== "ELIGIBLE") return;
    setBawExecutionBusy(true);
    setBawExecutionError("");
    setBawApproval(null);
    setBawExecution(null);
    setSecurityAuditAcknowledged(false);
    try {
      const response = await fetch("/api/agent/approve", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ quote: quoteResult }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Trade approval could not be prepared.");
      setBawApproval(data as BawApproval);
    } catch (cause) {
      setBawExecutionError(cause instanceof Error ? cause.message : "Trade approval could not be prepared.");
    } finally {
      setBawExecutionBusy(false);
    }
  }

  async function approveAndExecuteBawTrade() {
    if (!bawApproval) return;
    const approval = bawApproval;
    setBawExecutionBusy(true);
    setBawExecutionError("");
    try {
      const response = await fetch("/api/agent/execute", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "executeBaw",
          executionId: approval.executionId,
          approvalToken: approval.approvalToken,
          securityAuditAcknowledged,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "BAW execution was rejected.");
      setBawExecution(data.execution as BawExecutionRecord);
      setBawApproval(null);
      setSecurityAuditAcknowledged(false);
    } catch (cause) {
      setBawExecutionError(cause instanceof Error ? cause.message : "BAW execution could not be confirmed.");
      setBawExecution({
        executionId: approval.executionId,
        approvalReference: approval.approvalReference,
        walletAddress: approval.trade.walletAddress,
        tokenAddress: approval.trade.tokenAddress,
        underlyingTicker: quoteResult?.underlyingTicker ?? "unknown",
        tokenSymbol: approval.trade.tokenSymbol,
        direction: approval.trade.direction,
        chainId: approval.trade.chainId,
        requestedInputAmount: approval.trade.requestedInputAmount,
        expectedOutputAmount: approval.trade.expectedOutputAmount,
        minimumOutputAmount: approval.trade.minimumOutputAmount,
        state: "UNKNOWN",
        providerOrderId: null,
        actualExecutedInput: null,
        actualReceivedOutput: null,
        refunds: [],
        averageExecutionPrice: null,
        transactionHash: null,
        failureReason: "The response was interrupted; checking the durable execution record before any retry.",
        submittedAt: null,
        completedAt: null,
      });
      setBawApproval(null);
    } finally {
      setBawExecutionBusy(false);
    }
  }

  const quoteExpired = quoteResult?.status === "QUOTED"
    && typeof quoteResult.quoteFetchedAt === "number"
    && !isFreshQuote({ quoteFetchedAt: quoteResult.quoteFetchedAt }, quoteNow);
  const quoteState = quoteExpired ? "EXPIRED" : quoteResult?.status ?? null;
  const approvalExpired = bawApproval !== null && quoteNow >= bawApproval.expiresAt;

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

      <section className={`${panelClass} mb-5`} aria-labelledby="baw-quote-heading">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="baw-quote-heading" className="text-lg font-bold text-white">BAW live quote</h2>
            <p className="mt-2 text-xs leading-5 text-slate-300">
              Quote only — no transaction submitted. Uses the authenticated BAW wallet session on BNB Smart Chain mainnet.
            </p>
          </div>
          <span className="w-fit rounded-full border border-amber-300/25 bg-amber-300/[0.06] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-200">
            {bawExecution ? "BAW execution · operator wallet" : "Quote only · explicit approval required"}
          </span>
        </div>

        <form className="mt-5 grid gap-3 sm:grid-cols-2" onSubmit={(event) => void submitQuote(event)}>
          <label className="text-xs font-semibold text-slate-300">
            Direction
            <select
              className={`${fieldClass} mt-2`}
              value={quoteDirection}
              onChange={(event) => {
                setQuoteDirection(event.target.value as "BUY" | "SELL");
                setQuoteResult(null);
                setBawApproval(null);
                setSecurityAuditAcknowledged(false);
              }}
            >
              <option value="BUY">BUY · USDT → selected token</option>
              <option value="SELL">SELL · selected token → USDT</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-300">
            Selected spot token contract address
            <input
              className={`${fieldClass} mt-2 font-mono text-xs`}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              value={quoteTokenAddress}
              onChange={(event) => {
                setQuoteTokenAddress(event.target.value);
                setQuoteResult(null);
                setBawApproval(null);
                setSecurityAuditAcknowledged(false);
              }}
              placeholder="0x…"
              required
            />
          </label>
          <label className="text-xs font-semibold text-slate-300">
            Source quantity ({quoteDirection === "BUY" ? "USDT" : "selected token"})
            <input
              className={`${fieldClass} mt-2`}
              inputMode="decimal"
              value={quoteAmount}
              onChange={(event) => {
                setQuoteAmount(event.target.value);
                setQuoteResult(null);
                setBawApproval(null);
                setSecurityAuditAcknowledged(false);
              }}
              placeholder={quoteDirection === "BUY" ? "5 or more" : "token quantity"}
              required
            />
            <span className="mt-1 block font-normal text-slate-400">Human-readable amount; WOLV integer units are not sent to BAW.</span>
          </label>
          <label className="text-xs font-semibold text-slate-300">
            Slippage tolerance (basis points)
            <input
              className={`${fieldClass} mt-2`}
              type="number"
              inputMode="numeric"
              min="1"
              max="500"
              step="1"
              value={quoteSlippageBps}
              onChange={(event) => {
                setQuoteSlippageBps(event.target.value);
                setQuoteResult(null);
                setBawApproval(null);
                setSecurityAuditAcknowledged(false);
              }}
              required
            />
            <span className="mt-1 block font-normal text-slate-400">Exact conversion to BAW percentage, capped at 500 bps (5%).</span>
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={quoteBusy || !bawSessionAuthenticated}
              className="min-h-11 rounded-xl bg-[#FFC700] px-4 text-xs font-black text-[#141414] transition hover:bg-[#ffda45] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {quoteBusy ? "Requesting quote…" : "Request BAW quote"}
            </button>
            {!bawSessionAuthenticated && <p className="mt-2 text-xs text-amber-200">Authorize with your connected browser wallet in the operator-wallet panel before requesting a quote.</p>}
          </div>
        </form>

        {quoteError && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{quoteError}</p>}
        {quoteResult && (
          <div className="wolv-glass-control mt-4 rounded-xl p-4 text-xs text-slate-300" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-400">Quote state</span>
              <span className={`rounded-full px-2.5 py-1 font-bold ${
                quoteState === "EXPIRED" ? "bg-slate-400/10 text-slate-300"
                  : quoteState === "REJECTED" ? "bg-rose-400/10 text-rose-200"
                    : "bg-amber-300/10 text-amber-200"
              }`}>{quoteState}</span>
              {quoteResult.status === "QUOTED" && (
                <>
                  <span className="font-semibold text-slate-400">WOLV checks</span>
                  <span className={`rounded-full px-2.5 py-1 font-bold ${
                    quoteExpired ? "bg-slate-400/10 text-slate-300"
                      : quoteResult.eligibility === "ELIGIBLE" ? "bg-emerald-400/10 text-emerald-200"
                        : "bg-rose-400/10 text-rose-200"
                  }`}>{quoteExpired ? "EXPIRED" : quoteResult.eligibility}</span>
                </>
              )}
            </div>
            {quoteResult.status === "QUOTED" && (
              <>
                <p className="mt-3 font-semibold text-white">
                  {quoteResult.fromCoinAmount} {quoteResult.fromCoinSymbol}
                  <span className="mx-2 text-slate-500">→</span>
                  {quoteResult.toCoinAmount} {quoteResult.toCoinSymbol}
                </p>
                <p className="mt-1">
                  {quoteResult.direction} · input {quoteResult.fromTokenAddress} · output {quoteResult.toTokenAddress}
                </p>
                <p className="mt-1">Underlying ticker: {quoteResult.underlyingTicker ?? "Unverified"} · BAW symbol: {quoteResult.direction === "BUY" ? quoteResult.toCoinSymbol : quoteResult.fromCoinSymbol}</p>
                <p className="mt-1">Executable quote price: ${quoteResult.tokenPriceUsd?.toFixed(4)} · reference price: ${quoteResult.referencePrice?.toFixed(4)} · price gap: {quoteResult.referenceGapPercent?.toFixed(2) ?? "—"}%</p>
                <p className="mt-1">
                  Slippage: {quoteResult.slippageBps} bps ({((quoteResult.slippage ?? 0) * 100).toFixed(2)}%) · chain {quoteResult.chainId}
                </p>
                <p className="mt-1">Quote expires: {quoteResult.expiresAt ? new Date(quoteResult.expiresAt).toLocaleTimeString() : "—"}</p>
              </>
            )}
            {quoteResult.rejectionReasons.length > 0 && (
              <div className="mt-3 text-rose-200">
                <p className="font-semibold">Rejection reasons</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {quoteResult.rejectionReasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}
                </ul>
              </div>
            )}
            {quoteResult.status === "REJECTED" && quoteResult.error && (
              <p className="mt-2 text-rose-200">{quoteResult.error}</p>
            )}
            {quoteExpired && <p className="mt-3 text-slate-300">This quote is expired. Request a fresh quote before relying on it.</p>}
            <p className="mt-3 text-[10px] leading-5 text-slate-400">
              {quoteResult.walletAddress ? `BAW wallet: ${quoteResult.walletAddress} · ` : ""}
              The quote binding protects quote integrity and expiry only. It does not authorize or submit a transaction.
            </p>
            <p className="mt-2 text-[10px] leading-5 text-amber-200">
              {bawExecution
                ? "The displayed quote was not itself submitted. Any execution below was separately approved and status-checked."
                : "Quote only — no transaction submitted. A BAW quote does not include an execution-fee estimate; execution remains unavailable unless the configured BNB reserve and all wallet checks pass."}
            </p>
            {quoteResult.status === "QUOTED" && quoteResult.eligibility === "ELIGIBLE" && !quoteExpired && (
              <button
                type="button"
                onClick={() => void prepareBawApproval()}
                disabled={bawExecutionBusy || !bawSessionAuthenticated}
                className="mt-4 min-h-11 rounded-xl border border-[#FFC700]/45 px-4 text-xs font-bold text-[#FFC700] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bawExecutionBusy ? "Checking wallet and quote…" : "Review and prepare this trade"}
              </button>
            )}
          </div>
        )}
        {bawExecutionError && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{bawExecutionError}</p>}
        {bawApproval && (
          <div className="wolv-glass-control mt-4 rounded-xl border border-[#FFC700]/25 p-4 text-xs text-slate-300">
            <p className="font-bold text-white">Separate approval required · BAW operator wallet</p>
            <p className="mt-2">{bawApproval.trade.direction} {bawApproval.trade.tokenSymbol} ({quoteResult?.underlyingTicker ?? "underlying ticker unavailable"}) on BSC (56)</p>
            <p className="mt-1">Input: {bawApproval.trade.requestedInputAmount} {quoteResult?.fromCoinSymbol} → expected: {bawApproval.trade.expectedOutputAmount} {quoteResult?.toCoinSymbol}</p>
            <p className="mt-1">Minimum acceptable output: {bawApproval.trade.minimumOutputAmount} {quoteResult?.toCoinSymbol} · slippage: {bawApproval.trade.slippageBps} bps</p>
            <p className="mt-1">Reference: ${bawApproval.trade.referencePrice.toFixed(4)} · executable quote: ${quoteResult?.tokenPriceUsd?.toFixed(4)} · gap: {quoteResult?.referenceGapPercent?.toFixed(2) ?? "—"}%</p>
            <p className="mt-1 break-all">BAW wallet: {bawApproval.trade.walletAddress}</p>
            <p className="mt-1">Quote expires: {new Date(bawApproval.trade.quoteExpiresAt).toLocaleTimeString()} · one-time approval expires: {new Date(bawApproval.expiresAt).toLocaleTimeString()}</p>
            <p className="mt-2 text-amber-200">Operator wallet only; no ZeroDev account. BAW does not provide a documented fee estimate in its quote response. Do not proceed unless you have reviewed fees and this exact order.</p>
            <label className="mt-3 flex items-start gap-2 text-amber-100">
              <input
                type="checkbox"
                checked={securityAuditAcknowledged}
                onChange={(event) => setSecurityAuditAcknowledged(event.target.checked)}
                className="mt-0.5 accent-[#FFC700]"
              />
              <span>
                No token-audit provider is integrated here. I have reviewed this exact contract&apos;s security data, or acknowledge that no audit was performed.
              </span>
            </label>
            {approvalExpired
              ? <p role="status" className="mt-3 text-rose-200">This approval expired. Request a fresh quote and prepare a new approval.</p>
              : (
                <button
                  type="button"
                  onClick={() => void approveAndExecuteBawTrade()}
                  disabled={bawExecutionBusy || !securityAuditAcknowledged}
                  className="mt-4 min-h-12 rounded-xl bg-rose-500 px-4 text-xs font-black text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {bawExecutionBusy ? "Submitting and verifying…" : "Approve and Execute This Trade"}
                </button>
              )}
          </div>
        )}
        {bawExecution && (
          <div className="wolv-glass-control mt-4 rounded-xl p-4 text-xs text-slate-300" aria-live="polite">
            <p className="font-bold text-white">Execution status: {bawExecution.state}</p>
            <p className="mt-1">BAW order ID: {bawExecution.providerOrderId ?? "Not returned"}</p>
            <p className="mt-1">Requested input: {bawExecution.requestedInputAmount} · actual input reported: {bawExecution.actualExecutedInput ?? "Not reported"} · actual received: {bawExecution.actualReceivedOutput ?? "Not reported"}</p>
            <p className="mt-1">Average execution price: {bawExecution.averageExecutionPrice ?? "Not reported by BAW"}</p>
            {bawExecution.refunds.length > 0 && (
              <p className="mt-2 text-amber-200">
                Partial fill — BAW reported refunds: {bawExecution.refunds.map((refund) => `${refund.amount} ${refund.symbol} (${refund.tokenAddress})`).join("; ")}
              </p>
            )}
            {bawExecution.state === "FILLED" && bawExecution.refunds.length === 0 && (
              <p className="mt-2 text-slate-400">BAW reported FINISHED. No refund information was provided; a full fill cannot be inferred from that absence.</p>
            )}
            <p className="mt-1">Transaction hash: {bawExecution.transactionHash ?? "Not reported"}</p>
            {bawExecution.failureReason && <p className="mt-2 text-rose-200">{bawExecution.failureReason}</p>}
            {bawExecution.state === "UNKNOWN" && <p className="mt-2 text-amber-200">Outcome is uncertain. Do not retry; reconcile this execution before any further order.</p>}
          </div>
        )}
      </section>

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
          {bawSessionError && <p role="alert" className="mb-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{bawSessionError}</p>}
          <AgentWalletPanel
            authenticated={bawSessionAuthenticated}
            browserWalletAddress={bawSessionAddress}
            onAuthenticate={authenticateBawSession}
            onSignOut={signOutBawSession}
          />
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
