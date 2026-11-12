import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentWorker,
  MAX_ROLLING_VOLUME_BNB,
  MAX_TRADE_BNB,
} from "../services/agentWorker.ts";
import { parseEther } from "viem";
import { hashAgentPolicy } from "../lib/agentPolicyHash.ts";

const strategy = {
  id: "aapl-entry",
  account: "0x0000000000000000000000000000000000000789",
  targetToken: "0x0000000000000000000000000000000000000456",
  amountBnb: parseEther("0.1"),
  entryPriceMicros: 100_000_000n,
  slippageBps: 100,
  maxPriceImpactBps: 300,
};
const INTENT_SIGNER = "0x0000000000000000000000000000000000000788";
const POLICY_EXPIRY = 2_000_000_000n;
const POLICY_HASH = hashAgentPolicy({
  strategyId: strategy.id,
  targetToken: strategy.targetToken,
  maxTradeValue: parseEther("0.5"),
  expiresAt: POLICY_EXPIRY,
  intentSigner: INTENT_SIGNER,
});

function validPolicyState(overrides = {}) {
  return {
    paused: false,
    installed: true,
    revoked: false,
    rollingVolume: parseEther("0.2"),
    policyConfigured: true,
    policyHash: POLICY_HASH,
    maxTradeValue: parseEther("0.5"),
    policyExpiresAt: POLICY_EXPIRY,
    intentSigner: INTENT_SIGNER,
    ...overrides,
  };
}

function createHarness(overrides = {}, options = {}) {
  const telemetry = [];
  const alerts = [];
  const intents = [];
  const dependencies = {
    strategies: [strategy],
    readMarket: async () => ({
      priceMicros: 90_000_000n,
      reserves: {
        reserveIn: parseEther("1000"),
        reserveOut: parseEther("1000000"),
      },
      observedAt: Date.now(),
    }),
    readValidator: async () => validPolicyState(),
    log: event => telemetry.push(event),
    alert: event => alerts.push(event),
    onIntent: intent => intents.push(intent),
    ...overrides,
  };
  return {
    worker: new AgentWorker(dependencies, {
      intervalMs: 1000,
      maxConsecutiveFailures: 2,
      maxMarketAgeMs: 20_000,
      ...options,
    }),
    telemetry,
    alerts,
    intents,
  };
}

test("passes preflight then publishes a bounded intent and capacity telemetry", async () => {
  const { worker, telemetry, intents } = createHarness();
  await worker.evaluateOnce();

  assert.equal(telemetry[0].reasonCode, "VALIDATOR_PASS");
  assert.equal(telemetry[0].cumulativeVolumeBnb, parseEther("0.2").toString());
  assert.equal(
    telemetry[0].remainingCapacityBnb,
    (MAX_ROLLING_VOLUME_BNB - parseEther("0.2")).toString(),
  );
  assert.equal(telemetry[0].attemptedTradeBnb, strategy.amountBnb.toString());
  assert.ok(telemetry[0].priceImpactBps > 0);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].amountOutMin > 0n, true);
  assert.equal(intents[0].slippageBps, strategy.slippageBps);
  assert.equal(intents[0].maxPriceImpactBps, strategy.maxPriceImpactBps);
  assert.equal(intents[0].policyHash, POLICY_HASH);
  assert.equal("intentNonce" in intents[0], false);
  assert.equal(worker.hasPendingIntent, true);
});

test("anchors intent age to local market-data receipt time", async () => {
  const receivedAt = Date.now() - 3_000;
  const { worker, intents } = createHarness({
    readMarket: async () => ({
      priceMicros: 90_000_000n,
      reserves: {
        reserveIn: parseEther("1000"),
        reserveOut: parseEther("1000000"),
      },
      observedAt: Date.now(),
      receivedAt,
    }),
  });
  await worker.evaluateOnce();

  assert.equal(intents.length, 1);
  assert.equal(intents[0].createdAt, new Date(receivedAt).toISOString());
});

test("rejects a strategy label that is not bound into the on-chain policy hash", async () => {
  const { worker, telemetry, intents } = createHarness({
    strategies: [{ ...strategy, id: "unregistered-entry" }],
  });
  await worker.evaluateOnce();

  assert.equal(telemetry[0].reasonCode, "POLICY_HASH_MISMATCH");
  assert.equal(intents.length, 0);
});

test("does not construct an intent when the price trigger is not met", async () => {
  const { worker, telemetry, intents } = createHarness({
    readMarket: async () => ({
      priceMicros: 101_000_000n,
      reserves: {
        reserveIn: parseEther("1000"),
        reserveOut: parseEther("1000000"),
      },
      observedAt: Date.now(),
    }),
  });
  await worker.evaluateOnce();

  assert.equal(telemetry[0].reasonCode, "TRIGGER_NOT_MET");
  assert.equal(intents.length, 0);
});

test("fails closed when market data reaches the 20-second age limit", async () => {
  const now = Date.now();
  const harness = createHarness({
    now: () => now,
    readMarket: async () => ({
      priceMicros: 90_000_000n,
      reserves: {
        reserveIn: parseEther("1000"),
        reserveOut: parseEther("1000000"),
      },
      observedAt: now - 20_000,
    }),
  });
  await harness.worker.evaluateOnce();

  assert.equal(harness.telemetry[0].reasonCode, "RPC_FAILURE");
  assert.equal(harness.intents.length, 0);
});

