import "server-only";
import { randomUUID } from "node:crypto";
import {
  AgentControlPlaneError,
  assertAgentTransition,
  createSnapshotHash,
  evaluateRiskPolicy,
  evaluateCrossVenueOpportunities,
  type AgentState,
  type OpportunityEvidence,
} from "../lib/agentControlPlane.ts";
import type { AgentAnalysisProvider, AgentAnalysisResult } from "./agentAnalysis.ts";
import type { AgentMemoryStorePort } from "./agentMemoryStore.ts";
import type { CollectionResult, MarketDataCollector } from "./marketDataCollector.ts";

const STRATEGY_NAME = "cross-venue-spread";
const STRATEGY_VERSION = "1.0.0";
const MAX_HISTORICAL_OBSERVATIONS = 100;
const DEFAULT_OPPORTUNITY_TTL_MS = 5 * 60_000;
const DEFAULT_STALE_RUN_AGE_MS = 5 * 60_000;

export type AgentRunRequest = {
  ownerAddress: string;
  agentId: string;
  watchlist: string[];
  strategyConfiguration: {
    minimumAbsoluteSpreadPercent: number;
    intendedAmount: string;
    notionalValue: string;
    maximumSlippageBps: number;
  };
};

export type AgentRunResult = {
  runId: string;
  status: AgentState;
  opportunityId: string | null;
  analysisId: string | null;
  proposalId: string | null;
  refusalReasons: string[];
  collection: CollectionResult;
};

export class AgentOrchestrator {
  private readonly store: AgentMemoryStorePort;
  private readonly collector: MarketDataCollector;
  private readonly analysisProvider: AgentAnalysisProvider;
  private readonly options: {
    enabled?: boolean;
    now?: () => number;
    maxObservationAgeMs?: number;
    opportunityTtlMs?: number;
    policyContext?: (input: {
      evidence: OpportunityEvidence[];
      notionalValue: string;
      now: number;
      dailyExposure: string;
    }) => Promise<{
      slippageBps: number;
      referenceDeviationPercent: number | null;
      dataFresh: boolean;
      quoteExpiresAt: number | null;
      availableBalance: string | null;
      session: string;
      quoteReference: string | null;
      expectedInput: string | null;
      expectedOutput: string | null;
    }>;
  };

