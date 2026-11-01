import { createHash, randomUUID } from "node:crypto";
import { MAX_RELIABLE_GAP_PERCENT } from "./marketThresholds.js";

const ZERO_DECIMAL_UNITS = BigInt(0);
const DECIMAL_SCALE = BigInt("1000000000000000000");
const MAX_POLICY_PERMISSION_MS = 30 * 60_000;

export const AGENT_STATES = [
  "IDLE",
  "INITIALIZING",
  "MONITORING",
  "OBSERVATION_RECORDED",
  "OPPORTUNITY_DETECTED",
  "ANALYZING",
  "ANALYSIS_COMPLETED",
  "POLICY_VALIDATION",
  "POLICY_APPROVED",
  "POLICY_REJECTED",
  "PROPOSAL_CREATED",
  "AWAITING_USER_APPROVAL",
  "USER_APPROVED",
  "USER_REJECTED",
  "EXPIRED",
  "EXECUTION_BLOCKED",
  "COMPLETED",
  "FAILED",
  "STOPPED",
] as const;

export type AgentState = typeof AGENT_STATES[number];
export type AgentDirection = "BUY" | "SELL";
export type PriceKind = "INDICATIVE" | "EXECUTABLE";
export type VerificationStatus = "VERIFIED" | "UNVERIFIED" | "REJECTED";

export type AssetVersionInput = {
  chainId: number;
  tokenAddress: string;
  ticker: string;
  platform: string;
  decimals: number | null;
  shareDenomination: Record<string, unknown> | null;
  metadataSource: string;
  observedAt: number;
  blockNumber: string | null;
  blockHash: string | null;
  metadata: Record<string, unknown>;
};

export type MarketObservationInput = {
  ownerAddress: string;
  assetId: string;
  price: string;
  referencePrice: string | null;
  bid: string | null;
  ask: string | null;
  spreadPercent: string | null;
  currency: string;
  priceKind: PriceKind;
  source: string;
  providerTimestamp: number;
  ingestedAt: number;
  freshnessMs: number;
  verificationStatus: VerificationStatus;
  provenance: Record<string, unknown>;
  idempotencyKey: string;
};

export type AgentRunInput = {
  ownerAddress: string;
  agentId: string;
  strategyId: string;
  strategyVersion: string;
  triggerType: string;
  startedAt: number;
  configuration: Record<string, unknown>;
};

export type RiskPolicy = {
  version: string;
  approvedAssets: string[];
  approvedDirections: AgentDirection[];
  maxOrderValue: string;
  maxDailyExposure: string;
  maxSlippageBps: number;
  maxReferenceDeviationPercent: number;
  allowedSessions: string[];
  minimumBalance: string;
  quoteTtlMs: number;
  permissionExpiresAt: number;
  emergencyStop: boolean;
};

export type PolicyDecision = {
  policyVersion: string;
  inputSnapshotHash: string;
  evaluatedAt: number;
  accepted: boolean;
  refusalReasons: string[];
};

export type TradeProposalInput = {
  runId: string;
  opportunityId: string;
  assetId: string;
  direction: AgentDirection;
  intendedAmount: string;
  notionalValue: string;
  quoteReference: string | null;
  expectedInput: string | null;
  expectedOutput: string | null;
  maximumSlippageBps: number;
  policyDecision: PolicyDecision;
  analysisId: string;
  expiresAt: number;
  risks: string[];
  explanation: string;
};

export type OpportunityEvidence = {
  observationId: string;
  assetId: string;
  tokenAddress: string;
  ticker: string;
  platform: string;
  currency: string;
  normalizedSharePrice: string;
  referencePrice: string | null;
  providerTimestamp: number;
  ingestedAt: number;
  freshnessMs: number;
  verificationStatus: VerificationStatus;
  priceKind: PriceKind;
};

const TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  IDLE: ["INITIALIZING"],
  INITIALIZING: ["MONITORING", "FAILED", "STOPPED"],
  MONITORING: ["OBSERVATION_RECORDED", "FAILED", "STOPPED"],
  OBSERVATION_RECORDED: ["OPPORTUNITY_DETECTED", "ANALYZING", "COMPLETED", "FAILED", "STOPPED"],
  OPPORTUNITY_DETECTED: ["ANALYZING", "FAILED", "STOPPED"],
  ANALYZING: ["ANALYSIS_COMPLETED", "FAILED", "STOPPED"],
  ANALYSIS_COMPLETED: ["POLICY_VALIDATION", "FAILED", "STOPPED"],
  POLICY_VALIDATION: ["POLICY_APPROVED", "POLICY_REJECTED", "FAILED", "STOPPED"],
  POLICY_APPROVED: ["PROPOSAL_CREATED", "FAILED", "STOPPED"],
  POLICY_REJECTED: ["COMPLETED", "FAILED", "STOPPED"],
  PROPOSAL_CREATED: ["AWAITING_USER_APPROVAL", "EXECUTION_BLOCKED", "FAILED", "STOPPED"],
  AWAITING_USER_APPROVAL: ["USER_APPROVED", "USER_REJECTED", "EXPIRED", "STOPPED"],
  USER_APPROVED: ["EXECUTION_BLOCKED"],
  USER_REJECTED: ["COMPLETED"],
  EXPIRED: ["COMPLETED"],
  EXECUTION_BLOCKED: ["COMPLETED"],
  COMPLETED: [],
  FAILED: [],
  STOPPED: [],
};

export class AgentControlPlaneError extends Error {
  readonly code: "INVALID_TRANSITION" | "INVALID_INPUT" | "POLICY_REJECTED" | "EMERGENCY_STOP" | "NOT_FOUND" | "UNAVAILABLE";

  constructor(
    code: AgentControlPlaneError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "AgentControlPlaneError";
  }
}

export function canTransitionAgentState(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertAgentTransition(from: AgentState, to: AgentState): void {
  if (!canTransitionAgentState(from, to)) {
    throw new AgentControlPlaneError("INVALID_TRANSITION", `Agent run cannot transition from ${from} to ${to}.`);
  }
}

export function createSnapshotHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function createIdempotencyKey(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.map(String).join("\n")).digest("hex");
}

export function createRunId(): string {
  return randomUUID();
}

export function detectCrossVenueOpportunity(input: {
  evidence: OpportunityEvidence[];
  now: number;
  maxAgeMs: number;
  minimumAbsoluteSpreadPercent: number;
}) {
  return evaluateCrossVenueOpportunities(input).opportunities;
}

export function evaluateCrossVenueOpportunities(input: {
  evidence: OpportunityEvidence[];
  now: number;
  maxAgeMs: number;
  minimumAbsoluteSpreadPercent: number;
}): {
  opportunities: Array<{
  ticker: string;
  currency: string;
  observations: OpportunityEvidence[];
  spreadPercent: number;
  reason: string;
  detectionKey: string;
  }>;
  rejectionReasons: string[];
} {
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0 ||
    !Number.isFinite(input.minimumAbsoluteSpreadPercent) || input.minimumAbsoluteSpreadPercent < 0) {
    throw new AgentControlPlaneError("INVALID_INPUT", "Opportunity thresholds are invalid.");
  }
  const grouped = new Map<string, OpportunityEvidence[]>();
  for (const evidence of input.evidence) {
    const key = `${evidence.ticker.trim().toUpperCase()}:${evidence.currency.trim().toUpperCase()}`;
    grouped.set(key, [...(grouped.get(key) ?? []), evidence]);
  }
  const opportunities: Array<{
    ticker: string;
    currency: string;
    observations: OpportunityEvidence[];
    spreadPercent: number;
    reason: string;
    detectionKey: string;
  }> = [];
  const rejectionReasons: string[] = [];
  for (const entries of grouped.values()) {
    const eligible = entries.filter((entry) => {
      const age = input.now - entry.providerTimestamp;
      return entry.verificationStatus === "VERIFIED" &&
        entry.providerTimestamp > 0 &&
        age >= 0 &&
        age <= Math.min(entry.freshnessMs, input.maxAgeMs) &&
        parseFiniteDecimal(entry.normalizedSharePrice) !== null &&
        Number(entry.normalizedSharePrice) > 0;
    });
    if (eligible.length < 2) {
      rejectionReasons.push("Fewer than two fresh, verified observations are available for this asset.");
      continue;
    }
    const priceKinds = new Map<string, OpportunityEvidence[]>();
    for (const entry of eligible) {
      priceKinds.set(entry.priceKind, [...(priceKinds.get(entry.priceKind) ?? []), entry]);
    }
    let comparablePairFound = false;
    for (const [priceKind, kindEntries] of priceKinds) {
      const byPlatform = new Map<string, OpportunityEvidence>();
      for (const entry of kindEntries) {
        if (!byPlatform.has(entry.platform)) byPlatform.set(entry.platform, entry);
      }
      if (byPlatform.size < 2) continue;
      comparablePairFound = true;
      const selected = [...byPlatform.values()].sort((first, second) =>
        first.platform.localeCompare(second.platform));
      const prices = selected.map((entry) => Number(entry.normalizedSharePrice));
      const low = Math.min(...prices);
      const high = Math.max(...prices);
      const spreadPercent = (high / low - 1) * 100;
      if (spreadPercent < input.minimumAbsoluteSpreadPercent) {
        rejectionReasons.push(`Observed ${priceKind.toLowerCase()} spread is below the configured detection threshold.`);
        continue;
      }
      if (spreadPercent > MAX_RELIABLE_GAP_PERCENT) {
        rejectionReasons.push(`Observed spread exceeds WOLV's ${MAX_RELIABLE_GAP_PERCENT}% reliability cap.`);
        continue;
      }
      const ticker = selected[0].ticker.trim().toUpperCase();
      const detectionKey = createIdempotencyKey([
        "cross-venue",
        ticker,
        selected.map((entry) => entry.observationId).sort().join(","),
      ]);
      opportunities.push({
        ticker,
        currency: selected[0].currency,
        observations: selected,
        spreadPercent,
        reason: `Observed ${spreadPercent.toFixed(4)}% ${priceKind.toLowerCase()} price difference across ${selected.map((entry) => entry.platform).join(" and ")}. This is not guaranteed profit.`,
        detectionKey,
      });
    }
    if (!comparablePairFound) {
      rejectionReasons.push("Observations do not include two distinct venues with a comparable price type.");
    }
  }
  if (grouped.size === 0) rejectionReasons.push("No market observations are available for this watchlist.");
  return { opportunities, rejectionReasons: [...new Set(rejectionReasons)] };
}

