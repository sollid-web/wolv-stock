import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { BrowserTradeIntentStore, hashQuoteBinding } from "../services/browserTradeIntentStore.ts";
import { BawExecutionStore } from "../services/bawExecutionStore.ts";
import { AgentMemoryStore } from "../services/agentMemoryStore.ts";
import { AgentOrchestrator } from "../services/agentOrchestrator.ts";
import { MarketDataCollector } from "../services/marketDataCollector.ts";
import {
  handleAgentProposalPost,
  handleAgentRunGet,
} from "../services/agentControlHttp.ts";

const TEST_DATABASE_URL = process.env.TEST_POSTGRES_URL;

if (!TEST_DATABASE_URL) {
  console.error("PostgreSQL integration tests are blocked: set TEST_POSTGRES_URL to a disposable database URL before running npm run test:postgres.");
  process.exit(1);
}

const testUrl = new URL(TEST_DATABASE_URL);
const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const databaseName = decodeURIComponent(testUrl.pathname.slice(1));
const databaseNameParts = databaseName.toLowerCase().split(/[_-]/);
if (!["postgres:", "postgresql:"].includes(testUrl.protocol) || !testUrl.username || !testUrl.password) {
  throw new Error("TEST_POSTGRES_URL must be a PostgreSQL connection string for a disposable test database.");
}
if (
  !allowedHosts.has(testUrl.hostname) ||
  !databaseNameParts.some((part) => part === "test" || part === "testing")
) {
  throw new Error("TEST_POSTGRES_URL must target a local PostgreSQL database whose name contains a test component.");
}

const browserStore = new BrowserTradeIntentStore(TEST_DATABASE_URL);
const bawStore = new BawExecutionStore(TEST_DATABASE_URL);
const concurrentBrowserStore = new BrowserTradeIntentStore(TEST_DATABASE_URL);

before(async () => {
  await browserStore.initialize();
});

after(async () => {
  await browserStore.close();
  await concurrentBrowserStore.close();
  await bawStore.close();
  const sql = (await import("postgres")).default;
  const cleanup = sql(TEST_DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 3, prepare: false });
  try {
    await cleanup`DROP TABLE IF EXISTS wolv_trade_intents;`;
    await cleanup`DROP TABLE IF EXISTS wolv_trading_schema_migrations;`;
    await cleanup`DROP TABLE IF EXISTS baw_executions;`;
    await cleanup`DROP TABLE IF EXISTS baw_auth_challenges;`;
    await cleanup`DROP TABLE IF EXISTS baw_auth_sessions;`;
    await cleanup`DROP TABLE IF EXISTS baw_execution_schema_migrations;`;
    await cleanup`
      DROP TABLE IF EXISTS wolv_agent_memory_migrations, wolv_agent_market_candles,
        wolv_agent_market_observations, wolv_agent_asset_history, wolv_agent_runs,
        wolv_agent_events, wolv_agent_opportunities, wolv_agent_analyses,
        wolv_agent_policy_decisions, wolv_agent_risk_policies, wolv_agent_proposals,
        wolv_agent_control, wolv_strategy_evaluations CASCADE
    `;
    await cleanup`DROP FUNCTION IF EXISTS wolv_agent_events_are_append_only();`;
    await cleanup`DROP FUNCTION IF EXISTS wolv_agent_proposals_material_immutable();`;
  } finally {
    await cleanup.end({ timeout: 3 });
  }
});

test("browser trade intent store creates and retrieves durable records", async () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const quoteBinding = "retrieval-quote-binding";
  const intent = {
    executionId,
    quoteBindingHash: hashQuoteBinding(quoteBinding),
    quoteId: "11111111111111111111111111111111",
    walletAddress: "0x1111111111111111111111111111111111111111",
    chainId: 56,
    direction: "BUY",
    inputTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    outputTokenAddress: "0x0000000000000000000000000000000000000123",
    inputAmount: "1000000000000000000",
    expectedOutputAmount: "1000000000000000000",
    minimumOutputAmount: "900000000000000000",
    slippageBps: 50,
    quoteFetchedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    state: "CREATED",
    idempotencyKey: null,
    transactionHash: null,
    providerOrderId: null,
    failureCode: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  await browserStore.create(intent);
  const loaded = await browserStore.get(executionId);
  assert.ok(loaded);
  assert.equal(loaded.executionId, executionId);
  assert.equal(loaded.state, "CREATED");
});

