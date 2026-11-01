import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { POST as postLegacyAgentAction } from "../app/api/agent/execute/route.ts";
import { POST as postLegacyApproval } from "../app/api/agent/approve/route.ts";
import { GET as getLegacyExecutionStatus } from "../app/api/agent/executions/route.ts";
import {
  canTransitionAgentState,
  evaluateRiskPolicy,
  validateRiskPolicy,
  validateMarketObservation,
} from "../lib/agentControlPlane.ts";
import { validateAnalysis, ConfiguredAgentAnalysisProvider } from "../services/agentAnalysis.ts";
import {
  handleAgentControlGet,
  handleAgentControlPost,
  handleAgentPolicyPost,
} from "../services/agentControlHttp.ts";
import { AgentOrchestrator } from "../services/agentOrchestrator.ts";
import { MarketDataCollector } from "../services/marketDataCollector.ts";

const ADDRESSES = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
];
const OWNER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("agent state machine rejects invalid transitions and execution is terminally blocked", () => {
  assert.equal(canTransitionAgentState("IDLE", "INITIALIZING"), true);
  assert.equal(canTransitionAgentState("IDLE", "USER_APPROVED"), false);
  assert.equal(canTransitionAgentState("USER_APPROVED", "EXECUTION_BLOCKED"), true);
  assert.equal(canTransitionAgentState("EXECUTION_BLOCKED", "COMPLETED"), true);
  assert.equal(canTransitionAgentState("COMPLETED", "INITIALIZING"), false);
});

test("risk policy rejects threshold, freshness, permission, and evidence failures with exact reasons", () => {
  const input = {
    policy: {
      version: "test-1",
      approvedAssets: [ADDRESSES[0]],
      approvedDirections: ["BUY"],
      maxOrderValue: "100",
      maxDailyExposure: "150",
      maxSlippageBps: 100,
      maxReferenceDeviationPercent: 2,
      allowedSessions: ["US_REGULAR"],
      minimumBalance: "10",
      quoteTtlMs: 60_000,
      permissionExpiresAt: 2_000,
      emergencyStop: false,
    },
    assetKey: ADDRESSES[1],
    direction: "SELL",
    notional: "120",
    dailyExposure: "50",
    slippageBps: 200,
    referenceDeviationPercent: null,
    dataFresh: false,
    quoteExpiresAt: null,
    availableBalance: null,
    session: "UNKNOWN",
    now: 1_000,
  };
  const decision = evaluateRiskPolicy(input);
  assert.equal(decision.accepted, false);
  assert.deepEqual(decision.refusalReasons, [
    "Asset is not approved by policy.",
    "Direction is not approved by policy.",
    "Order value is invalid or exceeds the policy maximum.",
    "Daily exposure would exceed the policy maximum.",
    "Slippage exceeds the policy maximum.",
    "Reference-price deviation is unavailable or exceeds the policy maximum.",
    "Required market data is unavailable or stale.",
    "Current market session is not permitted by policy.",
    "Quote is missing, expired, or outside the permitted freshness window.",
    "Available balance is unavailable or below the policy minimum.",
  ]);
});

test("risk policy uses exact decimal arithmetic at daily exposure boundaries", () => {
  const now = 1_000;
  const policy = {
    version: "exact-decimal",
    approvedAssets: [ADDRESSES[0]],
    approvedDirections: ["BUY"],
    maxOrderValue: "0.2",
    maxDailyExposure: "0.3",
    maxSlippageBps: 100,
    maxReferenceDeviationPercent: 1,
    allowedSessions: ["US_REGULAR"],
    minimumBalance: "1",
    quoteTtlMs: 30_000,
    permissionExpiresAt: now + 60_000,
    emergencyStop: false,
  };
  assert.deepEqual(validateRiskPolicy(policy, now), []);
  const decision = evaluateRiskPolicy({
    policy,
    assetKey: ADDRESSES[0],
    direction: "BUY",
    notional: "0.2",
    dailyExposure: "0.1",
    slippageBps: 50,
    referenceDeviationPercent: 0,
    dataFresh: true,
    quoteExpiresAt: now + 1_000,
    availableBalance: "1",
    session: "US_REGULAR",
    now,
  });
  assert.equal(decision.accepted, true);
});