  constructor(
    store: AgentMemoryStorePort,
    collector: MarketDataCollector,
    analysisProvider: AgentAnalysisProvider,
    options: AgentOrchestrator["options"] = {},
  ) {
    this.store = store;
    this.collector = collector;
    this.analysisProvider = analysisProvider;
    this.options = options;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const now = this.options.now ?? Date.now;
    if (!(this.options.enabled ?? process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED === "true")) {
      throw new AgentControlPlaneError("UNAVAILABLE", "Agent orchestration is disabled; explicitly configure WOLV_AGENT_CONTROL_PLANE_ENABLED=true.");
    }
    validateRunRequest(request);
    const startedAt = now();
    await this.store.expirePendingProposals(startedAt, request.ownerAddress);
    await this.store.expireOpportunities(startedAt, request.ownerAddress);
    await this.store.recoverStaleRuns(startedAt, startedAt - DEFAULT_STALE_RUN_AGE_MS, request.ownerAddress);
    const control = await this.store.getControlState(startedAt);
    if (control.emergency_stop === true || control.stop_monitoring === true ||
      control.reject_new_opportunities === true || control.permission_active !== true) {
      throw new AgentControlPlaneError("EMERGENCY_STOP", "Emergency stop is active or control permission is missing or expired.");
    }

    const runId = await this.store.createRun({
      ownerAddress: request.ownerAddress,
      agentId: request.agentId,
      strategyId: STRATEGY_NAME,
      strategyVersion: STRATEGY_VERSION,
      triggerType: "OPERATOR_REQUEST",
      startedAt,
      configuration: request.strategyConfiguration,
    });
    let state: AgentState = "INITIALIZING";
    let opportunityId: string | null = null;
    let analysisId: string | null = null;
    let proposalId: string | null = null;
    let collection: CollectionResult | null = null;
    let refusalReasons: string[] = [];

    try {
      await this.transition(runId, state, "MONITORING", now(), { reason: "Explicit bounded monitoring request." });
      state = "MONITORING";
      collection = await this.collector.collectWatchlist(request.watchlist, request.ownerAddress);
      await this.transition(runId, state, "OBSERVATION_RECORDED", now(), {
        provider: collection.provider,
        observationsStored: collection.observationsStored,
        candlesStored: collection.candlesStored,
      });
      state = "OBSERVATION_RECORDED";

      const recent = await this.store.getOpportunityEvidence({
        ownerAddress: request.ownerAddress,
        since: now() - (this.options.maxObservationAgeMs ?? 60_000),
        limit: MAX_HISTORICAL_OBSERVATIONS,
      });
      const evidence = recent.map(toOpportunityEvidence);
      const detection = evaluateCrossVenueOpportunities({
        evidence,
        now: now(),
        maxAgeMs: this.options.maxObservationAgeMs ?? 60_000,
        minimumAbsoluteSpreadPercent: request.strategyConfiguration.minimumAbsoluteSpreadPercent,
      });
      const opportunities = detection.opportunities;
      if (!opportunities.length) {
        refusalReasons = detection.rejectionReasons;
        await this.store.appendEvent(runId, {
          eventType: "OPPORTUNITY_REJECTED",
          occurredAt: now(),
          correlationId: runId,
          payload: {
            strategyId: STRATEGY_NAME,
            strategyVersion: STRATEGY_VERSION,
            thresholds: request.strategyConfiguration,
            refusalReasons,
          },
          provenance: { source: "deterministic-opportunity-detector" },
        });
        await this.transition(runId, state, "COMPLETED", now(), {
          reason: refusalReasons.join(" ") || "No qualifying cross-venue opportunity was observed.",
        });
        return {
          runId,
          status: "COMPLETED",
          opportunityId,
          analysisId,
          proposalId,
          refusalReasons,
          collection,
        };
      }

      const found = opportunities[0];
      const selectedAsset = [...found.observations].sort((a, b) =>
        Number(a.normalizedSharePrice) - Number(b.normalizedSharePrice))[0];
      const historicalRows = await this.store.getRecentObservations({
        ownerAddress: request.ownerAddress,
        assetId: selectedAsset.assetId,
        since: now() - 30 * 24 * 60 * 60_000,
        limit: MAX_HISTORICAL_OBSERVATIONS,
      });
      const historicalContext = historicalRows
        .filter((row) => !found.observations.some((entry) => entry.observationId === row.observation_id))
        .map((row) => ({
          observationId: String(row.observation_id),
          observedAt: timestampValue(row.provider_timestamp),
          price: String(row.price),
          source: String(row.source),
        }));
      opportunityId = randomUUID();
      const recordedOpportunity = await this.store.recordOpportunity({
        ownerAddress: request.ownerAddress,
        opportunityId,
        runId,
        assetId: selectedAsset.assetId,
        direction: "BUY",
        strategyId: STRATEGY_NAME,
        strategyVersion: STRATEGY_VERSION,
        detectedAt: now(),
        evidence: {
          observationIds: found.observations.map((entry) => entry.observationId),
          priceKind: found.observations.map((entry) => entry.priceKind),
          reason: found.reason,
        },
        referencePrices: Object.fromEntries(found.observations.map((entry) =>
          [entry.platform, entry.referencePrice])),
        spreadPercent: found.spreadPercent,
        historicalContext: { observations: historicalContext },
        status: "DETECTED",
        expiresAt: now() + (this.options.opportunityTtlMs ?? DEFAULT_OPPORTUNITY_TTL_MS),
        detectionKey: found.detectionKey,
      });
      opportunityId = recordedOpportunity.opportunityId;
      if (!recordedOpportunity.created) {
        await this.transition(runId, state, "COMPLETED", now(), {
          reason: "Matching opportunity was already recorded; duplicate detection was suppressed.",
          opportunityId,
        });
        return {
          runId,
          status: "COMPLETED",
          opportunityId,
          analysisId,
          proposalId,
          refusalReasons: [],
          collection,
        };
      }
      const activeOpportunityId = recordedOpportunity.opportunityId;
      await this.transition(runId, state, "OPPORTUNITY_DETECTED", now(), {
        opportunityId: activeOpportunityId,
        reason: found.reason,
      });
      state = "OPPORTUNITY_DETECTED";
      await this.transition(runId, state, "ANALYZING", now(), { opportunityId: activeOpportunityId });
      state = "ANALYZING";

      const analysis = await this.analysisProvider.analyze({
        ticker: found.ticker,
        opportunity: {
          spreadPercent: found.spreadPercent,
          reason: found.reason,
          evidenceIds: found.observations.map((entry) => entry.observationId),
        },
        observations: found.observations.map((entry) => ({
          observationId: entry.observationId,
          platform: entry.platform,
          price: entry.normalizedSharePrice,
          currency: entry.currency,
          providerTimestamp: entry.providerTimestamp,
          verificationStatus: entry.verificationStatus,
          priceKind: entry.priceKind,
        })),
        historicalContext: historicalContext.map((entry) => ({
          observationId: entry.observationId,
          price: entry.price,
          source: entry.source,
          providerTimestamp: entry.observedAt,
        })),
        strategyConfiguration: request.strategyConfiguration,
        dataFresh: found.observations.every((entry) =>
          now() - entry.providerTimestamp <= entry.freshnessMs),
      });
      const sanitizedAnalysis = validateAnalysisReferences(analysis, found.observations);
      analysisId = randomUUID();
      await this.store.recordAnalysis({
        analysisId,
        runId,
        opportunityId: activeOpportunityId,
        evidenceReferences: sanitizedAnalysis.evidenceReferences,
        modelIdentifier: sanitizedAnalysis.modelIdentifier,
        modelVersion: sanitizedAnalysis.modelVersion,
        analyzedAt: now(),
        reasoningSummary: [
          sanitizedAnalysis.interpretation,
          sanitizedAnalysis.opportunityExplanation,
          sanitizedAnalysis.historicalComparison,
        ].join(" "),
        recommendation: sanitizedAnalysis.suggestedNextAction,
        risks: [...sanitizedAnalysis.risks, ...sanitizedAnalysis.dataLimitations, ...sanitizedAnalysis.assumptions],
        invalidatingConditions: sanitizedAnalysis.invalidatingConditions,
        structuredResult: sanitizedAnalysis as unknown as Record<string, unknown>,
      });
      await this.transition(runId, state, "ANALYSIS_COMPLETED", now(), { analysisId });
      state = "ANALYSIS_COMPLETED";
      await this.transition(runId, state, "POLICY_VALIDATION", now(), { opportunityId: activeOpportunityId });
      state = "POLICY_VALIDATION";

      const dailyExposure = await this.store.getDailyExposure(request.ownerAddress, startOfUtcDay(now()));
      const policy = await this.store.getActivePolicy(request.ownerAddress, "default");
      const policyContext = await (this.options.policyContext ?? defaultPolicyContext)({
        evidence: found.observations,
        notionalValue: request.strategyConfiguration.notionalValue,
        now: now(),
        dailyExposure,
      });
      const decision = policy
        ? evaluateRiskPolicy({
          policy,
          assetKey: selectedAsset.tokenAddress.toLowerCase(),
          direction: "BUY",
          notional: request.strategyConfiguration.notionalValue,
          dailyExposure,
          slippageBps: policyContext.slippageBps,
          referenceDeviationPercent: policyContext.referenceDeviationPercent,
          dataFresh: policyContext.dataFresh,
          quoteExpiresAt: policyContext.quoteExpiresAt,
          availableBalance: policyContext.availableBalance,
          session: policyContext.session,
          now: now(),
        })
        : {
          policyVersion: "UNCONFIGURED",
          inputSnapshotHash: createSnapshotHash({ runId, policy: null, request: request.strategyConfiguration }),
          evaluatedAt: now(),
          accepted: false,
          refusalReasons: ["No active deterministic risk policy is configured."],
        };
      refusalReasons = decision.refusalReasons;
      await this.store.recordPolicyDecision({
        decisionId: randomUUID(),
        runId,
        opportunityId: activeOpportunityId,
        decision,
      });
      if (!decision.accepted) {
        await this.transition(runId, state, "POLICY_REJECTED", now(), { refusalReasons });
        state = "POLICY_REJECTED";
        await this.transition(runId, state, "COMPLETED", now(), { reason: "Policy rejected proposal." });
        return {
          runId,
          status: "COMPLETED",
          opportunityId: activeOpportunityId,
          analysisId,
          proposalId,
          refusalReasons,
          collection,
        };
      }

      await this.transition(runId, state, "POLICY_APPROVED", now(), { policyVersion: decision.policyVersion });
      state = "POLICY_APPROVED";
      proposalId = randomUUID();
      const proposal = await this.store.createProposal({
        runId,
        opportunityId: activeOpportunityId,
        assetId: selectedAsset.assetId,
        direction: "BUY",
        intendedAmount: request.strategyConfiguration.intendedAmount,
        notionalValue: request.strategyConfiguration.notionalValue,
        quoteReference: policyContext.quoteReference,
        expectedInput: policyContext.expectedInput,
        expectedOutput: policyContext.expectedOutput,
        maximumSlippageBps: request.strategyConfiguration.maximumSlippageBps,
        policyDecision: decision,
        analysisId,
        expiresAt: Math.min(
          policyContext.quoteExpiresAt ?? now(),
          now() + (policy?.quoteTtlMs ?? 0),
        ),
        risks: sanitizedAnalysis.risks,
        explanation: "User-review proposal only. No transaction will be signed or submitted.",
      }, proposalId, now());
      await this.transition(runId, state, "PROPOSAL_CREATED", now(), { proposalId, proposalHash: proposal.proposalHash });
      state = "PROPOSAL_CREATED";
      await this.transition(runId, state, "AWAITING_USER_APPROVAL", now(), { proposalId });
      return {
        runId,
        status: "AWAITING_USER_APPROVAL",
        opportunityId,
        analysisId,
        proposalId,
        refusalReasons: [],
        collection,
      };
    } catch (error) {
      try {
        await this.transition(runId, state, "FAILED", now(), {
          reason: safeError(error),
        });
      } catch (transitionError) {
        throw new AggregateError(
          [error, transitionError],
          "Agent run failed and its failure state could not be persisted.",
        );
      }
      throw error;
    }
  }

