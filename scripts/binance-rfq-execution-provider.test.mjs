import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBinanceRfqSubmitResponse, parseBinanceRfqStatusResponse,
} from "../services/autonomy/binance-rfq-execution-provider.ts";

const now = 1794400000000;
const orderId = "oc-o-abc123def456";
const hash = "0x" + "a".repeat(64);
const envelope = (data, timestamp = now) => ({ code: 0, success: true, timestamp, data });

test("accepts a valid RFQ submit acknowledgement without calling it settled", () => {
  const result = parseBinanceRfqSubmitResponse(envelope({
    orderId, status: "PENDING_VENDOR", createdAt: now,
  }), now);
  assert.equal(result.status, "SUBMITTED");
  if (result.status === "SUBMITTED") assert.equal(result.providerOrderId, orderId);
});
test("malformed submit responses remain unknown, not rejected", () => {
  assert.equal(parseBinanceRfqSubmitResponse({ code: 0, success: true, data: {} }, now).status, "UNKNOWN");
  assert.equal(parseBinanceRfqSubmitResponse(envelope({
    orderId, status: "PENDING_VENDOR", createdAt: now - 120_000,
  }), now).status, "UNKNOWN");
});
test("pending vendor and on-chain states remain pending", () => {
  for (const status of ["PENDING_VENDOR", "PENDING_ONCHAIN"]) {
    assert.equal(parseBinanceRfqStatusResponse(envelope({ orderId, status }), orderId, now).status, "PENDING");
  }
});
test("provider FILLED is not represented as chain SETTLED", () => {
  const result = parseBinanceRfqStatusResponse(envelope({
    orderId, status: "FILLED", txHash: hash, fromAmount: "1000", toAmount: "990",
  }), orderId, now);
  assert.equal(result.status, "PROVIDER_FILLED");
});
test("terminal provider failures are surfaced and unknown states fail closed", () => {
  assert.equal(parseBinanceRfqStatusResponse(envelope({ orderId, status: "FAILED" }), orderId, now).status, "FAILED");
  assert.equal(parseBinanceRfqStatusResponse(envelope({ orderId, status: "UNKNOWN_NEW_STATUS" }), orderId, now).status, "UNKNOWN");
});
test("mismatched IDs, stale snapshots and missing settlement evidence remain unknown", () => {
  assert.equal(parseBinanceRfqStatusResponse(envelope({ orderId: "other", status: "PENDING_VENDOR" }), orderId, now).status, "UNKNOWN");
  assert.equal(parseBinanceRfqStatusResponse(envelope({ orderId, status: "PENDING_VENDOR" }, now - 60_000), orderId, now).status, "UNKNOWN");
  assert.equal(parseBinanceRfqStatusResponse(envelope({
    orderId, status: "FILLED", txHash: "bad", fromAmount: "1", toAmount: "2",
  }), orderId, now).status, "UNKNOWN");
});
