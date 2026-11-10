import { randomUUID } from "node:crypto";
import { getValidatedBinanceRoundTripQuote } from "../services/autonomy/binance-roundtrip-provider.ts";
import { readMarketOpportunities } from "../services/marketPriceCache.ts";
import {
  createExecutionIntent, transitionExecutionIntent, evaluateRiskPolicy, isTerminalExecutionState,
  type ExecutionIntent,
} from "../services/autonomy/execution-domain.ts";
import {
  loadPortfolioPolicy, reservePortfolioBudget, releasePortfolioBudget, commitPaperQuoteFill,
} from "../services/autonomy/supabase-portfolio-ledger.ts";
import {
  acquireExecutionLease, compareAndSwapExecutionIntent,
  createExecutionIntentIfAbsent, releaseExecutionLease,
} from "../services/autonomy/supabase-execution-repository.ts";

const INTERVAL_MS = Math.max(10_000, Number(process.env.WOLV_AUTONOMY_POLL_MS ?? 15_000));
const OWNER_ID = required("WOLV_AUTONOMY_OWNER_ID");
const WALLET = required("WOLV_AUTONOMY_WALLET_ADDRESS");
const INPUT_TOKEN = required("WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS");
const AMOUNT_IN = required("WOLV_AUTONOMY_ORDER_AMOUNT_BASE_UNITS");
const STRATEGY_ID = process.env.WOLV_AUTONOMY_STRATEGY_ID ?? "rwa-dislocation-v1";
const STRATEGY_VERSION = process.env.WOLV_AUTONOMY_STRATEGY_VERSION ?? "1";
const POLICY_VERSION = process.env.WOLV_AUTONOMY_POLICY_VERSION ?? "paper-policy-1";
const LEASE_MS = 30_000;
const SLIPPAGE_BPS = Number(process.env.WOLV_AUTONOMY_SLIPPAGE_BPS ?? 50);
if (!Number.isInteger(SLIPPAGE_BPS) || SLIPPAGE_BPS < 0 || SLIPPAGE_BPS > 5000) {
  throw new Error("WOLV_AUTONOMY_SLIPPAGE_BPS must be an integer from 0 to 5000.");
}
const NETWORK_FEE_BUFFER_BPS = Number(process.env.WOLV_AUTONOMY_NETWORK_FEE_BUFFER_BPS ?? 10_000);
if (!Number.isInteger(NETWORK_FEE_BUFFER_BPS) || NETWORK_FEE_BUFFER_BPS < 0 || NETWORK_FEE_BUFFER_BPS > 100_000) {
  throw new Error("WOLV_AUTONOMY_NETWORK_FEE_BUFFER_BPS must be an integer from 0 to 100000.");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(OWNER_ID)) {
  throw new Error("WOLV_AUTONOMY_OWNER_ID must be a UUID.");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(WALLET) || !/^0x[a-fA-F0-9]{40}$/.test(INPUT_TOKEN)) {
  throw new Error("WOLV_AUTONOMY_WALLET_ADDRESS and WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS must be EVM addresses.");
}

function next(intent: ExecutionIntent, state: Parameters<typeof transitionExecutionIntent>[1], type: string, detail?: Record<string, unknown>) {
  return transitionExecutionIntent(intent, state, {
    type, at: new Date().toISOString(), actor: "worker", ...(detail ? { detail } : {}),
  });
}

async function persistTransition(intent: ExecutionIntent, expectedVersion: number) {
  const saved = await compareAndSwapExecutionIntent(intent, expectedVersion);
  if (!saved) throw new Error(`Execution intent ${intent.id} changed concurrently; refusing stale write.`);
}

function roundTripEvidence(intent: ExecutionIntent): Record<string, unknown> {
  const event = [...intent.events].reverse().find((item) => item.type === "BINANCE_ROUNDTRIP_QUOTES_VALIDATED");
  if (!event || !event.detail || typeof event.detail !== "object") {
    throw new Error("Execution intent is missing its immutable round-trip quote evidence.");
  }
  return event.detail as Record<string, unknown>;
}

