"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAccount, useSignMessage } from "wagmi";

type AgentControlState = {
  emergency_stop: boolean;
  stop_monitoring: boolean;
  reject_new_opportunities: boolean;
  stop_reason: string;
  permission_expires_at: number | null;
  permission_active: boolean;
};

type Activity = {
  event_id: string;
  run_id: string | null;
  event_type: string;
  occurred_at: string;
  event_payload: unknown;
  agent_id?: string | null;
  strategy_id?: string | null;
  run_status?: string | null;
};

type Proposal = {
  proposal_id: string;
  run_id: string;
  asset_id: string;
  direction: "BUY" | "SELL";
  intended_amount: string;
  notional_value: string;
  maximum_slippage_bps: number;
  expires_at: string;
  proposal_status: string;
  user_explanation: string;
  risks: unknown;
  policy_result: unknown;
};

type Observation = {
  observation_id: string;
  asset_id: string;
  ticker: string;
  platform: string;
  price: string;
  reference_price: string | null;
  currency: string;
  price_kind: string;
  source: string;
  provider_timestamp: string;
  verification_status: string;
};

type Opportunity = {
  opportunity_id: string;
  ticker: string;
  direction: "BUY" | "SELL";
  opportunity_status: string;
  strategy_id: string;
  detected_at: string;
  spread_percent: string;
  evidence: unknown;
  historical_context: unknown;
  expires_at: string;
};

type AnalysisRecord = {
  analysis_id: string;
  ticker: string;
  analyzed_at: string;
  model_identifier: string;
  reasoning_summary: string;
  recommendation: string;
  risks: unknown;
  invalidating_conditions: unknown;
};

type Dashboard = {
  control: AgentControlState;
  activity: Activity[];
  nextCursor: string | null;
  proposals: Proposal[];
  policyRefusals: Array<Record<string, unknown>>;
  observations: Observation[];
  activePolicy: Record<string, unknown> | null;
  opportunities: Opportunity[];
  analyses: AnalysisRecord[];
  strategyEvaluations: Array<Record<string, unknown>>;
  execution: { enabled: false; status: "EXECUTION_BLOCKED" };
  configuration?: {
    orchestrationEnabled: boolean;
    collectorEnabled: boolean;
    databaseConfigured: boolean;
  };
};

const cardClass = "wolv-glass rounded-2xl p-5";
const inputClass = "wolv-glass-control w-full rounded-xl px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-[#FFC700]/60";