test("market observations reject stale provider timestamps and never substitute ingestion time", () => {
  const observation = {
    assetId: randomUUID(),
    price: "100",
    referencePrice: null,
    bid: null,
    ask: null,
    spreadPercent: null,
    currency: "USD",
    priceKind: "INDICATIVE",
    source: "fixture",
    providerTimestamp: 1_000,
    ingestedAt: 200_000,
    freshnessMs: 60_000,
    verificationStatus: "VERIFIED",
    provenance: { fixture: true },
    idempotencyKey: "fixture-key",
  };
  assert.deepEqual(validateMarketObservation(observation, 200_000, 60_000), ["Market observation is stale."]);
});

test("analysis accepts only supplied current or historical evidence references", () => {
  const input = {
    ticker: "TST",
    opportunity: { spreadPercent: 1, reason: "Fixture spread.", evidenceIds: ["current-1"] },
    observations: [],
    historicalContext: [{ observationId: "history-1", price: "10", source: "fixture", providerTimestamp: 1 }],
    strategyConfiguration: {},
    dataFresh: true,
  };
  const valid = {
    interpretation: "Observed fixture data.",
    opportunityExplanation: "Two venue values differ.",
    historicalComparison: "Compared with a stored observation.",
    upsideScenario: "The spread may narrow.",
    downsideScenario: "The spread may widen.",
    risks: [],
    dataLimitations: [],
    invalidatingConditions: ["A new quote differs."],
    suggestedNextAction: "Review the evidence.",
    evidenceReferences: ["history-1"],
    assumptions: [],
  };
  assert.equal(validateAnalysis(valid, input, "mock").evidenceReferences[0], "history-1");
  assert.throws(() => validateAnalysis({ ...valid, evidenceReferences: ["invented"] }, input, "mock"), {
    code: "INVALID_ANALYSIS",
  });
});

test("analysis provider timeout and malformed output fail explicitly without a live request", async (t) => {
  const config = { apiKey: "fixture", baseUrl: "https://fixture.invalid", model: "fixture-model", provider: "fixture" };
  const input = {
    ticker: "TST",
    opportunity: { spreadPercent: 1, reason: "Fixture.", evidenceIds: ["obs-1"] },
    observations: [],
    historicalContext: [],
    strategyConfiguration: {},
    dataFresh: true,
  };
  await t.test("timeout", async () => {
    const provider = new ConfiguredAgentAnalysisProvider(config, async () => {
      throw new Error("mock timeout");
    }, 1);
    await assert.rejects(() => provider.analyze(input), { code: "MODEL_UNAVAILABLE" });
  });
  await t.test("malformed content", async () => {
    const provider = new ConfiguredAgentAnalysisProvider(config, async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{bad json" } }],
    })));
    await assert.rejects(() => provider.analyze(input), { code: "INVALID_ANALYSIS" });
  });
});

test("disabled collector makes no provider calls by default", async () => {
  let providerCalls = 0;
  const store = createFakeStore(1_000);
  const adapter = {
    providerId: "fixture",
    async loadCatalogue() {
      providerCalls += 1;
      return [];
    },
  };
  const collector = new MarketDataCollector(store, adapter, { now: () => 1_000 });
  await assert.rejects(() => collector.collectWatchlist([ADDRESSES[0]], OWNER_ADDRESS), { code: "DISABLED" });
  assert.equal(providerCalls, 0);
});

test("collector rejects stale provider observations rather than stamping them fresh", async () => {
  const now = 200_000;
  const store = createFakeStore(now);
  const adapter = {
    providerId: "stale-fixture",
    async loadCatalogue() {
      return [{
        chainId: 56,
        tokenAddress: ADDRESSES[0],
        ticker: "TST",
        platform: "fixture",
        decimals: null,
        shareDenomination: null,
        metadataSource: "fixture",
        observedAt: now,
        blockNumber: null,
        blockHash: null,
        metadata: { tokenName: "Test Spot Asset" },
      }];
    },
    async observe() {
      return {
        price: "10",
        referencePrice: null,
        bid: null,
        ask: null,
        spreadPercent: null,
        currency: "USD",
        priceKind: "INDICATIVE",
        source: "fixture",
        providerTimestamp: now - 120_000,
        ingestedAt: now,
        freshnessMs: 60_000,
        verificationStatus: "VERIFIED",
        provenance: {},
      };
    },
  };
  const collector = new MarketDataCollector(store, adapter, { enabled: true, now: () => now });
  const result = await collector.collectWatchlist([ADDRESSES[0]], OWNER_ADDRESS);
  assert.equal(result.observationsStored, 0);
  assert.equal(store.observations.length, 0);
  assert.match(result.failures[0].reason, /stale/i);
});

