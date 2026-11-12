import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedLiveExecutionTransition,
  isRecoverableLiveExecutionStatus,
  assertSafeLiveExecutionDetail,
  assertLiveExecutionSettlementEvidence,
  canRetryUnknownSubmission,
} from "../services/autonomy/live-execution-domain.ts";

test("allows safe live execution progression and rejects illegal shortcuts", () => {
  assert.equal(isAllowedLiveExecutionTransition("PREPARED", "SIGNING_REQUESTED"), true);
  assert.equal(isAllowedLiveExecutionTransition("SUBMISSION_UNKNOWN", "SUBMITTING"), true);
  assert.equal(isAllowedLiveExecutionTransition("PROVIDER_FILLED", "SETTLED"), true);
  assert.equal(isAllowedLiveExecutionTransition("PREPARED", "SETTLED"), false);
  assert.equal(isAllowedLiveExecutionTransition("SETTLED", "SUBMITTING"), false);
  assert.equal(isAllowedLiveExecutionTransition("SECURITY_HOLD", "PREPARED"), false);
});

test("unknown submission remains recoverable without creating a new attempt", () => {
  assert.equal(isRecoverableLiveExecutionStatus("SUBMISSION_UNKNOWN"), true);
  assert.equal(isRecoverableLiveExecutionStatus("SUBMITTING"), true);
  assert.equal(isRecoverableLiveExecutionStatus("SECURITY_HOLD"), false);
  assert.equal(isRecoverableLiveExecutionStatus("SETTLED"), false);
});

test("audit detail rejects sensitive keys at any nesting depth", () => {
  assert.doesNotThrow(() => assertSafeLiveExecutionDetail({ provider: "binance", retry: 1 }));
  assert.throws(() => assertSafeLiveExecutionDetail({ signature: "0xsecret" }));
  assert.throws(() => assertSafeLiveExecutionDetail({ nested: { rawTransaction: "0xdead" } }));
  assert.throws(() => assertSafeLiveExecutionDetail({ typedData: { message: {} } }));
});

test("settlement requires transaction, actual amounts, fee and block evidence", () => {
  assert.doesNotThrow(() => assertLiveExecutionSettlementEvidence({
    transaction_hash: `0x${"a".repeat(64)}`,
    amount_in: "100",
    amount_out: "99",
    fee_amount: "1",
    settlement_block: "123",
  }));
  assert.throws(() => assertLiveExecutionSettlementEvidence({
    transaction_hash: `0x${"a".repeat(64)}`,
    amount_in: "100",
    amount_out: "99",
    fee_amount: "1",
  }));
  assert.throws(() => assertLiveExecutionSettlementEvidence({
    transaction_hash: "0xdead",
    amount_in: "100",
    amount_out: "99",
    fee_amount: "1",
    settlement_block: "123",
  }));
});

test("unknown submission retries stop exactly at the provider idempotency deadline", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const deadline = "2026-11-12T12:30:00.000Z";
  assert.equal(canRetryUnknownSubmission("SUBMISSION_UNKNOWN", deadline, now), true);
  assert.equal(canRetryUnknownSubmission("SUBMISSION_UNKNOWN", deadline, Date.parse(deadline)), false);
  assert.equal(canRetryUnknownSubmission("SUBMISSION_UNKNOWN", null, now), false);
  assert.equal(canRetryUnknownSubmission("SUBMITTED", deadline, now), false);
});