export default function AgentControlPlane() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [authenticated, setAuthenticated] = useState(false);
  const [authenticatedAddress, setAuthenticatedAddress] = useState("");
  const [authError, setAuthError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({
    agentId: "",
    strategyId: "",
    eventType: "",
    runStatus: "",
    assetId: "",
    since: "",
    until: "",
  });
  const [watchlist, setWatchlist] = useState("");
  const [minimumSpread, setMinimumSpread] = useState("0.5");
  const [intendedAmount, setIntendedAmount] = useState("");
  const [notionalValue, setNotionalValue] = useState("");
  const [maximumSlippageBps, setMaximumSlippageBps] = useState("50");
  const [runResult, setRunResult] = useState<Record<string, unknown> | null>(null);
  const [cursor, setCursor] = useState("");
  const [policyDraft, setPolicyDraft] = useState("");

  const loadDashboard = useCallback(async (nextCursor = "") => {
    const query = buildFilterQuery(filters, nextCursor);
    const response = await fetch(`/api/agent/control${query ? `?${query}` : ""}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(readError(data, "Agent activity could not be loaded."));
    const loaded = data as Dashboard;
    setDashboard(loaded);
    setPolicyDraft((current) => current || (loaded.activePolicy ? JSON.stringify(loaded.activePolicy, null, 2) : ""));
    setCursor(nextCursor);
  }, [filters]);

  useEffect(() => {
    let active = true;
    fetch("/api/agent/session", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json() as { authenticated?: boolean; address?: string; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Operator authorization is unavailable.");
        if (!active) return;
        setAuthenticated(data.authenticated === true);
        setAuthenticatedAddress(data.address ?? "");
        if (data.authenticated === true) {
          fetch("/api/agent/control", { cache: "no-store", credentials: "same-origin" })
            .then(async (controlResponse) => {
              const controlData: unknown = await controlResponse.json();
              if (!controlResponse.ok) throw new Error(readError(controlData, "Agent activity could not be loaded."));
              if (active) {
                const loaded = controlData as Dashboard;
                setDashboard(loaded);
                setPolicyDraft((current) => current || (loaded.activePolicy ? JSON.stringify(loaded.activePolicy, null, 2) : ""));
              }
            })
            .catch((cause: unknown) => {
              if (active) setError(cause instanceof Error ? cause.message : "Agent activity could not be loaded.");
            });
        }
      })
      .catch(() => {
        if (active) {
          setAuthenticated(false);
          setAuthenticatedAddress("");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authenticated || !authenticatedAddress) return;
    if (isConnected && address?.toLowerCase() === authenticatedAddress.toLowerCase()) return;
    fetch("/api/agent/session", { method: "DELETE", credentials: "same-origin" })
      .catch(() => undefined)
      .finally(() => {
        setAuthenticated(false);
        setAuthenticatedAddress("");
        setDashboard(null);
      });
  }, [address, authenticated, authenticatedAddress, isConnected]);

  async function authenticate(): Promise<void> {
    setAuthError("");
    if (!isConnected || !address) {
      setAuthError("Connect an authorized browser wallet before using agent controls.");
      return;
    }
    setBusy(true);
    try {
      const challengeResponse = await fetch("/api/agent/session/challenge", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeResponse.json() as { message?: string; error?: string };
      if (!challengeResponse.ok || typeof challenge.message !== "string") {
        throw new Error(challenge.error ?? "Operator authorization is not configured.");
      }
      const signature = await signMessageAsync({ message: challenge.message });
      const sessionResponse = await fetch("/api/agent/session", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, message: challenge.message, signature }),
      });
      const session = await sessionResponse.json() as { authenticated?: boolean; address?: string; error?: string };
      if (!sessionResponse.ok || session.authenticated !== true || !session.address) {
        throw new Error(session.error ?? "Operator authorization failed.");
      }
      setAuthenticated(true);
      setAuthenticatedAddress(session.address);
      setNotice("Operator authorization established with a message signature; no transaction was signed.");
      await loadDashboard();
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Operator authorization failed.");
    } finally {
      setBusy(false);
    }
  }

  async function postJson(url: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(readError(data, "Agent control request failed."));
    return data;
  }

  async function changeControl(action: "STOP" | "ENABLE") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await postJson("/api/agent/control", action === "STOP"
        ? { action, reason: "Operator activated the emergency stop from the control plane." }
        : {
          action,
          reason: "Operator explicitly enabled a time-limited control-plane permission.",
          permissionTtlMs: 15 * 60_000,
        });
      setNotice(action === "STOP" ? "Emergency stop persisted; pending proposals were expired." : "Control permission enabled for 15 minutes.");
      await loadDashboard("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent control request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function decideProposal(proposalId: string, action: "APPROVE" | "REJECT") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await postJson("/api/agent/proposals", { proposalId, action });
      setNotice(action === "APPROVE"
        ? "Approval recorded for the exact proposal. Execution remains blocked."
        : "Proposal rejection recorded.");
      await loadDashboard(cursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Proposal decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runOnce(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setRunResult(null);
    const addresses = watchlist.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    try {
      const result = await postJson("/api/agent/run", {
        agentId: "wolv-agent",
        watchlist: addresses,
        strategyConfiguration: {
          minimumAbsoluteSpreadPercent: Number(minimumSpread),
          intendedAmount,
          notionalValue,
          maximumSlippageBps: Number(maximumSlippageBps),
        },
      });
      setRunResult(result as Record<string, unknown>);
      setNotice("Bounded monitoring run completed. Review recorded evidence and any refusal reasons below.");
      await loadDashboard();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent run did not complete.");
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const policy: unknown = JSON.parse(policyDraft);
      await postJson("/api/agent/policy", { name: "default", policy, activate: true });
      setPolicyDraft("");
      setNotice("Risk policy version stored and activated. Its permissions expire at the configured timestamp.");
      await loadDashboard("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Risk policy could not be stored.");
    } finally {
      setBusy(false);
    }
  }

  async function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await loadDashboard();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Activity filters could not be applied.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-4 pb-24 pt-24 text-slate-200 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#FFC700]">WOLV Agentic Intelligence · Phase 4.0</p>
        <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">Persistent control plane</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
          Stored observations, opportunities, analysis, policy decisions and approvals. Quote only — no transaction submitted.
          Every approved proposal ends at the execution boundary.
        </p>
      </header>

      <section className={`${cardClass} mb-5`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-white">Operator access</h2>
            <p className="mt-1 text-xs text-slate-400">
              {authenticated ? `Authorized wallet ${authenticatedAddress}` : "A short-lived browser-wallet session is required for control changes."}
            </p>
            <p className="mt-1 text-[10px] text-slate-500">Authentication uses a message signature only. It never signs a transaction.</p>
          </div>
          <button type="button" disabled={busy || authenticated} onClick={() => void authenticate()}
            className="min-h-10 rounded-xl border border-[#FFC700]/45 px-4 text-xs font-bold text-[#FFC700] disabled:opacity-50">
            {authenticated ? "Authorized" : busy ? "Checking…" : "Authorize control plane"}
          </button>
        </div>
        {authError && <p role="alert" className="mt-3 text-xs text-rose-200">{authError}</p>}
      </section>

      <section className={`${cardClass} mb-5`}>
        <h2 className="text-lg font-bold text-white">Deterministic risk policy</h2>
        <p className="mt-1 text-xs leading-5 text-slate-400">
          AI output cannot grant permissions or override this policy. Enter a complete versioned JSON policy; activation is explicit.
          No example policy is preloaded or activated.
        </p>
        <p className="mt-3 text-xs font-semibold text-slate-300">Current active policy</p>
        <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-black/20 p-3 text-[10px] leading-5 text-slate-300">
          {dashboard?.activePolicy ? JSON.stringify(dashboard.activePolicy, null, 2) : "No active policy is stored."}
        </pre>
        <form onSubmit={(event) => void savePolicy(event)} className="mt-3 space-y-3">
          <label className="block text-xs text-slate-300">New policy JSON
            <textarea className={`${inputClass} mt-2 min-h-48 font-mono text-[10px]`} value={policyDraft}
              onChange={(event) => setPolicyDraft(event.target.value)} />
          </label>
          <button type="submit" disabled={busy || !policyDraft.trim()}
            className="min-h-10 rounded-xl border border-[#FFC700]/35 px-4 text-xs font-bold text-[#FFC700] disabled:opacity-50">
            Validate, store and activate policy
          </button>
        </form>
      </section>

      {authenticated && (
        <>
          <section className={`${cardClass} mb-5`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Emergency controls</h2>
                <p className="mt-1 text-xs text-slate-400">
                  {dashboard?.control.permission_active
                    ? `Permission expires ${formatDate(dashboard.control.permission_expires_at)}`
                    : `Stopped or not enabled: ${dashboard?.control.stop_reason ?? "control state loading"}`}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  A restart does not restore permission. Enablement is explicit and expires after 15 minutes.
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={busy || !dashboard?.control.permission_active}
                  onClick={() => void changeControl("STOP")}
                  className="min-h-10 rounded-xl border border-rose-400/40 px-4 text-xs font-bold text-rose-200 disabled:opacity-40">
                  Stop agent
                </button>
                <button type="button" disabled={busy || !dashboard || dashboard.control.permission_active}
                  onClick={() => void changeControl("ENABLE")}
                  className="min-h-10 rounded-xl border border-emerald-400/40 px-4 text-xs font-bold text-emerald-200 disabled:opacity-40">
                  Enable for 15 minutes
                </button>
              </div>
            </div>
            {dashboard?.configuration && (
              <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
                <ConfigStatus label="Orchestrator" enabled={dashboard.configuration.orchestrationEnabled} />
                <ConfigStatus label="Market collector" enabled={dashboard.configuration.collectorEnabled} />
                <ConfigStatus label="PostgreSQL" enabled={dashboard.configuration.databaseConfigured} />
              </div>
            )}
          </section>

          <section className={`${cardClass} mb-5`}>
            <h2 className="text-lg font-bold text-white">Bounded monitoring run</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              One operator-triggered watchlist pass only. The configured Binance adapter records the trusted RWA catalogue;
              it does not invent provider timestamps, prices or candles. Live collection is disabled by default.
            </p>
            <form onSubmit={(event) => void runOnce(event)} className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-300 sm:col-span-2">Watchlist token addresses (comma or newline separated)
                <textarea className={`${inputClass} mt-2 min-h-20 font-mono`} value={watchlist}
                  onChange={(event) => setWatchlist(event.target.value)} />
              </label>
              <label className="text-xs text-slate-300">Minimum observed spread (%)
                <input className={`${inputClass} mt-2`} value={minimumSpread} onChange={(event) => setMinimumSpread(event.target.value)} />
              </label>
              <label className="text-xs text-slate-300">Intended amount for review
                <input className={`${inputClass} mt-2`} value={intendedAmount} onChange={(event) => setIntendedAmount(event.target.value)} />
              </label>
              <label className="text-xs text-slate-300">Notional value for policy review
                <input className={`${inputClass} mt-2`} value={notionalValue} onChange={(event) => setNotionalValue(event.target.value)} />
              </label>
              <label className="text-xs text-slate-300">Maximum slippage (bps)
                <input className={`${inputClass} mt-2`} value={maximumSlippageBps} onChange={(event) => setMaximumSlippageBps(event.target.value)} />
              </label>
              <button type="submit" disabled={busy || !dashboard?.control.permission_active}
                className="min-h-11 rounded-xl bg-[#FFC700] px-4 text-xs font-black text-[#141414] disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2">
                {busy ? "Working…" : "Run one monitoring pass"}
              </button>
            </form>
            {runResult && <pre className="mt-4 max-h-72 overflow-auto rounded-xl bg-black/20 p-3 text-[10px] leading-5 text-slate-300">{JSON.stringify(runResult, null, 2)}</pre>}
          </section>

          {dashboard && (
            <>
              <section className={`${cardClass} mb-5`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-white">Execution boundary</h2>
                  <span className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-200">EXECUTION_BLOCKED</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  Phase 4.0 has no transaction signing, approvals, broadcasts, BAW execution, or background worker.
                  An approved proposal is recorded as approval only and cannot submit a transaction.
                </p>
              </section>

              <section className={`${cardClass} mb-5`}>
                <h2 className="text-lg font-bold text-white">Pending proposals</h2>
                {dashboard.proposals.length === 0 ? <Empty>No proposals are stored.</Empty> : (
                  <ul className="mt-3 space-y-3">
                    {dashboard.proposals.map((proposal) => (
                      <li key={proposal.proposal_id} className="wolv-glass-control rounded-xl p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="break-all font-mono text-[10px] text-slate-400">{proposal.proposal_id}</p>
                          <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-bold text-slate-300">{proposal.proposal_status}</span>
                        </div>
                        <p className="mt-2 text-sm font-bold text-white">{proposal.direction} · {proposal.intended_amount} · notional {proposal.notional_value}</p>
                        <p className="mt-1 text-xs text-slate-400">{proposal.user_explanation}</p>
                        <p className="mt-1 text-[10px] text-slate-500">Expires {formatDate(proposal.expires_at)} · slippage cap {proposal.maximum_slippage_bps} bps</p>
                        <pre className="mt-2 overflow-auto text-[10px] leading-5 text-rose-200">{JSON.stringify(proposal.risks ?? proposal.policy_result, null, 2)}</pre>
                        {proposal.proposal_status === "AWAITING_USER_APPROVAL" && (
                          <div className="mt-3 flex gap-2">
                            <button type="button" disabled={busy} onClick={() => void decideProposal(proposal.proposal_id, "APPROVE")}
                              className="min-h-9 rounded-lg border border-emerald-400/35 px-3 text-xs font-bold text-emerald-200 disabled:opacity-50">Approve (execution blocked)</button>
                            <button type="button" disabled={busy} onClick={() => void decideProposal(proposal.proposal_id, "REJECT")}
                              className="min-h-9 rounded-lg border border-rose-400/35 px-3 text-xs font-bold text-rose-200 disabled:opacity-50">Reject</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={`${cardClass} mb-5`}>
                <h2 className="text-lg font-bold text-white">Opportunity queue</h2>
                {dashboard.opportunities.length === 0 ? <Empty>No opportunities are stored.</Empty> : (
                  <ul className="mt-3 space-y-3">
                    {dashboard.opportunities.map((opportunity) => (
                      <li key={opportunity.opportunity_id} className="wolv-glass-control rounded-xl p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-bold text-white">{opportunity.direction} {opportunity.ticker} · {opportunity.spread_percent}% observed spread</span>
                          <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-bold text-slate-300">{opportunity.opportunity_status}</span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-500">{opportunity.strategy_id} · detected {formatDate(opportunity.detected_at)} · expires {formatDate(opportunity.expires_at)}</p>
                        <pre className="mt-2 overflow-auto text-[10px] leading-5 text-slate-400">{JSON.stringify({ evidence: opportunity.evidence, historicalContext: opportunity.historical_context }, null, 2)}</pre>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={`${cardClass} mb-5`}>
                <h2 className="text-lg font-bold text-white">Agent analysis history</h2>
                {dashboard.analyses.length === 0 ? <Empty>No analysis records are stored.</Empty> : (
                  <ul className="mt-3 space-y-3">
                    {dashboard.analyses.map((analysis) => (
                      <li key={analysis.analysis_id} className="wolv-glass-control rounded-xl p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-bold text-white">{analysis.ticker} · {analysis.model_identifier}</span>
                          <span className="text-[10px] text-slate-500">{formatDate(analysis.analyzed_at)}</span>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-slate-300">{analysis.reasoning_summary}</p>
                        <p className="mt-2 text-xs text-[#FFC700]">Suggested next step: {analysis.recommendation}</p>
                        <pre className="mt-2 overflow-auto text-[10px] leading-5 text-rose-200">{JSON.stringify({ risks: analysis.risks, invalidatingConditions: analysis.invalidating_conditions }, null, 2)}</pre>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={`${cardClass} mb-5`}>
                <h2 className="text-lg font-bold text-white">Strategy evaluation history</h2>
                {dashboard.strategyEvaluations.length === 0 ? <Empty>No strategy evaluations are stored.</Empty> : (
                  <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-black/20 p-3 text-[10px] leading-5 text-slate-300">{JSON.stringify(dashboard.strategyEvaluations, null, 2)}</pre>
                )}
              </section>

              <section className={`${cardClass} mb-5`}>
                <h2 className="text-lg font-bold text-white">Recent market observations</h2>
                {dashboard.observations.length === 0 ? <Empty>No market observations have been recorded.</Empty> : (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-xs">
                      <thead className="text-slate-500"><tr><th className="pb-2">Asset</th><th>Observation</th><th>Kind</th><th>Source</th><th>Provider time</th></tr></thead>
                      <tbody>{dashboard.observations.map((observation) => (
                        <tr key={observation.observation_id} className="border-t border-white/[0.06]">
                          <td className="py-2">{observation.ticker} · {observation.platform}</td>
                          <td>{observation.price} {observation.currency}{observation.reference_price ? ` · ref ${observation.reference_price}` : ""}</td>
                          <td>{observation.price_kind} / {observation.verification_status}</td>
                          <td>{observation.source}</td>
                          <td>{formatDate(observation.provider_timestamp)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className={`${cardClass} mb-5`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-white">Persisted activity</h2>
                  <button type="button" disabled={busy} onClick={() => void loadDashboard()}
                    className="min-h-9 rounded-lg border border-white/10 px-3 text-xs font-bold text-slate-300">Refresh</button>
                </div>
                <form onSubmit={(event) => void applyFilters(event)} className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Filter label="Agent" value={filters.agentId} onChange={(agentId) => setFilters({ ...filters, agentId })} />
                  <Filter label="Strategy" value={filters.strategyId} onChange={(strategyId) => setFilters({ ...filters, strategyId })} />
                  <Filter label="Event type" value={filters.eventType} onChange={(eventType) => setFilters({ ...filters, eventType })} />
                  <Filter label="Run status" value={filters.runStatus} onChange={(runStatus) => setFilters({ ...filters, runStatus })} />
                  <Filter label="Asset ID" value={filters.assetId} onChange={(assetId) => setFilters({ ...filters, assetId })} />
                  <Filter label="Since (epoch ms)" value={filters.since} onChange={(since) => setFilters({ ...filters, since })} />
                  <Filter label="Until (epoch ms)" value={filters.until} onChange={(until) => setFilters({ ...filters, until })} />
                  <button type="submit" disabled={busy} className="min-h-10 rounded-xl border border-[#FFC700]/35 text-xs font-bold text-[#FFC700] disabled:opacity-50">Apply filters</button>
                </form>
                {dashboard.activity.length === 0 ? <Empty>No persisted events match these filters.</Empty> : (
                  <ol className="mt-3 space-y-2">
                    {dashboard.activity.map((event) => (
                      <li key={event.event_id} className="wolv-glass-control rounded-xl p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-bold text-white">{event.event_type}</span>
                          <span className="text-[10px] text-slate-500">{formatDate(event.occurred_at)}</span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-400">{event.agent_id ?? "system"} · {event.strategy_id ?? "control"} · {event.run_status ?? "—"}</p>
                        <pre className="mt-2 overflow-auto text-[10px] leading-5 text-slate-400">{JSON.stringify(event.event_payload, null, 2)}</pre>
                      </li>
                    ))}
                  </ol>
                )}
                {dashboard.nextCursor && (
                  <button type="button" disabled={busy} onClick={() => void loadDashboard(dashboard.nextCursor ?? "")}
                    className="mt-3 min-h-9 rounded-lg border border-white/10 px-3 text-xs font-bold text-slate-300">Load older events</button>
                )}
              </section>

              <section className={`${cardClass} mb-5`}>
                <h2 className="text-lg font-bold text-white">Policy refusals</h2>
                {dashboard.policyRefusals.length === 0 ? <Empty>No policy refusals are stored.</Empty> : (
                  <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-black/20 p-3 text-[10px] leading-5 text-rose-200">{JSON.stringify(dashboard.policyRefusals, null, 2)}</pre>
                )}
              </section>
            </>
          )}
        </>
      )}

      {notice && <p role="status" className="fixed bottom-4 right-4 z-50 max-w-lg rounded-xl border border-emerald-400/20 bg-[#111820] px-4 py-3 text-xs text-emerald-200">{notice}</p>}
      {error && <p role="alert" className="fixed bottom-4 left-4 z-50 max-w-lg rounded-xl border border-rose-400/20 bg-[#111820] px-4 py-3 text-xs text-rose-200">{error}</p>}
    </main>
  );
}

function ConfigStatus({ label, enabled }: { label: string; enabled: boolean }) {
  return <p className="rounded-lg bg-black/15 px-3 py-2 text-slate-400">{label}: <span className={enabled ? "text-emerald-200" : "text-amber-200"}>{enabled ? "enabled" : "disabled"}</span></p>;
}

function Filter({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-[10px] text-slate-400">{label}<input className={`${inputClass} mt-1`} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Empty({ children }: { children: string }) {
  return <p className="mt-3 rounded-xl bg-black/15 p-3 text-xs text-slate-500">{children}</p>;
}

function buildFilterQuery(filters: Record<string, string>, cursor: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function formatDate(value: string | number | null): string {
  if (value === null) return "not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid timestamp" : date.toLocaleString();
}

function readError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || !("error" in value) || typeof value.error !== "string") return fallback;
  return value.error;
}