function evidenceString(detail: Record<string, unknown>, key: string): string {
  const value = detail[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("Round-trip evidence is missing " + key);
  return value;
}

function evidenceNumber(detail: Record<string, unknown>, key: string): number {
  const value = Number(detail[key]);
  if (!Number.isSafeInteger(value)) throw new Error("Round-trip evidence has invalid " + key);
  return value;
}

async function readPortfolioPolicy(intent: ExecutionIntent) {
  try {
    return await loadPortfolioPolicy(intent.ownerId, { chainId: intent.chainId, tokenAddress: intent.tokenAddress });
  } catch (error) {
    console.warn("[autonomy-worker] portfolio-policy-unavailable " + intent.id + ": " +
      (error instanceof Error ? error.message : "unknown error"));
    return null;
  }
}

async function advanceIntent(intent: ExecutionIntent): Promise<ExecutionIntent> {
  if (intent.state === "QUALIFIED") {
    const version = intent.version;
    intent = next(intent, "QUOTE_REQUIRED", "EXECUTABLE_QUOTE_REQUIRED", {
      mode: "PAPER_ONLY", blocker: "AWAITING_VALIDATED_BINANCE_ROUNDTRIP_QUOTES",
    });
    await persistTransition(intent, version);
  }

  if (intent.state === "QUOTE_REQUIRED") {
    if (!process.env.BINANCE_API_KEY?.trim() || !process.env.BINANCE_SECRET_KEY?.trim()) {
      console.info("[autonomy-worker] quote-required " + intent.id + " blocker=BINANCE_API_CREDENTIALS_MISSING");
      return intent;
    }
    const feePolicy = await readPortfolioPolicy(intent);
    const feeBufferBps = feePolicy?.networkFeeBufferBps ?? NETWORK_FEE_BUFFER_BPS;
    const roundTrip = await getValidatedBinanceRoundTripQuote({
      chainId: intent.chainId, walletAddress: intent.walletAddress,
      inputTokenAddress: intent.inputTokenAddress, outputTokenAddress: intent.tokenAddress,
      amountIn: intent.amountIn, slippageBps: SLIPPAGE_BPS,
      networkFeeBufferBps: feeBufferBps,
    });
    if (Date.parse(roundTrip.expiresAt) <= Date.now()) {
      throw new Error("Binance round-trip quotes expired before they could be persisted.");
    }
    const quote = roundTrip.buy;
    const version = intent.version;
    intent = {
      ...next(intent, "QUOTED", "BINANCE_ROUNDTRIP_QUOTES_VALIDATED", {
        provider: roundTrip.provider, networkFeeBufferBps: feeBufferBps,
        buyQuoteId: roundTrip.buy.quoteId, buyVendor: roundTrip.buy.vendorName,
        buyAmountIn: roundTrip.buy.amountIn, expectedAmountOut: roundTrip.buy.expectedAmountOut,
        buyPriceImpactBps: roundTrip.buy.priceImpactBps, buyGasEstimateRaw: roundTrip.buy.gasEstimateRaw,
        buyEstimatedNetworkFeeUsd: roundTrip.buy.estimatedNetworkFeeUsd,
        buyApprovalTarget: roundTrip.buy.approvalTarget, buyObservedAt: roundTrip.buy.observedAt,
        sellQuoteId: roundTrip.sell.quoteId, sellVendor: roundTrip.sell.vendorName,
        sellAmountIn: roundTrip.sell.amountIn, expectedExitAmountOut: roundTrip.sell.expectedAmountOut,
        sellPriceImpactBps: roundTrip.sell.priceImpactBps, sellGasEstimateRaw: roundTrip.sell.gasEstimateRaw,
        sellEstimatedNetworkFeeUsd: roundTrip.sell.estimatedNetworkFeeUsd,
        sellApprovalTarget: roundTrip.sell.approvalTarget, sellObservedAt: roundTrip.sell.observedAt,
        indicativeRoundTripEdgeBps: roundTrip.indicativeRoundTripEdgeBps,
        bufferedNetworkFeesUsd: roundTrip.bufferedNetworkFeesUsd,
        approvalRequired: roundTrip.approvalRequired, slippageBps: SLIPPAGE_BPS,
        expiresAt: roundTrip.expiresAt, routeFingerprint: roundTrip.routeFingerprint,
        rawEvidenceRef: roundTrip.rawEvidenceRef,
      }),
      quoteId: quote.quoteId,
      quoteExpiresAt: roundTrip.expiresAt,
    };
    await persistTransition(intent, version);
    console.info("[autonomy-worker] roundtrip-quoted " + intent.id +
      " edgeBps=" + roundTrip.indicativeRoundTripEdgeBps +
      " bufferedNetworkFeesUsd=" + roundTrip.bufferedNetworkFeesUsd +
      " expiresAt=" + roundTrip.expiresAt + " mode=PAPER_ONLY");
  }

  if (intent.state === "QUOTED") {
    const portfolio = await readPortfolioPolicy(intent);
    if (!portfolio) {
      console.info("[autonomy-worker] quote-held " + intent.id + " blocker=PORTFOLIO_POLICY_NOT_CONFIGURED");
      return intent;
    }
    if (portfolio.policyVersion !== intent.policyVersion) {
      console.info("[autonomy-worker] quote-held " + intent.id + " blocker=POLICY_VERSION_MISMATCH");
      return intent;
    }
    if (!portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
      console.info("[autonomy-worker] quote-held " + intent.id + " blocker=STRATEGY_DISABLED_OR_EMERGENCY_STOP");
      return intent;
    }
    const detail = roundTripEvidence(intent);
    const feeBuffer = evidenceNumber(detail, "networkFeeBufferBps");
    if (feeBuffer !== portfolio.networkFeeBufferBps || !intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now()) {
      const version = intent.version;
      intent = next(intent, "QUOTE_REQUIRED", "ROUNDTRIP_QUOTE_REFRESH_REQUIRED", {
        reason: feeBuffer !== portfolio.networkFeeBufferBps ? "NETWORK_FEE_POLICY_CHANGED" : "QUOTE_EXPIRED",
      });
      await persistTransition(intent, version);
      return intent;
    }
    const buyObservedAt = evidenceString(detail, "buyObservedAt");
    const sellObservedAt = evidenceString(detail, "sellObservedAt");
    const observedAtMs = Math.min(Date.parse(buyObservedAt), Date.parse(sellObservedAt));
    const candidate = {
      chainId: intent.chainId, tokenAddress: intent.tokenAddress, inputTokenAddress: intent.inputTokenAddress,
      amountIn: intent.amountIn, currentPosition: portfolio.currentPositionInputUnits,
      dailySpend: portfolio.dailySpendIncludingReservations,
      quoteObservedAt: new Date(observedAtMs).toISOString(), now: new Date().toISOString(),
      slippageBps: evidenceNumber(detail, "slippageBps"),
      priceImpactBps: Math.max(evidenceNumber(detail, "buyPriceImpactBps"), evidenceNumber(detail, "sellPriceImpactBps")),
      gasCostUsd: evidenceString(detail, "bufferedNetworkFeesUsd"),
      expectedEdgeBps: evidenceNumber(detail, "indicativeRoundTripEdgeBps"),
    };
    const decision = evaluateRiskPolicy(portfolio.riskPolicy, candidate);
    const version = intent.version;
    if (!decision.allowed) {
      const target = decision.code === "QUOTE_STALE" ? "QUOTE_REQUIRED" : "REJECTED_POLICY";
      intent = next(intent, target, decision.code, {
        reason: decision.reason, policyVersion: portfolio.policyVersion,
        expectedEdgeBps: candidate.expectedEdgeBps, gasCostUsd: candidate.gasCostUsd,
      });
      await persistTransition(intent, version);
      return intent;
    }
    intent = next(intent, "RISK_APPROVED", "RISK_POLICY_APPROVED", {
      policyVersion: portfolio.policyVersion, expectedEdgeBps: candidate.expectedEdgeBps,
      bufferedNetworkFeesUsd: candidate.gasCostUsd, priceImpactBps: candidate.priceImpactBps,
      slippageBps: candidate.slippageBps, mode: "PAPER_ONLY",
    });
    await persistTransition(intent, version);
  }

  if (intent.state === "RISK_APPROVED") {
    const portfolio = await readPortfolioPolicy(intent);
    if (!portfolio) return intent;
    if (portfolio.policyVersion !== intent.policyVersion || !portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
      const version = intent.version;
      intent = next(intent, "REJECTED_POLICY", "PORTFOLIO_POLICY_CHANGED", { policyVersion: portfolio.policyVersion });
      await persistTransition(intent, version);
      return intent;
    }
    if (!intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now()) {
      const version = intent.version;
      intent = next(intent, "QUOTE_REQUIRED", "QUOTE_EXPIRED_BEFORE_RESERVATION");
      await persistTransition(intent, version);
      return intent;
    }
    const detail = roundTripEvidence(intent);
    if (evidenceNumber(detail, "networkFeeBufferBps") !== portfolio.networkFeeBufferBps) {
      const version = intent.version;
      intent = next(intent, "QUOTE_REQUIRED", "NETWORK_FEE_POLICY_CHANGED");
      await persistTransition(intent, version);
      return intent;
    }
    const reserved = await reservePortfolioBudget({
      ownerId: intent.ownerId, intentId: intent.id, chainId: intent.chainId,
      tokenAddress: intent.tokenAddress, inputTokenAddress: intent.inputTokenAddress,
      amountIn: intent.amountIn, expectedAmountOut: evidenceString(detail, "expectedAmountOut"),
      policyVersion: portfolio.policyVersion,
    });
    const version = intent.version;
    if (!reserved) {
      intent = next(intent, "REJECTED_POLICY", "PORTFOLIO_BUDGET_RESERVATION_REJECTED", {
        policyVersion: portfolio.policyVersion,
      });
    } else {
      intent = next(intent, "BUDGET_RESERVED", "PAPER_BUDGET_RESERVED", {
        amountIn: intent.amountIn, expectedAmountOut: evidenceString(detail, "expectedAmountOut"),
        policyVersion: portfolio.policyVersion,
      });
    }
    await persistTransition(intent, version);
  }

  if (intent.state === "BUDGET_RESERVED") {
    const portfolio = await readPortfolioPolicy(intent);
    if (!portfolio) return intent;
    if (portfolio.policyVersion !== intent.policyVersion || !portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "PAPER_BUDGET_HELD_BY_POLICY_CHANGE");
      await persistTransition(intent, version);
      return intent;
    }
    if (!intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now()) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "QUOTE_REQUIRED", "QUOTE_EXPIRED_BEFORE_PAPER_SIMULATION");
      await persistTransition(intent, version);
      return intent;
    }
    const detail = roundTripEvidence(intent);
    const version = intent.version;
    intent = next(intent, "SIMULATED", "PAPER_QUOTE_SIMULATED", {
      fillMode: "PAPER_QUOTE", quoteId: intent.quoteId,
      amountIn: intent.amountIn, amountOut: evidenceString(detail, "expectedAmountOut"),
      expectedExitAmountOut: evidenceString(detail, "expectedExitAmountOut"),
      indicativeRoundTripEdgeBps: evidenceNumber(detail, "indicativeRoundTripEdgeBps"),
    });
    await persistTransition(intent, version);
  }

  if (intent.state === "SIMULATED") {
    const portfolio = await readPortfolioPolicy(intent);
    if (!portfolio) return intent;
    if (portfolio.policyVersion !== intent.policyVersion || !portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "PAPER_FILL_BLOCKED_BY_POLICY_CHANGE");
      await persistTransition(intent, version);
      return intent;
    }
    if (!intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now()) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "QUOTE_REQUIRED", "QUOTE_EXPIRED_BEFORE_PAPER_FILL_COMMIT");
      await persistTransition(intent, version);
      return intent;
    }
    const detail = roundTripEvidence(intent);
    const committed = await commitPaperQuoteFill({
      ownerId: intent.ownerId, intentId: intent.id, quoteId: String(intent.quoteId),
      amountOut: evidenceString(detail, "expectedAmountOut"),
      quoteObservedAt: evidenceString(detail, "buyObservedAt"),
    });
    if (!committed) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "PAPER_FILL_COMMIT_FAILED");
      await persistTransition(intent, version);
      return intent;
    }
    const version = intent.version;
    intent = next(intent, "PAPER_FILLED", "PAPER_FILL_COMMITTED", {
      quoteId: intent.quoteId, amountIn: intent.amountIn,
      amountOut: evidenceString(detail, "expectedAmountOut"),
      expectedExitAmountOut: evidenceString(detail, "expectedExitAmountOut"),
      mode: "PAPER_ONLY",
    });
    await persistTransition(intent, version);
    console.info("[autonomy-worker] paper-filled " + intent.id + " edgeBps=" +
      evidenceNumber(detail, "indicativeRoundTripEdgeBps") + " mode=PAPER_ONLY");
  }
  return intent;
}

