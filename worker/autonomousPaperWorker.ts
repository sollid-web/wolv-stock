import { randomUUID } from "node:crypto";
import { autonomyProviderRegistry } from "../services/autonomy/provider-registry.ts";
import { applyNetworkFeeBuffer } from "../services/autonomy/network-fee.ts";
import { evaluatePaperExit } from "../services/autonomy/paper-exit-policy.ts";
import { conservativeExitProceeds, usdFeeToTokenUnits, calculateExitReturnBps } from "../services/autonomy/paper-exit-valuation.ts";
import { readMarketOpportunities } from "../services/marketPriceCache.ts";
import {
  createExecutionIntent, transitionExecutionIntent, evaluateRiskPolicy, isTerminalExecutionState,
  type ExecutionIntent,
} from "../services/autonomy/execution-domain.ts";
import {
  loadPortfolioPolicy, reservePortfolioBudget, releasePortfolioBudget, commitPaperQuoteFill,
  listOpenPaperPositions, commitPaperPositionExit,
} from "../services/autonomy/supabase-portfolio-ledger.ts";
import {
  acquireExecutionLease, compareAndSwapExecutionIntent,
  createExecutionIntentIfAbsent, releaseExecutionLease, listOpenExecutionIntents,
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
  const event = [...intent.events].reverse().find((item) => item.type === "PROVIDER_ROUNDTRIP_QUOTES_VALIDATED" || item.type === "BINANCE_ROUNDTRIP_QUOTES_VALIDATED");
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

function portfolioMatchesIntent(portfolio: Awaited<ReturnType<typeof loadPortfolioPolicy>>, intent: ExecutionIntent): boolean {
  return !!portfolio && portfolio.walletAddress === intent.walletAddress.toLowerCase() &&
    portfolio.chainId === intent.chainId && portfolio.inputTokenAddress === intent.inputTokenAddress.toLowerCase();
}

async function advanceIntent(intent: ExecutionIntent): Promise<ExecutionIntent> {
  if (intent.state === "QUALIFIED") {
    const version = intent.version;
    intent = next(intent, "QUOTE_REQUIRED", "EXECUTABLE_QUOTE_REQUIRED", {
      mode: "PAPER_ONLY", blocker: "AWAITING_VALIDATED_PROVIDER_ROUNDTRIP_QUOTES",
    });
    await persistTransition(intent, version);
  }

  if (intent.state === "QUOTE_REQUIRED") {
    const feePolicy = await readPortfolioPolicy(intent);
    const feeBufferBps = feePolicy?.networkFeeBufferBps ?? NETWORK_FEE_BUFFER_BPS;
    const { adapter, result: roundTrip } = await autonomyProviderRegistry.getRoundTripQuote({
      chainId: intent.chainId, walletAddress: intent.walletAddress,
      inputTokenAddress: intent.inputTokenAddress, outputTokenAddress: intent.tokenAddress,
      amountIn: intent.amountIn, slippageBps: SLIPPAGE_BPS,
      networkFeeBufferBps: feeBufferBps,
    });
    if (Date.parse(roundTrip.expiresAt) <= Date.now()) {
      throw new Error("Provider round-trip quotes expired before they could be persisted.");
    }
    const quote = roundTrip.buy;
    const rfqOrder = feePolicy?.riskPolicy.enabled && feePolicy.policyVersion === intent.policyVersion
      ? await adapter.buildOrder({ quote, slippageBps: SLIPPAGE_BPS, maxPriceImpactBps: feePolicy.riskPolicy.maxPriceImpactBps })
      : null;
    const version = intent.version;
    intent = {
      ...next(intent, "QUOTED", "PROVIDER_ROUNDTRIP_QUOTES_VALIDATED", {
        provider: roundTrip.provider, networkFeeBufferBps: feeBufferBps,
        buyQuoteId: roundTrip.buy.quoteId, buyVendor: roundTrip.buy.vendorName,
        buyAmountIn: roundTrip.buy.amountIn, buyExpectedAmountOut: roundTrip.buy.expectedAmountOut,
        expectedAmountOut: roundTrip.buyMinimumAmountOut,
        buyPriceImpactBps: roundTrip.buy.priceImpactBps, buyGasEstimateRaw: roundTrip.buy.gasEstimateRaw,
        buyEstimatedNetworkFeeUsd: roundTrip.buy.estimatedNetworkFeeUsd,
        buyApprovalTarget: roundTrip.buy.approvalTarget, buyObservedAt: roundTrip.buy.observedAt,
        sellQuoteId: roundTrip.sell.quoteId, sellVendor: roundTrip.sell.vendorName,
        sellAmountIn: roundTrip.sell.amountIn, sellExpectedAmountOut: roundTrip.sell.expectedAmountOut,
        expectedExitAmountOut: roundTrip.sellMinimumAmountOut,
        sellPriceImpactBps: roundTrip.sell.priceImpactBps, sellGasEstimateRaw: roundTrip.sell.gasEstimateRaw,
        sellEstimatedNetworkFeeUsd: roundTrip.sell.estimatedNetworkFeeUsd,
        sellApprovalTarget: roundTrip.sell.approvalTarget, sellObservedAt: roundTrip.sell.observedAt,
        indicativeRoundTripEdgeBps: roundTrip.indicativeRoundTripEdgeBps,
        bufferedNetworkFeesUsd: roundTrip.bufferedNetworkFeesUsd,
        approvalRequired: roundTrip.approvalRequired, slippageBps: roundTrip.slippageBps,
        buyMinimumAmountOut: roundTrip.buyMinimumAmountOut, sellMinimumAmountOut: roundTrip.sellMinimumAmountOut,
        rfqOrderPrepared: !!rfqOrder,
        rfqOrderId: rfqOrder?.orderId ?? null, rfqVendor: rfqOrder?.vendor ?? null,
        rfqSigningScheme: rfqOrder?.signingScheme ?? null, rfqTypedDataHash: rfqOrder?.typedDataHash ?? null,
        rfqTypedDataFormat: rfqOrder?.typedDataFormat ?? null,
        rfqApprovalRequired: rfqOrder?.approvalRequired ?? null, rfqApprovalTarget: rfqOrder?.approvalTarget ?? null,
        rfqPreparedAt: rfqOrder?.preparedAt ?? null, rfqRawEvidenceRef: rfqOrder?.rawEvidenceRef ?? null,
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
    if (!portfolioMatchesIntent(portfolio, intent)) {
      const version = intent.version;
      intent = next(intent, "REJECTED_POLICY", "PORTFOLIO_WALLET_OR_ASSET_MISMATCH");
      await persistTransition(intent, version);
      return intent;
    }
    if (portfolio.policyVersion !== intent.policyVersion) {
      const version = intent.version;
      intent = next(intent, "REJECTED_POLICY", "POLICY_VERSION_MISMATCH", {
        intentPolicyVersion: intent.policyVersion, currentPolicyVersion: portfolio.policyVersion,
      });
      await persistTransition(intent, version);
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
    if (!portfolioMatchesIntent(portfolio, intent) || portfolio.policyVersion !== intent.policyVersion || !portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
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
    if (!portfolioMatchesIntent(portfolio, intent) || portfolio.policyVersion !== intent.policyVersion || !portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "PAPER_BUDGET_HELD_BY_POLICY_CHANGE");
      await persistTransition(intent, version);
      return intent;
    }
    const feeEvidence = roundTripEvidence(intent);
    if (evidenceNumber(feeEvidence, "networkFeeBufferBps") !== portfolio.networkFeeBufferBps) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "NETWORK_FEE_POLICY_CHANGED_AFTER_RESERVATION");
      await persistTransition(intent, version);
      return intent;
    }
    if (!intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now()) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "EXPIRED", "QUOTE_EXPIRED_BEFORE_PAPER_SIMULATION");
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
    if (!portfolioMatchesIntent(portfolio, intent) || portfolio.policyVersion !== intent.policyVersion || !portfolio.riskPolicy.enabled || portfolio.emergencyStop) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "PAPER_FILL_BLOCKED_BY_POLICY_CHANGE");
      await persistTransition(intent, version);
      return intent;
    }
    const feeEvidence = roundTripEvidence(intent);
    if (evidenceNumber(feeEvidence, "networkFeeBufferBps") !== portfolio.networkFeeBufferBps) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "SECURITY_HOLD", "NETWORK_FEE_POLICY_CHANGED_AFTER_RESERVATION");
      await persistTransition(intent, version);
      return intent;
    }
    if (!intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now()) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      intent = next(intent, "EXPIRED", "QUOTE_EXPIRED_BEFORE_PAPER_FILL_COMMIT");
      await persistTransition(intent, version);
      return intent;
    }
    const detail = roundTripEvidence(intent);
    const committed = await commitPaperQuoteFill({
      ownerId: intent.ownerId, intentId: intent.id, quoteId: String(intent.quoteId),
      sellQuoteId: evidenceString(detail, "sellQuoteId"),
      amountOut: evidenceString(detail, "expectedAmountOut"),
      expectedExitAmountOut: evidenceString(detail, "expectedExitAmountOut"),
      roundTripEdgeBps: evidenceNumber(detail, "indicativeRoundTripEdgeBps"),
      bufferedNetworkFeesUsd: evidenceString(detail, "bufferedNetworkFeesUsd"),
      slippageBps: evidenceNumber(detail, "slippageBps"),
      quoteObservedAt: evidenceString(detail, "buyObservedAt"),
      exitQuoteObservedAt: evidenceString(detail, "sellObservedAt"),
    });
    if (!committed) {
      await releasePortfolioBudget(intent.ownerId, intent.id);
      const version = intent.version;
      const expired = !intent.quoteExpiresAt || Date.parse(intent.quoteExpiresAt) <= Date.now();
      intent = next(intent, expired ? "EXPIRED" : "SECURITY_HOLD",
        expired ? "QUOTE_EXPIRED_DURING_PAPER_FILL_COMMIT" : "PAPER_FILL_COMMIT_FAILED");
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
  const idempotencyKey = [STRATEGY_ID, STRATEGY_VERSION, POLICY_VERSION, opportunity.tokenAddress.toLowerCase(), utcDay].join(":");
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
  if (isTerminalExecutionState(intent.state)) return;
  const leaseToken = await acquireExecutionLease(OWNER_ID, intent.id, LEASE_MS);
  if (!leaseToken) return;
  try {
    if (intent.state === "DISCOVERED") {
      const version = intent.version;
      const expired = next(intent, "EXPIRED", "OPPORTUNITY_NO_LONGER_ACTIVE");
      await persistTransition(expired, version);
      return;
    }
    await advanceIntent(intent);
  } finally {
    await releaseExecutionLease(OWNER_ID, intent.id, leaseToken);
  }
}