  async stop(reason: string, ownerAddress: string): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (!reason.trim()) throw new AgentControlPlaneError("INVALID_INPUT", "A stop reason is required.");
    await this.store.setEmergencyStop({
      ownerAddress,
      stopped: true,
      reason: reason.trim().slice(0, 500),
      permissionExpiresAt: null,
      updatedAt: now,
      correlationId: randomUUID(),
    });
    const activeRuns = await this.store.getActiveRuns(ownerAddress);
    for (const run of activeRuns) {
      const state = String(run.run_status) as AgentState;
      if (state === "COMPLETED" || state === "FAILED" || state === "STOPPED") continue;
      await this.transition(String(run.run_id), state, "STOPPED", now, {
        reason: "Emergency stop activated; unfinished run was stopped.",
      });
    }
  }

  async decideProposal(proposalId: string, ownerAddress: string, action: "APPROVE" | "REJECT" | "REVOKE") {
    const now = (this.options.now ?? Date.now)();
    const result = await this.store.decideProposal(proposalId, ownerAddress, action, now);
    const proposal = await this.store.getProposal(proposalId, ownerAddress);
    if (!proposal) throw new AgentControlPlaneError("NOT_FOUND", "Proposal was not found after its decision.");
    const runId = String(proposal.run_id);
    if (result.decision === "REVOKED") {
      await this.store.appendEvent(runId, {
        eventType: "APPROVED_PROPOSAL_REVOKED",
        occurredAt: now,
        correlationId: proposalId,
        payload: { proposalId, executionBlocked: true },
        provenance: { source: "approval-manager" },
      });
    }
    return result;
  }

  private async transition(
    runId: string,
    current: AgentState,
    next: AgentState,
    now: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    assertAgentTransition(current, next);
    await this.store.transitionRun(runId, next, {
      eventType: "STATE_CHANGED",
      occurredAt: now,
      correlationId: runId,
      payload,
      provenance: { source: "agent-orchestrator", strategyVersion: STRATEGY_VERSION },
    });
  }
}

