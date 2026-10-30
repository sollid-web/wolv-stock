import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentWorker,
  MAX_ROLLING_VOLUME_BNB,
  MAX_TRADE_BNB,
} from "../services/agentWorker.ts";
import { parseEther } from "viem";

const strategy = {
  id: "aapl-entry",
  account: "0x0000000000000000000000000000000000000789",
  targetToken: "0x0000000000000000000000000000000000000456",
  amountBnb: parseEther("0.1"),
  entryPriceMicros: 100_000_000n,
  slippageBps: 100,
  maxPriceImpactBps: 300,
};

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
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
    }),
    log: event => telemetry.push(event),
    alert: event => alerts.push(event),
    onIntent: intent => intents.push(intent),
    ...overrides,
  };
  return {
    worker: new AgentWorker(dependencies, {
      intervalMs: 1000,
      maxConsecutiveFailures: 2,
      maxMarketAgeMs: 30_000,
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
  assert.equal(worker.hasPendingIntent, true);
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

test("preflights cumulative and per-trade limits before creating an intent", async () => {
  const cumulative = createHarness({
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
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
        readValidator: async () => ({
          paused: false,
          installed: true,
          revoked: false,
          rollingVolume: 0n,
          ...state,
        }),
      });
      await harness.worker.evaluateOnce();
      assert.equal(harness.telemetry[0].reasonCode, expectedReason);
      assert.equal(harness.intents.length, 0);
    });
  }
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