test("fixture-driven workflow records evidence, detects a deduplicated opportunity, and keeps approval blocked", async () => {
  let now = 1_700_000_000_000;
  const store = createFakeStore(() => now);
  const adapter = {
    providerId: "controlled-fixture",
    async loadCatalogue(watchlist) {
      return watchlist.map((tokenAddress, index) => ({
        chainId: 56,
        tokenAddress,
        ticker: "TST",
        platform: index === 0 ? "venue-a" : "venue-b",
        decimals: null,
        shareDenomination: null,
        metadataSource: "controlled-fixture",
        observedAt: now,
        blockNumber: null,
        blockHash: null,
        metadata: { tokenName: "Test Spot Asset" },
      }));
    },
    async observe(asset) {
      return {
        price: asset.platform === "venue-a" ? "100" : "101",
        referencePrice: asset.platform === "venue-a" ? "100" : "101",
        bid: null,
        ask: null,
        spreadPercent: null,
        currency: "USD",
        priceKind: "INDICATIVE",
        source: "controlled-fixture",
        providerTimestamp: now,
        ingestedAt: now,
        freshnessMs: 60_000,
        verificationStatus: "VERIFIED",
        provenance: { fixture: true },
      };
    },
  };
  const collector = new MarketDataCollector(store, adapter, { enabled: true, now: () => now });
  const analysisProvider = {
    async analyze(input) {
      return {
        modelIdentifier: "deterministic-test-fixture",
        modelVersion: "1",
        interpretation: "The fixture contains two verified indicative observations.",
        opportunityExplanation: input.opportunity.reason,
        historicalComparison: "No prior observations are available.",
        upsideScenario: "The observed spread could narrow.",
        downsideScenario: "The observed spread could widen.",
        risks: ["Indicative values are not executable."],
        dataLimitations: ["The fixture is deterministic test data."],
        invalidatingConditions: ["A current executable quote differs."],
        suggestedNextAction: "Review evidence and policy.",
        evidenceReferences: input.opportunity.evidenceIds,
        assumptions: [],
      };
    },
  };
  const policy = {
    version: "fixture-policy-v1",
    approvedAssets: ADDRESSES,
    approvedDirections: ["BUY"],
    maxOrderValue: "100",
    maxDailyExposure: "1000",
    maxSlippageBps: 100,
    maxReferenceDeviationPercent: 2,
    allowedSessions: ["US_REGULAR"],
    minimumBalance: "1",
    quoteTtlMs: 60_000,
    permissionExpiresAt: now + 120_000,
    emergencyStop: false,
  };
  store.policy = policy;
  const orchestrator = new AgentOrchestrator(store, collector, analysisProvider, {
    enabled: true,
    now: () => now,
    policyContext: async () => ({
      slippageBps: 50,
      referenceDeviationPercent: 0,
      dataFresh: true,
      quoteExpiresAt: now + 30_000,
      availableBalance: "500",
      session: "US_REGULAR",
      quoteReference: "fixture-reference",
      expectedInput: "5",
      expectedOutput: "0.05",
    }),
  });
  const request = {
    ownerAddress: OWNER_ADDRESS,
    agentId: "fixture-agent",
    watchlist: ADDRESSES,
    strategyConfiguration: {
      minimumAbsoluteSpreadPercent: 0.5,
      intendedAmount: "0.05",
      notionalValue: "5",
      maximumSlippageBps: 50,
    },
  };

  const first = await orchestrator.run(request);
  assert.equal(first.status, "AWAITING_USER_APPROVAL");
  assert.deepEqual(store.recoveryCalls, [{ now, staleBefore: now - 5 * 60_000 }]);
  assert.ok(first.opportunityId);
  assert.ok(first.analysisId);
  assert.ok(first.proposalId);
  assert.equal(store.observations.length, 2);
  assert.equal(store.proposals.get(first.proposalId).direction, "BUY");
  assert.equal(store.proposals.get(first.proposalId).assetId, `fixture-asset-${ADDRESSES[0]}`);

  const approval = await orchestrator.decideProposal(first.proposalId, OWNER_ADDRESS, "APPROVE");
  assert.equal(approval.status, "EXECUTION_BLOCKED");
  assert.equal(store.runs.get(first.runId).run_status, "COMPLETED");
  assert.ok(store.events.some((event) => event.payload.to === "EXECUTION_BLOCKED"));
  assert.equal(store.executionCalls, 0);

  const duplicate = await orchestrator.run(request);
  assert.equal(duplicate.status, "COMPLETED");
  assert.equal(duplicate.proposalId, null);
  assert.equal(store.analyses, 1);
});

