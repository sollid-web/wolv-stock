/**
 * Pure, deterministic execution-domain primitives.
 *
 * This module intentionally has no provider, wallet, network, database, or
 * framework dependencies. It cannot sign or submit a transaction.
 */

export const EXECUTION_STATES = [
  "DISCOVERED",
  "QUALIFIED",
  "RISK_APPROVED",
  "BUDGET_RESERVED",
  "QUOTED",
  "SIMULATED",
  "SUBMISSION_PENDING",
  "SUBMITTED",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "REJECTED_POLICY",
  "EXPIRED",
  "PROVIDER_REJECTED",
  "FAILED",
  "UNKNOWN_REQUIRES_RECONCILIATION",
  "SECURITY_HOLD",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export type ExecutionEvent = {
  type: string;
  at: string;
  actor: "system" | "worker" | "provider" | "user";
  detail?: Record<string, unknown>;
};

export type ExecutionIntent = {
  id: string;
  idempotencyKey: string;
  ownerId: string;
  walletAddress: string;
  chainId: string;
  tokenAddress: string;
  inputTokenAddress: string;
  amountIn: string;
  strategyId: string;
  strategyVersion: string;
  policyVersion: string;
  state: ExecutionState;
  createdAt: string;
  updatedAt: string;
  version: number;
  reservedAmount?: string;
  quoteId?: string;
  quoteExpiresAt?: string;
  transactionHash?: string;
  rejectionCode?: string;
  events: ExecutionEvent[];
};

export type RiskPolicy = {
  enabled: boolean;
  allowedChainIds: string[];
  allowedTokenAddresses: string[];
  allowedInputTokenAddresses: string[];
  maxOrderAmount: string;
  maxPositionAmount: string;
  maxDailySpend: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxQuoteAgeMs: number;
  maxGasCost: string;
  minExpectedEdgeBps: number;
};

export type RiskCandidate = {
  chainId: string;
  tokenAddress: string;
  inputTokenAddress: string;
  amountIn: string;
  currentPosition: string;
  dailySpend: string;
  quoteObservedAt: string;
  now: string;
  slippageBps: number;
  priceImpactBps: number;
  gasCost: string;
  expectedEdgeBps: number;
};

export type RiskDecision =
  | { allowed: true; code: "RISK_APPROVED" }
  | { allowed: false; code: string; reason: string };

const TERMINAL = new Set<ExecutionState>([
  "SETTLED",
  "REJECTED_POLICY",
  "EXPIRED",
  "PROVIDER_REJECTED",
  "FAILED",
]);

const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  DISCOVERED: ["QUALIFIED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  QUALIFIED: ["RISK_APPROVED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  RISK_APPROVED: ["BUDGET_RESERVED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  BUDGET_RESERVED: ["QUOTED", "REJECTED_POLICY", "EXPIRED", "FAILED", "SECURITY_HOLD"],
  QUOTED: ["SIMULATED", "SUBMISSION_PENDING", "REJECTED_POLICY", "EXPIRED", "FAILED", "SECURITY_HOLD"],
  SIMULATED: ["SUBMISSION_PENDING", "REJECTED_POLICY", "EXPIRED", "FAILED", "SECURITY_HOLD"],
  SUBMISSION_PENDING: ["SUBMITTED", "PROVIDER_REJECTED", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION", "SECURITY_HOLD"],
  SUBMITTED: ["SETTLEMENT_PENDING", "SETTLED", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION", "SECURITY_HOLD"],
  SETTLEMENT_PENDING: ["SETTLED", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION", "SECURITY_HOLD"],
  UNKNOWN_REQUIRES_RECONCILIATION: ["SUBMITTED", "SETTLEMENT_PENDING", "SETTLED", "PROVIDER_REJECTED", "FAILED", "SECURITY_HOLD"],
  SECURITY_HOLD: ["UNKNOWN_REQUIRES_RECONCILIATION", "FAILED"],
  SETTLED: [],
  REJECTED_POLICY: [],
  EXPIRED: [],
  PROVIDER_REJECTED: [],
  FAILED: [],
};

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${field}`);
  }
}

function parsePositiveDecimal(value: string, field: string): bigint {
  requireNonEmpty(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${field}`);
  const parsed = BigInt(value);
  if (parsed <= BigInt(0)) throw new Error(`${field} must be greater than zero`);
  return parsed;
}

function parseNonNegativeDecimal(value: string, field: string): bigint {
  requireNonEmpty(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${field}`);
  return BigInt(value);
}

function validTimestamp(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid ${field}`);
  return time;
}

export function createExecutionIntent(input: Omit<ExecutionIntent, "state" | "createdAt" | "updatedAt" | "version" | "events"> & { now: string }): ExecutionIntent {
  for (const [field, value] of Object.entries({
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    ownerId: input.ownerId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    inputTokenAddress: input.inputTokenAddress,
    amountIn: input.amountIn,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    policyVersion: input.policyVersion,
  })) requireNonEmpty(value, field);

  parsePositiveDecimal(input.amountIn, "amountIn");
  validTimestamp(input.now, "now");

  return {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    ownerId: input.ownerId,
    walletAddress: input.walletAddress.toLowerCase(),
    chainId: input.chainId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    inputTokenAddress: input.inputTokenAddress.toLowerCase(),
    amountIn: input.amountIn,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    policyVersion: input.policyVersion,
    state: "DISCOVERED",
    createdAt: input.now,
    updatedAt: input.now,
    version: 0,
    events: [{ type: "INTENT_CREATED", at: input.now, actor: "worker" }],
  };
}

export function evaluateRiskPolicy(policy: RiskPolicy, candidate: RiskCandidate): RiskDecision {
  if (!policy.enabled) return { allowed: false, code: "STRATEGY_DISABLED", reason: "Autonomous strategy is disabled" };

  let amount: bigint;
  let position: bigint;
  let dailySpend: bigint;
  let maxOrder: bigint;
  let maxPosition: bigint;
  let maxDailySpend: bigint;
  let gasCost: bigint;
  let maxGasCost: bigint;

  try {
    amount = parsePositiveDecimal(candidate.amountIn, "candidate.amountIn");
    position = parseNonNegativeDecimal(candidate.currentPosition, "candidate.currentPosition");
    dailySpend = parseNonNegativeDecimal(candidate.dailySpend, "candidate.dailySpend");
    maxOrder = parsePositiveDecimal(policy.maxOrderAmount, "policy.maxOrderAmount");
    maxPosition = parsePositiveDecimal(policy.maxPositionAmount, "policy.maxPositionAmount");
    maxDailySpend = parsePositiveDecimal(policy.maxDailySpend, "policy.maxDailySpend");
    gasCost = parseNonNegativeDecimal(candidate.gasCost, "candidate.gasCost");
    maxGasCost = parsePositiveDecimal(policy.maxGasCost, "policy.maxGasCost");
  } catch (error) {
    return { allowed: false, code: "INVALID_NUMERIC_INPUT", reason: error instanceof Error ? error.message : "Invalid numeric input" };
  }

  if (!policy.allowedChainIds.includes(candidate.chainId)) return { allowed: false, code: "CHAIN_NOT_ALLOWED", reason: "Chain is not allowlisted" };
  if (!policy.allowedTokenAddresses.map((v) => v.toLowerCase()).includes(candidate.tokenAddress.toLowerCase())) return { allowed: false, code: "TOKEN_NOT_ALLOWED", reason: "Output token is not allowlisted" };
  if (!policy.allowedInputTokenAddresses.map((v) => v.toLowerCase()).includes(candidate.inputTokenAddress.toLowerCase())) return { allowed: false, code: "INPUT_TOKEN_NOT_ALLOWED", reason: "Input token is not allowlisted" };
  if (amount > maxOrder) return { allowed: false, code: "ORDER_LIMIT_EXCEEDED", reason: "Order exceeds the maximum order amount" };
  if (position + amount > maxPosition) return { allowed: false, code: "POSITION_LIMIT_EXCEEDED", reason: "Order would exceed the maximum position" };
  if (dailySpend + amount > maxDailySpend) return { allowed: false, code: "DAILY_SPEND_LIMIT_EXCEEDED", reason: "Order would exceed the daily spend limit" };
  if (gasCost > maxGasCost) return { allowed: false, code: "GAS_LIMIT_EXCEEDED", reason: "Estimated gas exceeds the configured maximum" };

  const quoteAge = validTimestamp(candidate.now, "candidate.now") - validTimestamp(candidate.quoteObservedAt, "candidate.quoteObservedAt");
  if (quoteAge < 0 || quoteAge > policy.maxQuoteAgeMs) return { allowed: false, code: "QUOTE_STALE", reason: "Quote timestamp is in the future or outside the freshness budget" };
  if (!Number.isInteger(candidate.slippageBps) || candidate.slippageBps < 0 || candidate.slippageBps > policy.maxSlippageBps) return { allowed: false, code: "SLIPPAGE_LIMIT_EXCEEDED", reason: "Slippage exceeds the configured maximum" };
  if (!Number.isInteger(candidate.priceImpactBps) || candidate.priceImpactBps < 0 || candidate.priceImpactBps > policy.maxPriceImpactBps) return { allowed: false, code: "PRICE_IMPACT_LIMIT_EXCEEDED", reason: "Price impact exceeds the configured maximum" };
  if (!Number.isInteger(candidate.expectedEdgeBps) || candidate.expectedEdgeBps < policy.minExpectedEdgeBps) return { allowed: false, code: "EDGE_TOO_LOW", reason: "Expected edge does not cover the configured minimum" };

  return { allowed: true, code: "RISK_APPROVED" };
}

export function transitionExecutionIntent(
  intent: ExecutionIntent,
  nextState: ExecutionState,
  event: Omit<ExecutionEvent, "at"> & { at: string },
): ExecutionIntent {
  if (TERMINAL.has(intent.state)) throw new Error(`Cannot transition terminal state ${intent.state}`);
  if (!TRANSITIONS[intent.state].includes(nextState)) {
    throw new Error(`Invalid execution transition: ${intent.state} -> ${nextState}`);
  }
  validTimestamp(event.at, "event.at");
  if (Date.parse(event.at) < Date.parse(intent.updatedAt)) throw new Error("Event timestamp cannot move backwards");

  return {
    ...intent,
    state: nextState,
    updatedAt: event.at,
    version: intent.version + 1,
    ...(nextState === "REJECTED_POLICY" ? { rejectionCode: String(event.detail?.code ?? "POLICY_REJECTED") } : {}),
    events: [...intent.events, { ...event }],
  };
}

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL.has(state);
}

export function canRetrySubmission(state: ExecutionState): boolean {
  // Never retry an ambiguous submission: reconcile provider + chain state first.
  return state === "BUDGET_RESERVED" || state === "QUOTED" || state === "SIMULATED";
}
