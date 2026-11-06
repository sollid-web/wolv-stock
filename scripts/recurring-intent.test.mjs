import assert from "node:assert/strict";
import test from "node:test";
import {
  createDcaRunKey,
  evaluateDueRecurringIntents,
  parseDcaStrategyConfig,
} from "../services/recurringIntentService.ts";
import { processDcaCandidate } from "../services/dcaExecutor.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const SCHEDULE_ID = "26f78f0e-d297-43f1-8c83-10468553ca73";
const POLICY_HASH = "a".repeat(64);
const NOW = 1_800_000_000_000;

function schedule(overrides = {}) {
  return {
    scheduleId: SCHEDULE_ID,
    name: "weekly-spy",
    enabled: true,
    intervalSeconds: 604_800,
    policyHash: POLICY_HASH,
    strategyType: "DCA",
    executionMode: "MANUAL",
    strategyConfig: {
      ticker: "SPY",
      tokenAddress: TOKEN,
      amount: "50",
      maxPerRun: "100",
      maxRollingExposure: "250",
      rollingWindowSeconds: 604_800,
      maxPriceDeviationPercent: 1.5,
      autonomousEnabled: false,
    },
    nextRunAt: NOW - 1_000,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    now: () => NOW,
    loadMarketEvidence: async (ticker, tokenAddress) => ({
      ticker,
      tokenAddress,
      sessionMismatch: false,
      referenceGapPercent: 0.4,
      observedAt: NOW - 1_000,
    }),
    verifyRwaAsset: async () => true,
    buildQuote: async () => ({
      executionMode: "SWAP",
      tx: {
        from: OWNER,
        to: TOKEN,
        data: "0x12345678",
        value: "0",
        gas: "200000",
        gasPrice: null,
      },
      expectedOutputs: {
        fromTokenAmount: "50000000000000000000",
        toTokenAmount: "1000000000000000000",
        minimumReceivedAmount: null,
      },
    }),
    simulate: async () => ({ data: { status: "SUCCESS" } }),
    ...overrides,
  };
}

function store(rows = [schedule()], exposure = "0") {
  return {
    listSchedules: async () => rows,
    getDcaRollingExposure: async () => exposure,
  };
}

test("DCA schedule config validates risk limits and rejects unknown policy fields", () => {
  assert.equal(parseDcaStrategyConfig(schedule().strategyConfig).ticker, "SPY");
  assert.throws(() => parseDcaStrategyConfig({
    ...schedule().strategyConfig,
    unreviewedExecutionFlag: true,
  }));
  assert.throws(() => parseDcaStrategyConfig({
    ...schedule().strategyConfig,
    maxPerRun: "25",
  }));
});

test("DCA run key is stable per owner, schedule, and due interval", () => {
  const first = createDcaRunKey(OWNER, SCHEDULE_ID, NOW - 1_000);
  assert.equal(first, createDcaRunKey(OWNER.toLowerCase(), SCHEDULE_ID, NOW - 1_000));
  assert.notEqual(first, createDcaRunKey(OWNER, SCHEDULE_ID, NOW));
});

test("due DCA run requests a fresh quote and returns an ephemeral ready candidate", async () => {
  let built = 0;
  const result = await evaluateDueRecurringIntents(
    { ownerAddress: OWNER, store: store(), now: NOW },
    dependencies({ buildQuote: async (...args) => {
      built += 1;
      assert.equal(args[0], "56");
      assert.equal(args[4], OWNER.toLowerCase());
      return dependencies().buildQuote();
    } }),
  );
  assert.equal(built, 1);
  assert.equal(result[0].status, "READY");
  if (result[0].status !== "READY") return;
  assert.equal(result[0].candidate.transaction.data, "0x12345678");
  assert.equal(result[0].candidate.expiresAt, NOW + 2_000);
});

