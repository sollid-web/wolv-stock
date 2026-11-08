import test from "node:test";
import assert from "node:assert/strict";
import {
  createExecutionIntent,
  evaluateRiskPolicy,
  transitionExecutionIntent,
  isTerminalExecutionState,
  canRetrySubmission,
} from "../services/autonomy/execution-domain.ts";

const now = "2026-11-08T12:00:00.000Z";
const baseIntent = () => createExecutionIntent({
  id: "intent-1",
  idempotencyKey: "strategy-1:user-1:asset-1:window-1",
  ownerId: "user-1",
  walletAddress: "0xABCDEF",
  chainId: "56",
  tokenAddress: "0xToken",
  inputTokenAddress: "0xUSDT",
  amountIn: "100000000",
  strategyId: "rwa-gap",
  strategyVersion: "v1",
  policyVersion: "p1",
  now,
});

const policy = {
  enabled: true,
  allowedChainIds: ["56"],
  allowedTokenAddresses: ["0xtoken"],
  allowedInputTokenAddresses: ["0xusdt"],
  maxOrderAmount: "200000000",
  maxPositionAmount: "500000000",
  maxDailySpend: "1000000000",
  maxSlippageBps: 100,
  maxPriceImpactBps: 150,
  maxQuoteAgeMs: 30_000,
  maxGasCost: "5000000000000000",
  minExpectedEdgeBps: 40,
};

const candidate = {
  chainId: "56",
  tokenAddress: "0xTOKEN",
  inputTokenAddress: "0xUSDT",
  amountIn: "100000000",
  currentPosition: "100000000",
  dailySpend: "200000000",
  quoteObservedAt: "2026-11-08T11:59:50.000Z",
  now,
  slippageBps: 50,
  priceImpactBps: 60,
  gasCost: "1000000000000000",
  expectedEdgeBps: 90,
};

test("creates a normalized, versioned intent without side effects", () => {
  const intent = baseIntent();
  assert.equal(intent.state, "DISCOVERED");
  assert.equal(intent.version, 0);
  assert.equal(intent.walletAddress, "0xabcdef");
  assert.equal(intent.events.length, 1);
});

test("approves a candidate inside all deterministic policy bounds", () => {
  assert.deepEqual(evaluateRiskPolicy(policy, candidate), { allowed: true, code: "RISK_APPROVED" });
});

test("rejects disabled strategies and unapproved chains", () => {
  assert.equal(evaluateRiskPolicy({ ...policy, enabled: false }, candidate).code, "STRATEGY_DISABLED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, chainId: "1" }).code, "CHAIN_NOT_ALLOWED");
});

test("rejects order, position, daily spend, gas, slippage and impact limit breaches", () => {
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, amountIn: "300000000" }).code, "ORDER_LIMIT_EXCEEDED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, currentPosition: "450000000" }).code, "POSITION_LIMIT_EXCEEDED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, dailySpend: "950000000" }).code, "DAILY_SPEND_LIMIT_EXCEEDED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, gasCost: "6000000000000000" }).code, "GAS_LIMIT_EXCEEDED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, slippageBps: 101 }).code, "SLIPPAGE_LIMIT_EXCEEDED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, priceImpactBps: 151 }).code, "PRICE_IMPACT_LIMIT_EXCEEDED");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, expectedEdgeBps: 39 }).code, "EDGE_TOO_LOW");
});

test("rejects stale and future quotes and malformed numeric values", () => {
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, quoteObservedAt: "2026-11-08T11:58:00.000Z" }).code, "QUOTE_STALE");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, quoteObservedAt: "2026-11-08T12:01:00.000Z" }).code, "QUOTE_STALE");
  assert.equal(evaluateRiskPolicy(policy, { ...candidate, amountIn: "1.2" }).code, "INVALID_NUMERIC_INPUT");
});

test("transitions are explicit, immutable and versioned", () => {
  const first = baseIntent();
  const second = transitionExecutionIntent(first, "QUALIFIED", { type: "CANDIDATE_QUALIFIED", at: "2026-11-08T12:00:01.000Z", actor: "worker" });
  assert.equal(first.state, "DISCOVERED");
  assert.equal(second.state, "QUALIFIED");
  assert.equal(second.version, 1);
  assert.equal(second.events.length, 2);
});

test("rejects illegal, backward-time and post-terminal transitions", () => {
  const intent = baseIntent();
  assert.throws(() => transitionExecutionIntent(intent, "SUBMITTED", { type: "BAD", at: now, actor: "worker" }), /Invalid execution transition/);
  assert.throws(() => transitionExecutionIntent(intent, "QUALIFIED", { type: "OLD", at: "2026-11-08T11:59:00.000Z", actor: "worker" }), /cannot move backwards/);

  const path = [
    "QUALIFIED", "RISK_APPROVED", "BUDGET_RESERVED", "QUOTED",
    "SIMULATED", "SUBMISSION_PENDING", "SUBMITTED",
    "SETTLEMENT_PENDING", "SETTLED",
  ];
  let current = intent;
  path.forEach((state, index) => {
    const seconds = String(index + 1).padStart(2, "0");
    current = transitionExecutionIntent(current, state, {
      type: `STEP_${index + 1}`,
      at: `2026-11-08T12:00:${seconds}.000Z`,
      actor: "worker",
    });
  });

  assert.equal(isTerminalExecutionState(current.state), true);
  assert.throws(() => transitionExecutionIntent(current, "FAILED", {
    type: "late", at: "2026-11-08T12:00:20.000Z", actor: "worker",
  }), /terminal state/);
});

test("ambiguous submissions are never eligible for blind retry", () => {
  assert.equal(canRetrySubmission("QUOTED"), true);
  assert.equal(canRetrySubmission("SUBMISSION_PENDING"), false);
  assert.equal(canRetrySubmission("UNKNOWN_REQUIRES_RECONCILIATION"), false);
  assert.equal(canRetrySubmission("SUBMITTED"), false);
});
