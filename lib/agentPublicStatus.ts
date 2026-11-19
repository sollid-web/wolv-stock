import type { PublicAgentStatusSnapshot } from "@/services/agentMemoryStore";

export type AgentLiveState =
  | "OFFLINE"
  | "PAUSED"
  | "IDLE"
  | "MONITORING"
  | "EVALUATING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED";

export type AgentPublicStatus = {
  state: AgentLiveState;
  headline: string;
  detail: string;
  workerOnline: boolean;
  workerLastSeenAgoSeconds: number | null;
  strategy: {
    name: string;
    intervalSeconds: number;
    nextRunAt: number | null;
    lastEvaluatedAt: number | null;
    lastDecision: string | null;
    lastDecisionLabel: string | null;
    priceUsd: number | null;
    entryUsd: number | null;
  } | null;
  totals: PublicAgentStatusSnapshot["totals"];
  recentExecutions: PublicAgentStatusSnapshot["recentExecutions"];
  recentAlerts: PublicAgentStatusSnapshot["recentAlerts"];
  generatedAt: number;
};

const WORKER_ONLINE_MS = 60_000;
const RECENT_MS = 3 * 60_000;

/** Plain-language labels for the worker's real decision codes. */
export const DECISION_LABELS: Record<string, string> = {
  TRIGGER_NOT_MET: "Waiting: price is above the entry threshold",
  VALIDATOR_PASS: "Entry conditions met; policy pre-checks passed",
  INTENT_PENDING: "Waiting for the previous intent to settle",
  CAP_EXCEEDED: "Rejected: rolling volume cap reached",
  TRADE_CAP_EXCEEDED: "Rejected: above the per-trade cap",
  CIRCUIT_BREAKER_PAUSED: "Paused by the on-chain guardian",
  SESSION_REVOKED: "Agent permission revoked on-chain",
  SESSION_NOT_INSTALLED: "Policy hook not installed",
  POLICY_NOT_CONFIGURED: "On-chain policy not configured",
  POLICY_HASH_MISMATCH: "Rejected: strategy differs from the signed policy",
  POLICY_EXPIRED: "Policy expired; owner must renew",
  SLIPPAGE_HIGH: "Rejected: price impact above the policy limit",
  RPC_FAILURE: "Market data or network read failed",
  WORKER_PANIC_STOP: "Worker stopped itself after repeated failures",
  BUNDLER_MEMPOOL_REJECTED: "Rejected by the bundler before execution",
  ONCHAIN_EXECUTION_REVERTED: "On-chain execution reverted",
  USEROP_RECEIPT_TIMEOUT: "Submitted; receipt not yet confirmed",
};

function micros(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1_000_000 : null;
}

/** Derives one honest live state from persisted records only; never infers activity. */
export function deriveAgentPublicStatus(snapshot: PublicAgentStatusSnapshot, now: number): AgentPublicStatus {
  const lastSeen = snapshot.worker?.lastSeenAt ?? null;
  const workerOnline = lastSeen !== null && now - lastSeen <= WORKER_ONLINE_MS;
  const schedule = snapshot.schedules.find((item) => item.enabled) ?? null;
  const evaluation = schedule?.lastEvaluation ?? null;
  const lastDecision = typeof evaluation?.reasonCode === "string" ? evaluation.reasonCode : null;
  const latest = snapshot.recentExecutions[0] ?? null;
  const latestAt = latest?.settledAt ?? latest?.createdAt ?? null;
  const recent = latestAt !== null && now - latestAt <= RECENT_MS;
  const releaseActive = snapshot.control !== null && !snapshot.control.emergencyStop &&
    snapshot.control.releaseExpiresAt !== null && snapshot.control.releaseExpiresAt > now;
  const paused = snapshot.worker?.globallyPaused === true || !releaseActive;

  let state: AgentLiveState;
  let headline: string;
  let detail: string;
  if (!workerOnline) {
    state = "OFFLINE";
    headline = "Agent worker offline";
    detail = lastSeen === null ? "No worker heartbeat has been recorded." : "The worker has not reported a heartbeat in the last minute.";
  } else if (snapshot.totals.inFlight > 0 || latest?.status === "SUBMITTED" || latest?.status === "CLAIMED") {
    state = "SUBMITTED";
    headline = "Trade submitted";
    detail = "A UserOperation is in flight; WOLV records it as confirmed only after on-chain verification.";
  } else if (paused) {
    state = "PAUSED";
    headline = "Agent paused";
    detail = snapshot.control?.emergencyStop
      ? "The owner's global emergency stop is active. No trades are claimed."
      : "The owner's time-boxed release has expired. No trades are claimed until it is released again.";
  } else if (!schedule) {
    state = "IDLE";
    headline = "No active strategy";
    detail = "The worker is online, but no autonomous strategy is enabled.";
  } else if (recent && latest?.status === "CONFIRMED") {
    state = "CONFIRMED";
    headline = "Trade confirmed on-chain";
    detail = "The most recent autonomous trade was verified on-chain.";
  } else if (recent && latest?.status === "FAILED") {
    state = "FAILED";
    headline = "Last attempt failed safely";
    detail = DECISION_LABELS[latest.failureCode ?? ""] ?? "The last attempt was rejected before or during execution.";
  } else if (lastDecision === "VALIDATOR_PASS") {
    state = "EVALUATING";
    headline = "Entry conditions met";
    detail = "Policy pre-checks passed; the agent is preparing a bounded intent.";
  } else {
    state = "MONITORING";
    headline = "Monitoring the market";
    detail = lastDecision ? DECISION_LABELS[lastDecision] ?? lastDecision : "Waiting for the next evaluation cycle.";
  }

  return {
    state,
    headline,
    detail,
    workerOnline,
    workerLastSeenAgoSeconds: lastSeen === null ? null : Math.max(0, Math.round((now - lastSeen) / 1000)),
    strategy: schedule ? {
      name: schedule.name,
      intervalSeconds: schedule.intervalSeconds,
      nextRunAt: schedule.nextRunAt,
      lastEvaluatedAt: schedule.lastEvaluatedAt,
      lastDecision,
      lastDecisionLabel: lastDecision ? DECISION_LABELS[lastDecision] ?? lastDecision : null,
      priceUsd: micros(evaluation?.currentPriceMicros),
      entryUsd: micros(evaluation?.entryPriceMicros),
    } : null,
    totals: snapshot.totals,
    recentExecutions: snapshot.recentExecutions,
    recentAlerts: snapshot.recentAlerts,
    generatedAt: now,
  };
}