async function qualifyOpportunity(opportunity: Awaited<ReturnType<typeof readMarketOpportunities>>[number]): Promise<string | null> {
  if (opportunity.stale || opportunity.status !== "ACTIVE" || opportunity.direction !== "DISCOUNT") return null;
  const utcDay = new Date().toISOString().slice(0, 10);
  const idempotencyKey = [STRATEGY_ID, STRATEGY_VERSION, POLICY_VERSION, utcDay].join(":");
  const candidate = createExecutionIntent({
    id: randomUUID(), idempotencyKey, ownerId: OWNER_ID, walletAddress: WALLET,
    chainId: String(opportunity.chainId), tokenAddress: opportunity.tokenAddress,
    inputTokenAddress: INPUT_TOKEN, amountIn: AMOUNT_IN,
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
    policyVersion: POLICY_VERSION, now: new Date().toISOString(),
  });
  const created = await createExecutionIntentIfAbsent(candidate);
  let intent = created.intent;
  if (intent.tokenAddress.toLowerCase() !== opportunity.tokenAddress.toLowerCase()) return null;
  if (!["DISCOVERED", "QUALIFIED", "QUOTE_REQUIRED"].includes(intent.state)) return null;
  const leaseToken = await acquireExecutionLease(OWNER_ID, intent.id, LEASE_MS);
  if (!leaseToken) return intent.id;
  try {
    if (intent.state === "DISCOVERED") {
      const version = intent.version;
      intent = next(intent, "QUALIFIED", "OPPORTUNITY_QUALIFIED", {
        ticker: opportunity.ticker, direction: opportunity.direction,
        deviationBps: opportunity.deviationBps, providerTimestamp: opportunity.providerTimestamp,
        executionMode: "PAPER_ONLY",
      });
      await persistTransition(intent, version);
    }
    await advanceIntent(intent);
    return intent.id;
  } finally {
    await releaseExecutionLease(OWNER_ID, intent.id, leaseToken);
  }
}