export function validateMarketObservation(
  observation: MarketObservationInput,
  now: number,
  maxAgeMs: number,
): string[] {
  const errors: string[] = [];
  if (!isPositiveDecimal(observation.price)) errors.push("Observed price must be a positive decimal.");
  for (const [label, value] of [
    ["reference price", observation.referencePrice],
    ["bid", observation.bid],
    ["ask", observation.ask],
    ["spread", observation.spreadPercent],
  ] as const) {
    if (value !== null && !isFiniteDecimal(value)) errors.push(`${label} must be a finite decimal.`);
  }
  if (!Number.isSafeInteger(observation.providerTimestamp) || observation.providerTimestamp <= 0 ||
    observation.providerTimestamp > now + 30_000) errors.push("Provider timestamp is invalid.");
  if (!Number.isSafeInteger(observation.ingestedAt) || observation.ingestedAt < observation.providerTimestamp) {
    errors.push("Ingestion timestamp must be valid and no earlier than provider time.");
  }
  if (!Number.isSafeInteger(observation.freshnessMs) || observation.freshnessMs <= 0) {
    errors.push("Freshness duration must be positive.");
  } else if (now - observation.providerTimestamp > Math.min(observation.freshnessMs, maxAgeMs)) {
    errors.push("Market observation is stale.");
  }
  if (observation.priceKind === "EXECUTABLE" && observation.bid === null && observation.ask === null) {
    errors.push("Executable price observations require a supplied bid or ask.");
  }
  if (observation.priceKind !== "INDICATIVE" && observation.priceKind !== "EXECUTABLE") {
    errors.push("Price kind is unsupported.");
  }
  if (!["VERIFIED", "UNVERIFIED", "REJECTED"].includes(observation.verificationStatus)) {
    errors.push("Verification status is unsupported.");
  }
  if (!observation.source.trim() || !observation.currency.trim() || !observation.idempotencyKey.trim()) {
    errors.push("Market observation provenance and idempotency key are required.");
  }
  return errors;
}