async function defaultPolicyContext(input: {
  evidence: OpportunityEvidence[];
  notionalValue: string;
  now: number;
  dailyExposure: string;
}) {
  const isFresh = input.evidence.length >= 2 && input.evidence.every((evidence) =>
    evidence.verificationStatus === "VERIFIED" &&
    input.now - evidence.providerTimestamp <= Math.min(evidence.freshnessMs, 60_000));
  return {
    slippageBps: 0,
    referenceDeviationPercent: null,
    dataFresh: isFresh,
    quoteExpiresAt: null,
    availableBalance: null,
    session: "UNKNOWN",
    quoteReference: null,
    expectedInput: null,
    expectedOutput: null,
  };
}

function validateRunRequest(request: AgentRunRequest): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(request.ownerAddress) ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(request.agentId) ||
    !Array.isArray(request.watchlist) ||
    request.watchlist.length === 0 ||
    request.watchlist.length > 25) {
    throw new AgentControlPlaneError("INVALID_INPUT", "Agent ID or watchlist is invalid.");
  }
  if (!Number.isFinite(request.strategyConfiguration.minimumAbsoluteSpreadPercent) ||
    request.strategyConfiguration.minimumAbsoluteSpreadPercent < 0 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(request.strategyConfiguration.intendedAmount) ||
    Number(request.strategyConfiguration.intendedAmount) <= 0 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(request.strategyConfiguration.notionalValue) ||
    Number(request.strategyConfiguration.notionalValue) <= 0 ||
    !Number.isSafeInteger(request.strategyConfiguration.maximumSlippageBps) ||
    request.strategyConfiguration.maximumSlippageBps < 0 ||
    request.strategyConfiguration.maximumSlippageBps > 10_000) {
    throw new AgentControlPlaneError("INVALID_INPUT", "Strategy thresholds and proposal amounts are invalid.");
  }
}