test("DCA rejects stale evidence, session mismatch, excessive deviation, and exposure", async () => {
  const cases = [
    { evidence: { observedAt: NOW - 3_001 }, exposure: "0", expected: /3-second/ },
    { evidence: { sessionMismatch: true }, exposure: "0", expected: /session mismatch/ },
    { evidence: { referenceGapPercent: 2 }, exposure: "0", expected: /deviation/ },
    { evidence: {}, exposure: "210", expected: /rolling exposure/ },
  ];
  for (const item of cases) {
    const result = await evaluateDueRecurringIntents(
      { ownerAddress: OWNER, store: store([schedule()], item.exposure), now: NOW },
      dependencies({
        loadMarketEvidence: async (ticker, tokenAddress) => ({
          ticker,
          tokenAddress,
          sessionMismatch: false,
          referenceGapPercent: 0.4,
          observedAt: NOW - 1_000,
          ...item.evidence,
        }),
      }),
    );
    assert.equal(result[0].status, "REJECTED");
    if (result[0].status === "REJECTED") assert.match(result[0].reason, item.expected);
  }
});

test("manual DCA executor records a payload-free alert and never submits a transaction", async () => {
  const result = await evaluateDueRecurringIntents(
    { ownerAddress: OWNER, store: store(), now: NOW },
    dependencies(),
  );
  assert.equal(result[0].status, "READY");
  if (result[0].status !== "READY") return;
  const persistedAlerts = [];
  const execution = await processDcaCandidate({
    ownerAddress: OWNER,
    candidate: result[0].candidate,
    now: NOW,
    store: {
      claimExecution: async () => ({ claimId: "claim" }),
      updateExecutionClaim: async () => {},
      recordAlert: async (alert) => {
        persistedAlerts.push(alert);
        return "alert";
      },
    },
  });
  assert.equal(execution.status, "MANUAL_PROPOSAL");
  assert.equal(execution.transactionSubmitted, false);
  assert.equal(execution.proposal.transaction, undefined);
  assert.equal(JSON.stringify(persistedAlerts).includes("0x12345678"), false);
});

test("autonomous DCA stays blocked even when its policy gates are present", async () => {
  const result = await evaluateDueRecurringIntents(
    {
      ownerAddress: OWNER,
      store: store([schedule({
        executionMode: "AUTONOMOUS",
        strategyConfig: {
          ...schedule().strategyConfig,
          autonomousEnabled: true,
        },
      })]),
      now: NOW,
    },
    dependencies(),
  );
  assert.equal(result[0].status, "READY");
  if (result[0].status !== "READY") return;

  const priorFlags = {
    control: process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED,
    autonomous: process.env.WOLV_AUTONOMOUS_TRADING_ENABLED,
    live: process.env.ENABLE_LIVE_USEROP_SUBMISSION,
  };
  process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED = "true";
  process.env.WOLV_AUTONOMOUS_TRADING_ENABLED = "true";
  process.env.ENABLE_LIVE_USEROP_SUBMISSION = "true";
  try {
    const execution = await processDcaCandidate({
      ownerAddress: OWNER,
      candidate: result[0].candidate,
      now: NOW,
      delegatedPolicy: {
        ownerAddress: OWNER,
        scheduleId: SCHEDULE_ID,
        chainId: 56,
        tokenAddress: TOKEN,
        status: "ACTIVE",
        maxPerRun: "100",
        maxRollingExposure: "250",
        expiresAt: NOW + 60_000,
      },
      persistentWorkerHeartbeat: { active: true, observedAt: NOW },
      store: {
        claimExecution: async () => ({ claimId: "claim" }),
        updateExecutionClaim: async () => {},
        recordAlert: async () => "alert",
      },
    });
    assert.equal(execution.status, "AUTONOMOUS_READY_EXECUTION_BLOCKED");
    assert.equal(execution.transactionSubmitted, false);
  } finally {
    restoreEnvironment("WOLV_AGENT_CONTROL_PLANE_ENABLED", priorFlags.control);
    restoreEnvironment("WOLV_AUTONOMOUS_TRADING_ENABLED", priorFlags.autonomous);
    restoreEnvironment("ENABLE_LIVE_USEROP_SUBMISSION", priorFlags.live);
  }
});

test("autonomous DCA raises the explicit RFQ-unavailable guard when a provider returns RFQ mode", async () => {
  await assert.rejects(
    evaluateDueRecurringIntents(
      {
        ownerAddress: OWNER,
        store: store([schedule({ executionMode: "AUTONOMOUS" })]),
        now: NOW,
      },
      dependencies({
        buildQuote: async () => ({ executionMode: "RFQ" }),
      }),
    ),
    (error) => error.code === "AUTONOMOUS_RFQ_UNAVAILABLE",
  );
});

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