test("control APIs reject unauthenticated access before initializing storage", async () => {
  let storageTouched = false;
  const response = await handleAgentControlGet(new Request("https://wolv.test/api/agent/control"), {
    authorize: async () => "unauthorized",
    createStore: () => {
      storageTouched = true;
      return createFakeStore(1_000);
    },
  });
  assert.equal(response.status, 401);
  assert.equal(storageTouched, false);
});

test("activity API validates filters and returns persisted records only", async () => {
  const store = createFakeStore(1_000);
  const invalid = await handleAgentControlGet(new Request(
    "https://wolv.test/api/agent/control?since=not-a-time",
  ), {
    authorize: async () => "authorized",
    getOwnerAddress: async () => OWNER_ADDRESS,
    createStore: () => store,
  });
  assert.equal(invalid.status, 400);

  const response = await handleAgentControlGet(new Request(
    "https://wolv.test/api/agent/control?agentId=test-agent&limit=5",
  ), {
    authorize: async () => "authorized",
    getOwnerAddress: async () => OWNER_ADDRESS,
    createStore: () => store,
    now: () => 1_000,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.execution.status, "EXECUTION_BLOCKED");
  assert.deepEqual(result.activity, []);
  assert.equal(result.configuration.orchestrationEnabled, false);
});

test("operator control enablement is explicitly time-limited and stop persists a kill-switch event", async () => {
  const originalEnabled = process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED;
  process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED = "true";
  const now = 1_700_000_000_000;
  const store = createFakeStore(now);
  try {
    const enableResponse = await handleAgentControlPost(jsonRequest({
      action: "ENABLE",
      reason: "operator test",
      permissionTtlMs: 15 * 60_000,
    }), {
      authorize: async () => "authorized",
      getOwnerAddress: async () => OWNER_ADDRESS,
      createStore: () => store,
      now: () => now,
    });
    assert.equal(enableResponse.status, 200);
    assert.equal(store.control.permissionExpiresAt, now + 15 * 60_000);
    const stopResponse = await handleAgentControlPost(jsonRequest({
      action: "STOP",
      reason: "operator test stop",
    }), {
      authorize: async () => "authorized",
      getOwnerAddress: async () => OWNER_ADDRESS,
      createStore: () => store,
      now: () => now + 1,
    });
    assert.equal(stopResponse.status, 200);
    assert.equal(store.control.emergency_stop, true);
    assert.ok(store.globalEvents.some((event) => event.eventType === "EMERGENCY_STOP_ACTIVATED"));
  } finally {
    if (originalEnabled === undefined) delete process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED;
    else process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED = originalEnabled;
  }
});

test("proposal decision endpoint validates the payload and reports blocked execution", async () => {
  const proposalId = randomUUID();
  const runId = randomUUID();
  const store = createFakeStore(1_000);
  store.runs.set(runId, { run_id: runId, run_status: "AWAITING_USER_APPROVAL" });
  store.proposals.set(proposalId, {
    proposal_id: proposalId,
    run_id: runId,
    runId,
    proposal_status: "AWAITING_USER_APPROVAL",
    proposal_hash: "a".repeat(64),
    user_decision: null,
  });
  const response = await fetchProposal(proposalId, store);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "EXECUTION_BLOCKED");
  assert.equal(body.execution, "BLOCKED");
  assert.equal(store.executionCalls, 0);
});