function toOpportunityEvidence(row: Record<string, unknown>): OpportunityEvidence {
  return {
    observationId: String(row.observation_id),
    assetId: String(row.asset_id),
    tokenAddress: String(row.token_address),
    ticker: String(row.ticker),
    platform: String(row.platform),
    currency: String(row.currency),
    normalizedSharePrice: String(row.normalized_share_price),
    referencePrice: row.reference_price == null ? null : String(row.reference_price),
    providerTimestamp: timestampValue(row.provider_timestamp),
    ingestedAt: timestampValue(row.ingested_at),
    freshnessMs: Number(row.freshness_ms),
    verificationStatus: String(row.verification_status) as OpportunityEvidence["verificationStatus"],
    priceKind: String(row.price_kind) as OpportunityEvidence["priceKind"],
  };
}

function validateAnalysisReferences(
  analysis: AgentAnalysisResult,
  evidence: OpportunityEvidence[],
): AgentAnalysisResult {
  const allowed = new Set(evidence.map((entry) => entry.observationId));
  if (!analysis.evidenceReferences.length ||
    analysis.evidenceReferences.some((id) => !allowed.has(id))) {
    throw new AgentControlPlaneError("INVALID_INPUT", "AI analysis references missing or unsupported evidence.");
  }
  return analysis;
}

function timestampValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new AgentControlPlaneError("INVALID_INPUT", "Persisted provider timestamp is malformed.");
}

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return "Unknown agent workflow error.";
}
