/**
 * Pure, deterministic execution-domain primitives.
 *
 * This module intentionally has no provider, wallet, network, database, or
 * framework dependencies. It cannot sign or submit a transaction.
 */

export const EXECUTION_STATES = [
  "DISCOVERED",
  "QUALIFIED",
  "QUOTE_REQUIRED",
  "RISK_APPROVED",
  "BUDGET_RESERVED",
  "QUOTED",
  "SIMULATED",
  "PAPER_FILLED",
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
  maxGasCostUsd: string;
  minExpectedEdgeBps: number;
  maxOpenPositions?: number;
  maxDailyRealizedLoss?: string;
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
  gasCostUsd: string;
  expectedEdgeBps: number;
  currentOpenPositions?: number;
  dailyRealizedLoss?: string;
};

export type RiskDecision =
  | { allowed: true; code: "RISK_APPROVED" }
  | { allowed: false; code: string; reason: string };

const TERMINAL = new Set<ExecutionState>([
  "SETTLED",
  "PAPER_FILLED",
  "REJECTED_POLICY",
  "EXPIRED",
  "PROVIDER_REJECTED",
  "FAILED",
]);

const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  DISCOVERED: ["QUALIFIED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  QUALIFIED: ["QUOTE_REQUIRED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  QUOTE_REQUIRED: ["QUOTED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  RISK_APPROVED: ["BUDGET_RESERVED", "QUOTE_REQUIRED", "REJECTED_POLICY", "EXPIRED", "SECURITY_HOLD"],
  BUDGET_RESERVED: ["SIMULATED", "QUOTE_REQUIRED", "REJECTED_POLICY", "EXPIRED", "FAILED", "SECURITY_HOLD"],
  QUOTED: ["RISK_APPROVED", "QUOTE_REQUIRED", "REJECTED_POLICY", "EXPIRED", "FAILED", "SECURITY_HOLD"],
  SIMULATED: ["PAPER_FILLED", "QUOTE_REQUIRED", "SUBMISSION_PENDING", "REJECTED_POLICY", "EXPIRED", "FAILED", "SECURITY_HOLD"],
  SUBMISSION_PENDING: ["SUBMITTED", "PROVIDER_REJECTED", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION", "SECURITY_HOLD"],
  SUBMITTED: ["SETTLEMENT_PENDING", "SETTLED", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION", "SECURITY_HOLD"],
  SETTLEMENT_PENDING: ["SETTLED", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION", "SECURITY_HOLD"],
  UNKNOWN_REQUIRES_RECONCILIATION: ["SUBMITTED", "SETTLEMENT_PENDING", "SETTLED", "PROVIDER_REJECTED", "FAILED", "SECURITY_HOLD"],
  SECURITY_HOLD: ["UNKNOWN_REQUIRES_RECONCILIATION", "FAILED"],
  SETTLED: [],
  PAPER_FILLED: [],
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

function parseFixedDecimal(value: string, field: string): bigint {
  requireNonEmpty(value, field);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/.exec(value);
  if (!match) throw new Error(`Invalid ${field}`);
  const fraction = (match[2] ?? "").padEnd(18, "0");
  return BigInt(match[1]) * BigInt("1000000000000000000") + BigInt(fraction || "0");
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
  let gasCostUsd: bigint;
  let maxGasCostUsd: bigint;
  let dailyRealizedLoss: bigint | null = null;
  let maxDailyRealizedLoss: bigint | null = null;

  try {
    amount = parsePositiveDecimal(candidate.amountIn, "candidate.amountIn");
    position = parseNonNegativeDecimal(candidate.currentPosition, "candidate.currentPosition");
    dailySpend = parseNonNegativeDecimal(candidate.dailySpend, "candidate.dailySpend");
    maxOrder = parsePositiveDecimal(policy.maxOrderAmount, "policy.maxOrderAmount");
    maxPosition = parsePositiveDecimal(policy.maxPositionAmount, "policy.maxPositionAmount");
    maxDailySpend = parsePositiveDecimal(policy.maxDailySpend, "policy.maxDailySpend");
    gasCostUsd = parseFixedDecimal(candidate.gasCostUsd, "candidate.gasCostUsd");
    maxGasCostUsd = parseFixedDecimal(policy.maxGasCostUsd, "policy.maxGasCostUsd");
    if (policy.maxDailyRealizedLoss !== undefined) {
      dailyRealizedLoss = parseNonNegativeDecimal(candidate.dailyRealizedLoss ?? "", "candidate.dailyRealizedLoss");
      maxDailyRealizedLoss = parsePositiveDecimal(policy.maxDailyRealizedLoss, "policy.maxDailyRealizedLoss");
    }
  } catch (error) {
    return { allowed: false, code: "INVALID_NUMERIC_INPUT", reason: error instanceof Error ? error.message : "Invalid numeric input" };
  }

  if (!policy.allowedChainIds.includes(candidate.chainId)) return { allowed: false, code: "CHAIN_NOT_ALLOWED", reason: "Chain is not allowlisted" };
  if (!policy.allowedTokenAddresses.map((v) => v.toLowerCase()).includes(candidate.tokenAddress.toLowerCase())) return { allowed: false, code: "TOKEN_NOT_ALLOWED", reason: "Output token is not allowlisted" };
  if (!policy.allowedInputTokenAddresses.map((v) => v.toLowerCase()).includes(candidate.inputTokenAddress.toLowerCase())) return { allowed: false, code: "INPUT_TOKEN_NOT_ALLOWED", reason: "Input token is not allowlisted" };
  if (amount > maxOrder) return { allowed: false, code: "ORDER_LIMIT_EXCEEDED", reason: "Order exceeds the maximum order amount" };
  if (position + amount > maxPosition) return { allowed: false, code: "POSITION_LIMIT_EXCEEDED", reason: "Order would exceed the maximum position" };
  if (dailySpend + amount > maxDailySpend) return { allowed: false, code: "DAILY_SPEND_LIMIT_EXCEEDED", reason: "Order would exceed the daily spend limit" };
  if (policy.maxOpenPositions !== undefined) {
    if (!Number.isSafeInteger(policy.maxOpenPositions) || policy.maxOpenPositions < 1 ||
        !Number.isSafeInteger(candidate.currentOpenPositions) || (candidate.currentOpenPositions as number) < 0) {
      return { allowed: false, code: "INVALID_POSITION_COUNT", reason: "Open-position policy evidence is missing or invalid" };
    }
    if (position === BigInt(0) && (candidate.currentOpenPositions as number) >= policy.maxOpenPositions) {
      return { allowed: false, code: "MAX_OPEN_POSITIONS_REACHED", reason: "Maximum concurrent open positions reached" };
    }
  }
  if (dailyRealizedLoss !== null && maxDailyRealizedLoss !== null && dailyRealizedLoss >= maxDailyRealizedLoss) {
    return { allowed: false, code: "DAILY_REALIZED_LOSS_LIMIT_REACHED", reason: "Daily realized-loss stop has been reached" };
  }
  if (policy.maxOpenOrders !== undefined) {
    if (!Number.isSafeInteger(policy.maxOpenOrders) || policy.maxOpenOrders < 1 ||
        !Number.isSafeInteger(candidate.currentOpenOrders) || (candidate.currentOpenOrders as number) < 0) {
      return { allowed: false, code: "INVALID_OPEN_ORDER_COUNT", reason: "Outstanding-order policy evidence is missing or invalid" };
    }
    if ((candidate.currentOpenOrders as number) >= policy.maxOpenOrders) {
      return { allowed: false, code: "MAX_OPEN_ORDERS_REACHED", reason: "Maximum concurrent outstanding orders reached" };
    }
  }
  if (gasCostUsd > maxGasCostUsd) return { allowed: false, code: "GAS_LIMIT_EXCEEDED", reason: "Estimated gas USD cost exceeds the configured maximum" };

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