test("policy API refuses malformed policy data and activates only a validated explicit version", async (t) => {
  const now = Date.now();
  const store = createFakeStore(now);
  const policy = {
    version: "test-policy",
    approvedAssets: ADDRESSES,
    approvedDirections: ["BUY"],
    maxOrderValue: "100",
    maxDailyExposure: "1000",
    maxSlippageBps: 100,
    maxReferenceDeviationPercent: 2,
    allowedSessions: ["US_REGULAR"],
    minimumBalance: "1",
    quoteTtlMs: 60_000,
    permissionExpiresAt: now + 120_000,
    emergencyStop: false,
  };
  await t.test("invalid order value", async () => {
    const response = await handleAgentPolicyPost(jsonRequest({
      name: "default",
      policy: { ...policy, maxOrderValue: "0" },
      activate: true,
    }, "https://wolv.test/api/agent/policy"), {
      authorize: async () => "authorized",
      getOwnerAddress: async () => OWNER_ADDRESS,
      createStore: () => store,
      now: () => now,
    });
    assert.equal(response.status, 422);
  });
  await t.test("valid explicit activation", async () => {
    let received;
    store.savePolicy = async (ownerAddress, name, value, createdAt, active) => {
      received = { ownerAddress, name, value, createdAt, active };
      return randomUUID();
    };
    const response = await handleAgentPolicyPost(jsonRequest({
      name: "default",
      policy,
      activate: true,
    }, "https://wolv.test/api/agent/policy"), {
      authorize: async () => "authorized",
      getOwnerAddress: async () => OWNER_ADDRESS,
      createStore: () => store,
      now: () => now,
    });
    const responseBody = await response.json();
    assert.equal(response.status, 201, JSON.stringify(responseBody));
    assert.deepEqual(received, { ownerAddress: OWNER_ADDRESS, name: "default", value: policy, createdAt: now, active: true });
  });
});

test("legacy agent BAW execution and approval routes are explicitly blocked", async () => {
  const execution = await postLegacyAgentAction(jsonRequest({
    action: "executeBaw",
    executionId: randomUUID(),
    approvalToken: "mock",
    securityAuditAcknowledged: true,
  }));
  assert.equal(execution.status, 403);
  assert.match((await execution.json()).error, /blocked during Phase 4\.0/);

  const approval = await postLegacyApproval(jsonRequest({ quote: {} }));
  assert.equal(approval.status, 403);
  assert.equal((await approval.json()).code, "EXECUTION_BLOCKED");

  const reconciliation = await getLegacyExecutionStatus();
  assert.equal(reconciliation.status, 403);
  assert.equal((await reconciliation.json()).execution, "BLOCKED");
});

function jsonRequest(body, url = "https://wolv.test/api/agent/control") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchProposal(proposalId, store) {
  const { handleAgentProposalPost } = await import("../services/agentControlHttp.ts");
  return handleAgentProposalPost(jsonRequest({ proposalId, action: "APPROVE" }), {
    authorize: async () => "authorized",
    getOwnerAddress: async () => OWNER_ADDRESS,
    createStore: () => store,
    now: () => 2_000,
  });
}