test("preflights cumulative and per-trade limits before creating an intent", async () => {
  const cumulative = createHarness({
    readValidator: async () => validPolicyState({
      rollingVolume: MAX_ROLLING_VOLUME_BNB - parseEther("0.05"),
    }),
  });
  await cumulative.worker.evaluateOnce();
  assert.equal(cumulative.telemetry[0].reasonCode, "CAP_EXCEEDED");
  assert.equal(cumulative.intents.length, 0);

  const oversize = createHarness({
    strategies: [{ ...strategy, amountBnb: MAX_TRADE_BNB + 1n }],
  });
  await oversize.worker.evaluateOnce();
  assert.equal(oversize.telemetry[0].reasonCode, "TRADE_CAP_EXCEEDED");
  assert.equal(oversize.intents.length, 0);
});

test("refuses paused, revoked, or uninstalled accounts", async t => {
  for (const [label, state, expectedReason] of [
    ["paused", { paused: true }, "CIRCUIT_BREAKER_PAUSED"],
    ["revoked", { revoked: true }, "SESSION_REVOKED"],
    ["uninstalled", { installed: false }, "SESSION_NOT_INSTALLED"],
  ]) {
    await t.test(label, async () => {
      const harness = createHarness({
        readValidator: async () => validPolicyState({ rollingVolume: 0n, ...state }),
      });
      await harness.worker.evaluateOnce();
      assert.equal(harness.telemetry[0].reasonCode, expectedReason);
      assert.equal(harness.intents.length, 0);
    });
  }
});

test("refuses accounts without a configured on-chain policy signer", async () => {
  const harness = createHarness({
    readValidator: async () => validPolicyState({
      policyConfigured: false,
      intentSigner: "0x0000000000000000000000000000000000000000",
    }),
  });
  await harness.worker.evaluateOnce();
  assert.equal(harness.telemetry[0].reasonCode, "POLICY_NOT_CONFIGURED");
  assert.equal(harness.intents.length, 0);
});

test("rejects high price impact and does not create an intent", async () => {
  const { worker, telemetry, intents } = createHarness({
    readMarket: async () => ({
      priceMicros: 90_000_000n,
      reserves: {
        reserveIn: parseEther("1"),
        reserveOut: parseEther("1000"),
      },
      observedAt: Date.now(),
    }),
  });
  await worker.evaluateOnce();

  assert.equal(telemetry[0].reasonCode, "SLIPPAGE_HIGH");
  assert.equal(intents.length, 0);
});

test("panic-stops on consecutive RPC failures, alerts, and clears pending intent", async () => {
  let shouldFail = false;
  const harness = createHarness({
    readMarket: async () => {
      if (shouldFail) throw new Error("mock RPC unavailable");
      return {
        priceMicros: 90_000_000n,
        reserves: {
          reserveIn: parseEther("1000"),
          reserveOut: parseEther("1000000"),
        },
        observedAt: Date.now(),
      };
    },
  });

  await harness.worker.evaluateOnce();
  assert.equal(harness.worker.hasPendingIntent, true);
  shouldFail = true;
  await harness.worker.evaluateOnce();
  await harness.worker.evaluateOnce();

  assert.equal(harness.worker.isRunning, false);
  assert.equal(harness.worker.hasPendingIntent, false);
  assert.equal(harness.alerts.length, 1);
  assert.equal(harness.alerts[0].priority, "high");
  assert.ok(harness.telemetry.some(event => event.reasonCode === "WORKER_PANIC_STOP"));

  const recordsBeforeRetry = harness.telemetry.length;
  await harness.worker.evaluateOnce();
  assert.equal(harness.telemetry.length, recordsBeforeRetry);
});

test("does not prepare duplicate intents while an intent is pending", async () => {
  const { worker, telemetry, intents } = createHarness();
  await worker.evaluateOnce();
  await worker.evaluateOnce();

  assert.equal(intents.length, 1);
  assert.equal(telemetry[1].reasonCode, "INTENT_PENDING");
  assert.equal(worker.getPendingIntent().strategyId, strategy.id);
  assert.equal(worker.acknowledgeIntent(strategy.id), true);
  assert.equal(worker.hasPendingIntent, false);
});

test("prevents overlapping evaluation cycles", async () => {
  let resolveMarket;
  let marketStarted;
  const started = new Promise(resolve => {
    marketStarted = resolve;
  });
  const deferredMarket = new Promise(resolve => {
    resolveMarket = resolve;
  });
  const { worker, telemetry } = createHarness({
    readMarket: async () => {
      marketStarted();
      return deferredMarket;
    },
  });

  const firstCycle = worker.evaluateOnce();
  await started;
  await worker.evaluateOnce();
  resolveMarket({
    priceMicros: 101_000_000n,
    reserves: {
      reserveIn: parseEther("1000"),
      reserveOut: parseEther("1000000"),
    },
    observedAt: Date.now(),
  });
  await firstCycle;

  assert.equal(telemetry.length, 1);
});