export function evaluateRiskPolicy(input: {
  policy: RiskPolicy;
  assetKey: string;
  direction: AgentDirection;
  notional: string;
  dailyExposure: string;
  slippageBps: number;
  referenceDeviationPercent: number | null;
  dataFresh: boolean;
  quoteExpiresAt: number | null;
  availableBalance: string | null;
  session: string;
  now: number;
}): PolicyDecision {
  const { policy } = input;
  const refusalReasons: string[] = [];
  if (validateRiskPolicy(policy, input.now).length > 0) {
    refusalReasons.push("Risk policy configuration is invalid.");
  }
  if (policy.emergencyStop) refusalReasons.push("Emergency stop is active.");
  if (input.now >= policy.permissionExpiresAt) refusalReasons.push("Policy permission has expired.");
  if (!Array.isArray(policy.approvedAssets) ||
    !policy.approvedAssets.some((asset) =>
      typeof asset === "string" && asset.toLowerCase() === input.assetKey.toLowerCase())) {
    refusalReasons.push("Asset is not approved by policy.");
  }
  if (!Array.isArray(policy.approvedDirections) || !policy.approvedDirections.includes(input.direction)) {
    refusalReasons.push("Direction is not approved by policy.");
  }
  const notional = parseDecimalUnits(input.notional);
  const dailyExposure = parseDecimalUnits(input.dailyExposure);
  const maxOrder = parseDecimalUnits(policy.maxOrderValue);
  const maxDaily = parseDecimalUnits(policy.maxDailyExposure);
  if (notional === null || notional <= ZERO_DECIMAL_UNITS ||
    maxOrder === null || notional > maxOrder) {
    refusalReasons.push("Order value is invalid or exceeds the policy maximum.");
  }
  if (dailyExposure === null || maxDaily === null || dailyExposure < ZERO_DECIMAL_UNITS ||
    notional === null || dailyExposure + notional > maxDaily) {
    refusalReasons.push("Daily exposure would exceed the policy maximum.");
  }
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 ||
    input.slippageBps > policy.maxSlippageBps) refusalReasons.push("Slippage exceeds the policy maximum.");
  if (input.referenceDeviationPercent === null ||
    !Number.isFinite(input.referenceDeviationPercent) ||
    Math.abs(input.referenceDeviationPercent) > policy.maxReferenceDeviationPercent) {
    refusalReasons.push("Reference-price deviation is unavailable or exceeds the policy maximum.");
  }
  if (!input.dataFresh) refusalReasons.push("Required market data is unavailable or stale.");
  if (!input.session || !Array.isArray(policy.allowedSessions) || !policy.allowedSessions.includes(input.session)) {
    refusalReasons.push("Current market session is not permitted by policy.");
  }
  if (input.quoteExpiresAt === null || input.quoteExpiresAt <= input.now ||
    input.quoteExpiresAt - input.now > policy.quoteTtlMs) {
    refusalReasons.push("Quote is missing, expired, or outside the permitted freshness window.");
  }
  const availableBalance = input.availableBalance === null ? null : parseDecimalUnits(input.availableBalance);
  const minimumBalance = parseDecimalUnits(policy.minimumBalance);
  if (availableBalance === null || minimumBalance === null || availableBalance < minimumBalance) {
    refusalReasons.push("Available balance is unavailable or below the policy minimum.");
  }
  const snapshot = {
    assetKey: input.assetKey.toLowerCase(),
    direction: input.direction,
    notional: input.notional,
    dailyExposure: input.dailyExposure,
    slippageBps: input.slippageBps,
    referenceDeviationPercent: input.referenceDeviationPercent,
    dataFresh: input.dataFresh,
    quoteExpiresAt: input.quoteExpiresAt,
    availableBalance: input.availableBalance,
    session: input.session,
    now: input.now,
  };
  return {
    policyVersion: policy.version,
    inputSnapshotHash: createSnapshotHash(snapshot),
    evaluatedAt: input.now,
    accepted: refusalReasons.length === 0,
    refusalReasons,
  };
}