function createFakeStore(nowSource) {
  const getNow = typeof nowSource === "function" ? nowSource : () => nowSource;
  const store = {
    assets: new Map(),
    observations: [],
    events: [],
    globalEvents: [],
    opportunities: new Map(),
    proposals: new Map(),
    runs: new Map(),
    observationKeys: new Map(),
    policy: null,
    analyses: 0,
    executionCalls: 0,
    recoveryCalls: [],
    control: {
      emergency_stop: false,
      stop_monitoring: false,
      reject_new_opportunities: false,
      stop_reason: "fixture control",
      permissionExpiresAt: getNow() + 300_000,
    },
    async initialize() {},
    async close() {},
    async getControlState(now = getNow()) {
      return {
        emergency_stop: this.control.emergency_stop,
        stop_monitoring: this.control.stop_monitoring,
        reject_new_opportunities: this.control.reject_new_opportunities,
        stop_reason: this.control.stop_reason,
        permission_expires_at: this.control.permissionExpiresAt,
        permission_active: !this.control.emergency_stop && this.control.permissionExpiresAt > now,
      };
    },
    async createRun(input, runId = randomUUID()) {
      this.runs.set(runId, { ...input, run_id: runId, run_status: "INITIALIZING" });
      this.events.push({ runId, payload: { from: "IDLE", to: "INITIALIZING" } });
      return runId;
    },
    async transitionRun(runId, nextState, event) {
      const run = this.runs.get(runId);
      assert.ok(run);
      run.run_status = nextState;
      this.events.push({ runId, eventType: event.eventType, payload: { ...event.payload, to: nextState } });
    },
    async appendEvent(runId, event) {
      if (runId === null) this.globalEvents.push(event);
      else this.events.push({ runId, ...event });
      return randomUUID();
    },
    async recordAssetVersion(input) {
      const assetId = `fixture-asset-${input.tokenAddress.toLowerCase()}`;
      this.assets.set(assetId, input);
      return { assetId, created: true };
    },
    async recordObservation(input) {
      const existing = this.observationKeys.get(input.idempotencyKey);
      if (existing) return { observationId: existing, created: false };
      const observationId = randomUUID();
      this.observations.push({ ...input, observation_id: observationId });
      this.observationKeys.set(input.idempotencyKey, observationId);
      return { observationId, created: true };
    },
    async recordCandle() {
      return { candleId: randomUUID(), created: true };
    },
    async listActivity() {
      return { items: [], nextCursor: null };
    },
    async listProposals() {
      return [];
    },
    async getPolicyRefusals() {
      return [];
    },
    async listOpportunities() {
      return [];
    },
    async listAnalyses() {
      return [];
    },
    async getStrategyEvaluations() {
      return [];
    },
    async getOpportunityEvidence() {
      return this.observations.map((observation) => {
        const asset = this.assets.get(observation.assetId);
        return {
          currency: observation.currency,
          price: observation.price,
          reference_price: observation.referencePrice,
          provider_timestamp: observation.providerTimestamp,
          ingested_at: observation.ingestedAt,
          freshness_ms: observation.freshnessMs,
          verification_status: observation.verificationStatus,
          price_kind: observation.priceKind,
          asset_id: observation.assetId,
          observation_id: observation.observation_id,
          token_address: asset.tokenAddress,
          ticker: asset.ticker,
          platform: asset.platform,
          normalized_share_price: observation.price,
        };
      });
    },
    async getRecentObservations() {
      return [];
    },
    async recordOpportunity(input) {
      const existing = this.opportunities.get(input.detectionKey);
      if (existing) return { opportunityId: existing, created: false };
      this.opportunities.set(input.detectionKey, input.opportunityId);
      return { opportunityId: input.opportunityId, created: true };
    },
    async recordAnalysis() {
      this.analyses += 1;
      return randomUUID();
    },
    async getDailyExposure() {
      return "0";
    },
    async getActivePolicy() {
      return this.policy;
    },
    async savePolicy() {
      return randomUUID();
    },
    async recordPolicyDecision() {},
    async createProposal(input, proposalId) {
      this.proposals.set(proposalId, {
        ...input,
        proposal_id: proposalId,
        proposal_hash: "b".repeat(64),
        proposal_status: "AWAITING_USER_APPROVAL",
        user_decision: null,
      });
      return { proposalId, proposalHash: "b".repeat(64) };
    },
    async getProposal(proposalId) {
      return this.proposals.get(proposalId) ?? null;
    },
    async expirePendingProposals() {
      return 0;
    },
    async expireOpportunities() {
      return 0;
    },
    async recoverStaleRuns(now, staleBefore) {
      this.recoveryCalls.push({ now, staleBefore });
      return 0;
    },
    async decideProposal(proposalId, ownerAddress, action) {
      const proposal = this.proposals.get(proposalId);
      assert.ok(proposal);
      if (action === "APPROVE") {
        proposal.proposal_status = "EXECUTION_BLOCKED";
        proposal.user_decision = "APPROVED";
        const run = this.runs.get(proposal.runId);
        run.run_status = "USER_APPROVED";
        this.events.push({ runId: run.run_id, payload: { to: "USER_APPROVED" } });
        run.run_status = "EXECUTION_BLOCKED";
        this.events.push({ runId: run.run_id, payload: { to: "EXECUTION_BLOCKED" } });
        run.run_status = "COMPLETED";
        this.events.push({ runId: run.run_id, payload: { to: "COMPLETED" } });
        return { status: "EXECUTION_BLOCKED", decision: "APPROVED" };
      }
      proposal.proposal_status = "USER_REJECTED";
      proposal.user_decision = "REJECTED";
      return { status: "USER_REJECTED", decision: "REJECTED" };
    },
    async setEmergencyStop(input) {
      this.control.emergency_stop = input.stopped;
      this.control.stop_monitoring = input.stopped;
      this.control.reject_new_opportunities = input.stopped;
      this.control.stop_reason = input.reason;
      this.control.permissionExpiresAt = input.permissionExpiresAt;
      this.globalEvents.push({
        eventType: input.stopped ? "EMERGENCY_STOP_ACTIVATED" : "EMERGENCY_STOP_CLEARED",
      });
    },
  };
  return store;
}