async function processExistingIntent(intent: ExecutionIntent) {
  if (intent.state === "DISCOVERED" || isTerminalExecutionState(intent.state)) return;
  const leaseToken = await acquireExecutionLease(OWNER_ID, intent.id, LEASE_MS);
  if (!leaseToken) return;
  try { await advanceIntent(intent); }
  finally { await releaseExecutionLease(OWNER_ID, intent.id, leaseToken); }
}
async function cycle() {
  const processed = new Set<string>();
  const opportunities = await readMarketOpportunities({ status: "ACTIVE", limit: 100 });
  opportunities.sort((a, b) => Math.abs(b.deviationBps) - Math.abs(a.deviationBps));
  for (const opportunity of opportunities) {
    try {
      const intentId = await qualifyOpportunity(opportunity);
      if (intentId) processed.add(intentId);
    } catch (error) {
      console.error("[autonomy-worker] opportunity processing failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
  // Recover non-terminal intents even if their original market signal has cleared.
  const openIntents = await listOpenExecutionIntents(OWNER_ID, 150);
  for (const intent of openIntents) {
    if (processed.has(intent.id)) continue;
    try { await processExistingIntent(intent); }
    catch (error) {
      console.error("[autonomy-worker] intent recovery failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
}
async function main() {
  console.info(`[autonomy-worker] started; interval=${INTERVAL_MS}ms; mode=PAPER_ONLY`);
  for (;;) {
    const started = Date.now();
    try { await cycle(); }
    catch (error) { console.error("[autonomy-worker] cycle failed:", error instanceof Error ? error.message : "unknown error"); }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, INTERVAL_MS - (Date.now() - started))));
  }
}
main().catch((error) => {
  console.error("[autonomy-worker] fatal startup error:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