export function validateRiskPolicy(policy: RiskPolicy, now = Date.now()): string[] {
  const errors: string[] = [];
  if (!policy || typeof policy !== "object") return ["Risk policy must be an object."];
  if (typeof policy.version !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(policy.version)) {
    errors.push("Policy version is invalid.");
  }
  if (!Array.isArray(policy.approvedAssets) || policy.approvedAssets.length > 500 ||
    policy.approvedAssets.some((asset) => typeof asset !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(asset)) ||
    (Array.isArray(policy.approvedAssets) &&
      new Set(policy.approvedAssets.map((asset) => typeof asset === "string" ? asset.toLowerCase() : asset)).size !== policy.approvedAssets.length)) {
    errors.push("Approved asset list is invalid.");
  }
  if (!Array.isArray(policy.approvedDirections) || policy.approvedDirections.length === 0 ||
    policy.approvedDirections.some((direction) => direction !== "BUY" && direction !== "SELL") ||
    (Array.isArray(policy.approvedDirections) && new Set(policy.approvedDirections).size !== policy.approvedDirections.length)) {
    errors.push("Approved direction list is invalid.");
  }
  const maxOrder = parseDecimalUnits(policy.maxOrderValue);
  const maxDaily = parseDecimalUnits(policy.maxDailyExposure);
  const minimumBalance = parseDecimalUnits(policy.minimumBalance);
  if (maxOrder === null || maxOrder <= ZERO_DECIMAL_UNITS) errors.push("Maximum order value is invalid.");
  if (maxDaily === null || maxDaily <= ZERO_DECIMAL_UNITS) errors.push("Maximum daily exposure is invalid.");
  if (minimumBalance === null || minimumBalance < ZERO_DECIMAL_UNITS) errors.push("Minimum balance is invalid.");
  if (!Number.isSafeInteger(policy.maxSlippageBps) || policy.maxSlippageBps < 0 || policy.maxSlippageBps > 10_000) {
    errors.push("Maximum slippage is invalid.");
  }
  if (!Number.isFinite(policy.maxReferenceDeviationPercent) || policy.maxReferenceDeviationPercent < 0) {
    errors.push("Maximum reference-price deviation is invalid.");
  }
  if (!Array.isArray(policy.allowedSessions) || policy.allowedSessions.length === 0 ||
    policy.allowedSessions.some((session) => typeof session !== "string" || !/^[A-Z0-9_-]{1,32}$/.test(session)) ||
    (Array.isArray(policy.allowedSessions) && new Set(policy.allowedSessions).size !== policy.allowedSessions.length)) {
    errors.push("Allowed market sessions are invalid.");
  }
  if (!Number.isSafeInteger(policy.quoteTtlMs) || policy.quoteTtlMs < 1_000 || policy.quoteTtlMs > 300_000) {
    errors.push("Quote time-to-live must be between 1 second and 5 minutes.");
  }
  if (!Number.isSafeInteger(policy.permissionExpiresAt) || policy.permissionExpiresAt <= 0) {
    errors.push("Permission expiration is invalid.");
  } else if (policy.permissionExpiresAt <= now ||
    policy.permissionExpiresAt > now + MAX_POLICY_PERMISSION_MS) {
    errors.push("Policy permission must be future-dated and no more than 30 minutes.");
  }
  if (typeof policy.emergencyStop !== "boolean") errors.push("Emergency-stop policy must be explicit.");
  return errors;
}

export function buildEvidenceBackedAnalysis(input: {
  opportunity: { id: string; assetId: string; spreadPercent: number; detectionReason: string };
  evidenceIds: string[];
  historicalComparisons: Array<{ observationId: string; observedAt: number; price: string; source: string }>;
  dataFresh: boolean;
  assumptions?: string[];
}) {
  if (input.evidenceIds.length === 0) {
    throw new AgentControlPlaneError("INVALID_INPUT", "Analysis requires evidence references.");
  }
  return {
    marketInterpretation: `Observed cross-venue spread: ${input.opportunity.spreadPercent.toFixed(4)}%.`,
    opportunityExplanation: input.opportunity.detectionReason,
    historicalComparison: input.historicalComparisons.length
      ? `Compared with ${input.historicalComparisons.length} stored historical observation(s).`
      : "No prior observations are available for comparison.",
    upsideScenario: "A price difference may narrow; this is a scenario, not a forecast.",
    downsideScenario: "The difference may widen or disappear before an executable quote is available.",
    executionRisks: ["Fees, slippage, liquidity, and market-session differences may eliminate the observed spread."],
    dataLimitations: input.dataFresh
      ? ["Historical coverage may be incomplete."]
      : ["One or more required observations are stale or unavailable."],
    invalidatingConditions: ["A fresh executable quote does not confirm the observed price difference."],
    suggestedNextAction: "Obtain fresh verified market evidence and policy review; no order is submitted.",
    evidenceReferences: [...new Set(input.evidenceIds)],
    assumptions: input.assumptions ?? [],
    conclusionType: "MODEL_INTERPRETATION",
    chainOfThoughtStored: false,
  };
}

function isPositiveDecimal(value: string): boolean {
  const parsed = parseFiniteDecimal(value);
  return parsed !== null && parsed > 0;
}

function isFiniteDecimal(value: string): boolean {
  return parseFiniteDecimal(value) !== null;
}

function parseFiniteDecimal(value: string): number | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDecimalUnits(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 64 ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  try {
    return BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(18, "0"));
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([first], [second]) => first.localeCompare(second));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
