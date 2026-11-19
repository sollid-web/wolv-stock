import assert from "node:assert/strict";
import test from "node:test";
import { deriveAgentPublicStatus } from "../lib/agentPublicStatus.ts";

const NOW = 1_800_000_000_000;
const base = () => ({
  worker: { lastSeenAt: NOW - 5_000, globallyPaused: false, pauseReason: null, executionGateEnabled: true },
  control: { emergencyStop: false, releaseExpiresAt: NOW + 60 * 60_000 },
  schedules: [{ name: "eth-testnet-1", enabled: true, intervalSeconds: 60, nextRunAt: NOW + 30_000, lastRunAt: NOW - 30_000,
    lastEvaluatedAt: NOW - 30_000, lastEvaluation: { reasonCode: "TRIGGER_NOT_MET", currentPriceMicros: "1950000000", entryPriceMicros: "1900000000" } }],
  totals: { confirmed: 28, failed: 1, inFlight: 0 },
  recentExecutions: [{ status: "CONFIRMED", failureCode: null, scheduleName: "eth-testnet-1", transactionHash: "0x" + "ab".repeat(32),
    blockNumber: "1", amountIn: "1000000000000000", receivedAmount: "450000000000000", createdAt: NOW - 3_600_000, settledAt: NOW - 3_600_000 }],
  recentAlerts: [],
});

test("an online worker waiting for its trigger is MONITORING with the real decision and prices", () => {
  const status = deriveAgentPublicStatus(base(), NOW);
  assert.equal(status.state, "MONITORING");
  assert.match(status.detail, /above the entry threshold/);
  assert.equal(status.strategy.priceUsd, 1950);
  assert.equal(status.strategy.entryUsd, 1900);
});

test("a stale heartbeat is OFFLINE even if schedules exist", () => {
  const snapshot = base();
  snapshot.worker.lastSeenAt = NOW - 5 * 60_000;
  assert.equal(deriveAgentPublicStatus(snapshot, NOW).state, "OFFLINE");
  assert.equal(deriveAgentPublicStatus({ ...base(), worker: null }, NOW).state, "OFFLINE");
});

test("an emergency stop or an expired release is PAUSED, never shown as active", () => {
  const stopped = base();
  stopped.control.emergencyStop = true;
  assert.equal(deriveAgentPublicStatus(stopped, NOW).state, "PAUSED");
  const expired = base();
  expired.control.releaseExpiresAt = NOW - 1;
  const status = deriveAgentPublicStatus(expired, NOW);
  assert.equal(status.state, "PAUSED");
  assert.match(status.detail, /expired/);
});

test("in-flight claims are SUBMITTED; recent outcomes are CONFIRMED or FAILED", () => {
  const inflight = base();
  inflight.totals.inFlight = 1;
  assert.equal(deriveAgentPublicStatus(inflight, NOW).state, "SUBMITTED");
  const confirmed = base();
  confirmed.recentExecutions[0].settledAt = NOW - 30_000;
  assert.equal(deriveAgentPublicStatus(confirmed, NOW).state, "CONFIRMED");
  const failed = base();
  failed.recentExecutions.unshift({ ...failed.recentExecutions[0], status: "FAILED", failureCode: "BUNDLER_MEMPOOL_REJECTED", settledAt: NOW - 30_000 });
  const failedStatus = deriveAgentPublicStatus(failed, NOW);
  assert.equal(failedStatus.state, "FAILED");
  assert.match(failedStatus.detail, /bundler/);
});

test("a passed entry check is EVALUATING; no enabled schedule is IDLE", () => {
  const passing = base();
  passing.schedules[0].lastEvaluation.reasonCode = "VALIDATOR_PASS";
  assert.equal(deriveAgentPublicStatus(passing, NOW).state, "EVALUATING");
  const idle = base();
  idle.schedules[0].enabled = false;
  assert.equal(deriveAgentPublicStatus(idle, NOW).state, "IDLE");
});