test("browser trade intent store rejects expired and consumed quotes", async () => {
  const now = Date.now();
  const executionId = "22222222-2222-4222-8222-222222222222";
  const quoteBinding = "expired-quote-binding";
  const intent = {
    executionId,
    quoteBindingHash: hashQuoteBinding(quoteBinding),
    quoteId: "22222222222222222222222222222222",
    walletAddress: "0x2222222222222222222222222222222222222222",
    chainId: 56,
    direction: "BUY",
    inputTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    outputTokenAddress: "0x0000000000000000000000000000000000000456",
    inputAmount: "1000000000000000000",
    expectedOutputAmount: "1000000000000000000",
    minimumOutputAmount: "900000000000000000",
    slippageBps: 50,
    quoteFetchedAt: now,
    expiresAt: now + 60_000,
    state: "CREATED",
    idempotencyKey: null,
    transactionHash: null,
    providerOrderId: null,
    failureCode: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  await browserStore.create(intent);
  await assert.rejects(() => browserStore.prepare(executionId, intent.walletAddress, intent.expiresAt + 1), /EXPIRED|CONSUMED/);
  const consumableIntent = {
    ...intent,
    executionId: "66666666-6666-4666-8666-666666666666",
    quoteBindingHash: hashQuoteBinding("not-expired-quote-binding"),
    quoteId: "2222222222222222222222222222222b",
  };
  await browserStore.create(consumableIntent);
  const prepared = await browserStore.prepare(
    consumableIntent.executionId,
    consumableIntent.walletAddress,
    consumableIntent.quoteFetchedAt + 1_000,
  );
  assert.equal(prepared.state, "PREPARED");
  await assert.rejects(
    () => browserStore.prepare(consumableIntent.executionId, consumableIntent.walletAddress, consumableIntent.quoteFetchedAt + 2_000),
    /CONSUMED/,
  );
});

test("browser trade intent store enforces single-use claim and idempotent submission", async () => {
  const executionId = "33333333-3333-4333-8333-333333333333";
  const quoteBinding = "concurrent-claim-quote-binding";
  const intent = {
    executionId,
    quoteBindingHash: hashQuoteBinding(quoteBinding),
    quoteId: "33333333333333333333333333333333",
    walletAddress: "0x3333333333333333333333333333333333333333",
    chainId: 56,
    direction: "BUY",
    inputTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    outputTokenAddress: "0x0000000000000000000000000000000000000789",
    inputAmount: "1000000000000000000",
    expectedOutputAmount: "1000000000000000000",
    minimumOutputAmount: "900000000000000000",
    slippageBps: 50,
    quoteFetchedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    state: "CREATED",
    idempotencyKey: null,
    transactionHash: null,
    providerOrderId: null,
    failureCode: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  await browserStore.create(intent);
  const prepared = await browserStore.prepare(executionId, intent.walletAddress, intent.quoteFetchedAt + 100);
  const idempotencyKeys = [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  const claims = await Promise.allSettled([
    browserStore.claimSubmission(executionId, idempotencyKeys[0], prepared.quoteFetchedAt + 200),
    concurrentBrowserStore.claimSubmission(executionId, idempotencyKeys[1], prepared.quoteFetchedAt + 200),
  ]);
  const winners = claims.filter((claim) => claim.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.ok(winners[0].status === "fulfilled");
  assert.equal(winners[0].value.state, "SUBMISSION_PENDING");
  const winningKey = winners[0].value.idempotencyKey;
  assert.ok(winningKey);
  const retry = await browserStore.claimSubmission(executionId, winningKey, prepared.quoteFetchedAt + 300);
  assert.equal(retry.state, "SUBMISSION_PENDING");
  assert.equal(retry.idempotencyKey, winningKey);
  const loser = claims.find((claim) => claim.status === "rejected");
  assert.ok(loser?.status === "rejected");
  assert.match(String(loser.reason), /CONSUMED/);
  const updated = await browserStore.updateSubmission(executionId, "SUBMITTED", { transactionHash: "0x" + "a".repeat(64), providerOrderId: "order-1" }, prepared.quoteFetchedAt + 500);
  assert.equal(updated.state, "SUBMITTED");
});

test("BawExecutionStore enforces durable approval consumption and reject invalid transitions", async () => {
  const now = Date.now();
  const executionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const record = {
    executionId,
    approvalReference: "approval-1",
    quoteReference: "binding-1",
    walletAddress: "0x4444444444444444444444444444444444444444",
    tokenAddress: "0x0000000000000000000000000000000000000123",
    tokenDecimals: 18,
    fromTokenDecimals: 18,
    toTokenDecimals: 18,
    underlyingTicker: "AAPL",
    tokenSymbol: "AAPLon",
    fromCoinSymbol: "USDT",
    toCoinSymbol: "AAPLon",
    direction: "BUY",
    chainId: "56",
    fromTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    toTokenAddress: "0x0000000000000000000000000000000000000123",
    requestedInputAmount: "10",
    expectedOutputAmount: "0.1",
    minimumOutputAmount: "0.09",
    quoteBinding: "quote-binding",
    quoteFetchedAt: now,
    referencePrice: 100,
    tokenPriceUsd: 100,
    referenceGapPercent: 0.5,
    slippageBps: 50,
    quoteExpiresAt: now + 60_000,
    notionalUsd: 10,
    state: "APPROVAL_REQUIRED",
    securityAuditAcknowledged: false,
    providerOrderId: null,
    actualExecutedInput: null,
    actualReceivedOutput: null,
    refunds: [],
    averageExecutionPrice: null,
    transactionHash: null,
    failureReason: null,
    submittedAt: null,
    completedAt: null,
  };

  const tokenHash = "a".repeat(64);
  await bawStore.createApproval(record, tokenHash, record.quoteExpiresAt, now);
  const consumed = await bawStore.consumeApproval(executionId, tokenHash, now + 10_000);
  assert.equal(consumed.state, "APPROVED");
  await assert.rejects(() => bawStore.consumeApproval(executionId, tokenHash, now + 20_000), /USED|NOT_FOUND/);
});

test("agent control-plane PostgreSQL persistence, ownership, recovery, approvals, and execution isolation", async () => {
  const ownerA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ownerB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const tokenA = "0x0000000000000000000000000000000000000101";
  const tokenB = "0x0000000000000000000000000000000000000102";
  let now = Date.now();
  const store = new AgentMemoryStore(TEST_DATABASE_URL);
  let restartedStore;

  const policyFor = (version, maxOrderValue, permissionExpiresAt) => ({
    version,
    approvedAssets: [tokenA, tokenB],
    approvedDirections: ["BUY"],
    maxOrderValue,
    maxDailyExposure: "1000",
    maxSlippageBps: 100,
    maxReferenceDeviationPercent: 2,
    allowedSessions: ["US_REGULAR"],
    minimumBalance: "1",
    quoteTtlMs: 60_000,
    permissionExpiresAt,
    emergencyStop: false,
  });
  const analysisProvider = {
    async analyze(input) {
      return {
        modelIdentifier: "deterministic-postgres-fixture",
        modelVersion: "1",
        interpretation: "Fixture prices are verified indicative observations.",
        opportunityExplanation: input.opportunity.reason,
        historicalComparison: "No prior observations are available.",
        upsideScenario: "The observed spread could narrow.",
        downsideScenario: "The observed spread could widen.",
        risks: ["Indicative values are not executable."],
        dataLimitations: ["Synthetic PostgreSQL integration fixture."],
        invalidatingConditions: ["A fresh observation changes the spread."],
        suggestedNextAction: "Review only; do not execute.",
        evidenceReferences: input.opportunity.evidenceIds,
        assumptions: [],
      };
    },
  };
  const runRequest = (agentId) => ({
    ownerAddress: ownerA,
    agentId,
    watchlist: [tokenA, tokenB],
    strategyConfiguration: {
      minimumAbsoluteSpreadPercent: 0.5,
      intendedAmount: "0.05",
      notionalValue: "5",
      maximumSlippageBps: 50,
    },
  });
  const buildAdapter = () => ({
    providerId: "deterministic-postgres-fixture",
    async loadCatalogue(addresses) {
      return addresses.map((tokenAddress, index) => ({
        chainId: 56,
        tokenAddress,
        ticker: "TST",
        platform: index === 0 ? "fixture-a" : "fixture-b",
        decimals: 18,
        shareDenomination: { tokenToShareRatio: "1" },
        metadataSource: "deterministic-postgres-fixture",
        observedAt: now,
        blockNumber: null,
        blockHash: null,
        metadata: { tokenName: "Test Spot Asset" },
      }));
    },
    async observe(asset) {
      return {
        price: asset.platform === "fixture-a" ? "100" : "101",
        referencePrice: asset.platform === "fixture-a" ? "100" : "101",
        bid: null,
        ask: null,
        spreadPercent: null,
        currency: "USD",
        priceKind: "INDICATIVE",
        source: "deterministic-postgres-fixture",
        providerTimestamp: now,
        ingestedAt: now,
        freshnessMs: 60_000,
        verificationStatus: "VERIFIED",
        provenance: { fixture: true, sourceTimestamp: now },
      };
    },
  });
  const makeOrchestrator = (db, { quoteTtl = 30_000 } = {}) => {
    const collector = new MarketDataCollector(db, buildAdapter(), { enabled: true, now: () => now });
    return new AgentOrchestrator(db, collector, analysisProvider, {
      enabled: true,
      now: () => now,
      policyContext: async () => ({
        slippageBps: 50,
        referenceDeviationPercent: 0,
        dataFresh: true,
        quoteExpiresAt: now + quoteTtl,
        availableBalance: "1000",
        session: "US_REGULAR",
        quoteReference: "deterministic-quote-reference",
        expectedInput: "5",
        expectedOutput: "0.05",
      }),
    });
  };
  const proposalRequest = (ownerAddress, proposalId, action, currentTime = now) =>
    handleAgentProposalPost(new Request("https://wolv.test/api/agent/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId, action }),
    }), {
      authorize: async () => "authorized",
      getOwnerAddress: async () => ownerAddress,
      now: () => currentTime,
      createStore: () => new AgentMemoryStore(TEST_DATABASE_URL),
    });

  try {
    await store.initialize();
    await store.setEmergencyStop({
      ownerAddress: ownerA,
      stopped: false,
      reason: "Disposable integration fixture",
      permissionExpiresAt: now + 25 * 60_000,
      updatedAt: now,
      correlationId: randomUUID(),
    });

    const oldAsset = await store.recordAssetVersion({
      chainId: 56,
      tokenAddress: tokenA,
      ticker: "TST",
      platform: "fixture-a",
      decimals: 18,
      shareDenomination: { tokenToShareRatio: "1" },
      metadataSource: "fixture-catalogue",
      observedAt: now - 20_000,
      blockNumber: "100",
      blockHash: null,
      metadata: { tokenName: "Test Spot Asset", version: 1 },
    });
    const currentAsset = await store.recordAssetVersion({
      chainId: 56,
      tokenAddress: tokenA,
      ticker: "TST",
      platform: "fixture-a",
      decimals: 18,
      shareDenomination: { tokenToShareRatio: "1" },
      metadataSource: "fixture-catalogue",
      observedAt: now - 10_000,
      blockNumber: "101",
      blockHash: null,
      metadata: { tokenName: "Test Spot Asset", version: 2 },
    });
    assert.notEqual(oldAsset.assetId, currentAsset.assetId);
    assert.equal((await store.getAssetHistory(ownerA, 56, tokenA)).length, 2);

    const observation = {
      ownerAddress: ownerA,
      assetId: currentAsset.assetId,
      price: "99.5",
      referencePrice: "100",
      bid: null,
      ask: null,
      spreadPercent: null,
      currency: "USD",
      priceKind: "INDICATIVE",
      source: "fixture-provider",
      providerTimestamp: now - 5_000,
      ingestedAt: now,
      freshnessMs: 60_000,
      verificationStatus: "VERIFIED",
      provenance: { fixture: "postgres-integration", providerSequence: 11 },
      idempotencyKey: "1".repeat(64),
    };
    const storedObservation = await store.recordObservation(observation);
    const duplicateObservation = await store.recordObservation(observation);
    assert.equal(storedObservation.created, true);
    assert.equal(duplicateObservation.created, false);
    assert.equal(duplicateObservation.observationId, storedObservation.observationId);
    assert.equal((await store.recordObservation({
      ...observation,
      ownerAddress: ownerB,
    })).created, true);
    const ownObservations = await store.getRecentObservations({
      ownerAddress: ownerA,
      assetId: currentAsset.assetId,
      since: now - 10_000,
      limit: 10,
    });
    assert.equal(ownObservations.length, 1);
    assert.equal(ownObservations[0].provider_timestamp, new Date(now - 5_000).toISOString());
    assert.deepEqual(ownObservations[0].provenance, observation.provenance);
    assert.equal((await store.getRecentObservations({ ownerAddress: ownerB, assetId: currentAsset.assetId })).length, 1);
    assert.equal((await store.getRecentObservations({
      ownerAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      assetId: currentAsset.assetId,
    })).length, 0);

    const candle = {
      ownerAddress: ownerA,
      assetId: currentAsset.assetId,
      interval: "1m",
      open: "99",
      high: "102",
      low: "98",
      close: "101",
      volume: "10",
      openingAt: now - 60_000,
      closingAt: now,
      provider: "fixture-provider",
      verificationStatus: "VERIFIED",
      provenance: { fixture: true },
    };
    assert.equal((await store.recordCandle(candle)).created, true);
    assert.equal((await store.recordCandle(candle)).created, false);
    assert.equal((await store.getCandles({
      ownerAddress: ownerA,
      assetId: currentAsset.assetId,
      interval: "1m",
      since: now - 60_000,
    })).length, 1);

    const interruptedRunId = await store.createRun({
      ownerAddress: ownerA,
      agentId: "pg-interrupted-run",
      strategyId: "fixture",
      strategyVersion: "1",
      triggerType: "TEST",
      startedAt: now - 600_000,
      configuration: { fixture: true },
    });
    await store.transitionRun(interruptedRunId, "MONITORING", {
      eventType: "STATE_CHANGED",
      occurredAt: now - 600_000,
      correlationId: interruptedRunId,
      payload: {},
      provenance: { source: "integration-test" },
    });
    await assert.rejects(
      store.transitionRun(interruptedRunId, "COMPLETED", {
        eventType: "STATE_CHANGED",
        occurredAt: now,
        correlationId: interruptedRunId,
        payload: {},
      }),
      (error) => error?.code === "INVALID_TRANSITION",
    );
    const dedupeEvent = {
      eventType: "RECOVERY_CHECKPOINT",
      occurredAt: now,
      correlationId: interruptedRunId,
      payload: { phase: "before-restart" },
      provenance: { source: "integration-test" },
      idempotencyKey: `recovery:${interruptedRunId}`,
    };
    const eventId = await store.appendEvent(interruptedRunId, dedupeEvent);
    assert.equal(await store.appendEvent(interruptedRunId, dedupeEvent), eventId);
    const preRestartEventCount = (await store.reconstructRun(interruptedRunId, ownerA)).events.length;
    const sql = (await import("postgres")).default(TEST_DATABASE_URL, { max: 1, prepare: false });
    try {
      await assert.rejects(
        sql`UPDATE wolv_agent_events SET event_payload = '{}' WHERE event_id = ${eventId}`,
        /append-only/i,
      );
    } finally {
      await sql.end({ timeout: 3 });
    }

    restartedStore = new AgentMemoryStore(TEST_DATABASE_URL);
    await restartedStore.initialize();
    assert.equal(await restartedStore.recoverStaleRuns(now, now - 300_000, ownerA), 1);
    assert.equal(await restartedStore.recoverStaleRuns(now, now - 300_000, ownerA), 0);
    const recoveredRun = await restartedStore.reconstructRun(interruptedRunId, ownerA);
    assert.equal(recoveredRun.run.run_status, "FAILED");
    assert.equal(recoveredRun.events.length, preRestartEventCount + 1);
    assert.equal((await restartedStore.reconstructRun(interruptedRunId, ownerB)), null);
    assert.ok(recoveredRun.events.every((event, index) =>
      Number(event.sequence_number) === index + 1 &&
      event.correlation_id === interruptedRunId));

    await restartedStore.savePolicy(ownerA, "default", policyFor("accept-v1", "100", now + 20 * 60_000), now, true);
    const successfulRun = await makeOrchestrator(restartedStore).run(runRequest("pg-successful-flow"));
    assert.equal(successfulRun.status, "AWAITING_USER_APPROVAL");
    assert.ok(successfulRun.opportunityId && successfulRun.analysisId && successfulRun.proposalId);
    const successfulProposal = await restartedStore.getProposal(successfulRun.proposalId, ownerA);
    assert.equal(successfulProposal.proposal_status, "AWAITING_USER_APPROVAL");
    assert.ok((await restartedStore.getPriorAnalyses(ownerA, String(successfulProposal.asset_id)))
      .some((analysis) => analysis.analysis_id === successfulRun.analysisId));
    const successfulOpportunity = (await restartedStore.listOpportunities({ ownerAddress: ownerA, limit: 20 }))
      .find((opportunity) => opportunity.opportunity_id === successfulRun.opportunityId);
    assert.ok(successfulOpportunity);
    assert.ok(Array.isArray(successfulOpportunity.evidence.observationIds));
    assert.ok(successfulOpportunity.evidence.observationIds.length >= 2);
    const successfulHistory = await restartedStore.reconstructRun(successfulRun.runId, ownerA);
    assert.ok(successfulHistory.events.some((event) => event.event_type === "ANALYSIS_RECORDED"));
    assert.ok(successfulHistory.events.some((event) => event.event_type === "POLICY_ACCEPTED"));

    const proposalSql = (await import("postgres")).default(TEST_DATABASE_URL, { max: 1, prepare: false });
    try {
      await assert.rejects(
        proposalSql`UPDATE wolv_agent_proposals SET intended_amount = intended_amount + 1 WHERE proposal_id = ${successfulRun.proposalId}`,
        /material fields are immutable/i,
      );
    } finally {
      await proposalSql.end({ timeout: 3 });
    }

    const crossOwnerRunResponse = await handleAgentRunGet(
      new Request(`https://wolv.test/api/agent/run?runId=${successfulRun.runId}`),
      {
        authorize: async () => "authorized",
        getOwnerAddress: async () => ownerB,
        createStore: () => new AgentMemoryStore(TEST_DATABASE_URL),
      },
    );
    assert.equal(crossOwnerRunResponse.status, 404);
    const crossOwnerProposalResponse = await proposalRequest(ownerB, successfulRun.proposalId, "APPROVE");
    assert.equal(crossOwnerProposalResponse.status, 404);
    const unauthenticatedRunResponse = await handleAgentRunGet(
      new Request(`https://wolv.test/api/agent/run?runId=${successfulRun.runId}`),
      {
        authorize: async () => "unauthorized",
        createStore: () => { throw new Error("Store must not be constructed before authentication."); },
      },
    );
    assert.equal(unauthenticatedRunResponse.status, 401);

    const approvalResponse = await proposalRequest(ownerA, successfulRun.proposalId, "APPROVE");
    assert.equal(approvalResponse.status, 200);
    assert.equal((await approvalResponse.json()).execution, "BLOCKED");
    const approvedHistory = await restartedStore.reconstructRun(successfulRun.runId, ownerA);
    assert.equal(approvedHistory.run.run_status, "COMPLETED");
    assert.equal(
      (await restartedStore.getProposal(successfulRun.proposalId, ownerA)).proposal_status,
      "EXECUTION_BLOCKED",
    );
    assert.ok(approvedHistory.events.some((event) => event.event_payload.to === "EXECUTION_BLOCKED"));
    const eventCountAfterApproval = approvedHistory.events.length;
    assert.equal((await proposalRequest(ownerA, successfulRun.proposalId, "APPROVE")).status, 409);
    assert.equal((await restartedStore.reconstructRun(successfulRun.runId, ownerA)).events.length, eventCountAfterApproval);

    now += 1_000;
    await restartedStore.savePolicy(ownerA, "default", policyFor("reject-v1", "1", now + 20 * 60_000), now, true);
    const policyRejectedRun = await makeOrchestrator(restartedStore).run(runRequest("pg-policy-refusal"));
    assert.equal(policyRejectedRun.status, "COMPLETED");
    assert.equal(policyRejectedRun.proposalId, null);
    assert.ok(policyRejectedRun.refusalReasons.some((reason) => /maximum/i.test(reason)));
    assert.ok((await restartedStore.getPolicyRefusals(ownerA, 20))
      .some((decision) => decision.run_id === policyRejectedRun.runId));
    const refusalHistory = await restartedStore.reconstructRun(policyRejectedRun.runId, ownerA);
    assert.ok(refusalHistory.events.some((event) => event.event_type === "POLICY_REJECTED"));
    assert.ok(!refusalHistory.events.some((event) => event.event_type === "TRADE_PROPOSAL_CREATED"));

    now += 1_000;
    await restartedStore.savePolicy(ownerA, "default", policyFor("accept-v2", "100", now + 20 * 60_000), now, true);
    const rejectedProposalRun = await makeOrchestrator(restartedStore).run(runRequest("pg-user-rejection"));
    const rejectionResponse = await proposalRequest(ownerA, rejectedProposalRun.proposalId, "REJECT");
    assert.equal(rejectionResponse.status, 200);
    assert.equal((await rejectionResponse.json()).status, "USER_REJECTED");
    assert.ok((await restartedStore.reconstructRun(rejectedProposalRun.runId, ownerA)).events
      .some((event) => event.event_payload.to === "USER_REJECTED"));

    now += 1_000;
    const expiringRun = await makeOrchestrator(restartedStore).run(runRequest("pg-expired-proposal"));
    now += 31_000;
    const expiredResponse = await proposalRequest(ownerA, expiringRun.proposalId, "APPROVE", now);
    assert.equal(expiredResponse.status, 200);
    assert.equal((await expiredResponse.json()).status, "EXPIRED");
    assert.equal((await restartedStore.getProposal(expiringRun.proposalId, ownerA)).proposal_status, "EXPIRED");
    assert.ok((await restartedStore.reconstructRun(expiringRun.runId, ownerA)).events
      .some((event) => event.event_payload.to === "EXPIRED"));

    await restartedStore.setEmergencyStop({
      ownerAddress: ownerA,
      stopped: true,
      reason: "Integration kill-switch check",
      permissionExpiresAt: null,
      updatedAt: now,
      correlationId: randomUUID(),
    });
    const controlState = await restartedStore.getControlState(now);
    assert.equal(controlState.emergency_stop, true);
    assert.equal(controlState.permission_active, false);
    await assert.rejects(
      makeOrchestrator(restartedStore).run(runRequest("pg-emergency-stop")),
      { code: "EMERGENCY_STOP" },
    );
    assert.equal((await restartedStore.listProposals(ownerB, 20)).length, 0);
  } finally {
    await restartedStore?.close();
    await store.close();
  }
});