async function processPaperExits() {
  const portfolio = await loadPortfolioPolicy(OWNER_ID);
  if (!portfolio?.paperExitPolicy.enabled) return;
  if (portfolio.chainId !== "56" || portfolio.walletAddress !== WALLET.toLowerCase()) {
    console.warn("[autonomy-worker] paper-exits-held blocker=PORTFOLIO_WALLET_OR_CHAIN_MISMATCH");
    return;
  }
  if (SLIPPAGE_BPS > portfolio.riskPolicy.maxSlippageBps) {
    console.warn("[autonomy-worker] paper-exits-held blocker=SLIPPAGE_EXCEEDS_POLICY");
    return;
  }
  const allowed = new Set(portfolio.riskPolicy.allowedTokenAddresses.map((value) => value.toLowerCase()));
  const positions = await listOpenPaperPositions(OWNER_ID, 100);
  for (const position of positions) {
    if (position.chainId !== portfolio.chainId || !allowed.has(position.tokenAddress)) continue;
    try {
      const adapter = autonomyProviderRegistry.select(position.chainId);
      const quote = await adapter.getQuote({
        chainId: position.chainId, walletAddress: portfolio.walletAddress,
        inputTokenAddress: position.tokenAddress,
        outputTokenAddress: portfolio.inputTokenAddress,
        amountIn: position.amountUnits, slippageBps: SLIPPAGE_BPS,
      });
      const now = Date.now();
      if (Date.parse(quote.expiresAt) <= now || now - Date.parse(quote.observedAt) > portfolio.riskPolicy.maxQuoteAgeMs ||
          Date.parse(quote.observedAt) > now + 5_000 ||
          quote.priceImpactBps > portfolio.riskPolicy.maxPriceImpactBps) {
        console.info("[autonomy-worker] paper-exit-held token=" + position.tokenAddress + " blocker=STALE_OR_HIGH_IMPACT_QUOTE");
        continue;
      }
      const bufferedFeeUsd = applyNetworkFeeBuffer(quote.estimatedNetworkFeeUsd, portfolio.networkFeeBufferBps);
      const grossProceeds = conservativeExitProceeds({
        expectedAmountOut: quote.expectedAmountOut, slippageBps: SLIPPAGE_BPS,
        outputTaxRate: quote.outputTokenTaxRate,
      });
      const feeUnits = usdFeeToTokenUnits({
        feeUsd: bufferedFeeUsd, tokenUsdPrice: quote.outputTokenUsdPrice,
        tokenDecimals: quote.outputTokenDecimals,
      });
      const netProceeds = BigInt(grossProceeds) > BigInt(feeUnits)
        ? (BigInt(grossProceeds) - BigInt(feeUnits)).toString() : "0";
      const decision = evaluatePaperExit(portfolio.paperExitPolicy, {
        costBasisInputUnits: position.costBasisInputUnits,
        netProceedsInputUnits: netProceeds,
        openedAt: position.openedAt, now: new Date(now).toISOString(),
      });
      if (!decision.exit) continue;
      const committed = await commitPaperPositionExit({
        ownerId: OWNER_ID, exitIntentId: randomUUID(), chainId: position.chainId,
        tokenAddress: position.tokenAddress, inputTokenAddress: portfolio.inputTokenAddress,
        quoteId: quote.quoteId, amountSold: position.amountUnits,
        grossProceedsInputUnits: grossProceeds, feeInputUnits: feeUnits,
        netProceedsInputUnits: netProceeds, reason: decision.reason,
        quoteObservedAt: quote.observedAt,
      });
      if (committed) {
        console.info("[autonomy-worker] paper-exit-filled token=" + position.tokenAddress +
          " reason=" + decision.reason + " returnBps=" +
          calculateExitReturnBps(position.costBasisInputUnits, netProceeds) + " mode=PAPER_ONLY");
      } else {
        console.warn("[autonomy-worker] paper-exit-not-committed token=" + position.tokenAddress);
      }
    } catch (error) {
      console.error("[autonomy-worker] paper-exit-failed token=" + position.tokenAddress + ": " +
        (error instanceof Error ? error.message : "unknown error"));
    }
  }
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
  try { await processPaperExits(); }
  catch (error) { console.error("[autonomy-worker] paper-exit cycle failed:", error instanceof Error ? error.message : "unknown error"); }
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
