import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutonomousRfqUnavailable,
  extractRfqTypedDataVerbatim,
  pollRfqOrderStatus,
  validateRfqOrderBinding,
} from "../services/rfqOrderService.ts";

const REQUEST_ID = "c0a80123-4567-489a-8bcd-0123456789ab";
const EXECUTION_ID = "c0a80123-4567-489a-8bcd-0123456789ac";
const ORDER_ID = "order_12345";
const NOW = 1_800_000_000_000;

function binding(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    executionId: EXECUTION_ID,
    quoteId: "a".repeat(32),
    vendor: "Vendor",
    userWalletAddress: "0x1111111111111111111111111111111111111111",
    chainId: 56,
    targetTokenAddress: "0x2222222222222222222222222222222222222222",
    amount: "50",
    targetPriceLowerBound: "49.5",
    targetPriceUpperBound: "50.5",
    quoteFetchedAt: NOW,
    expiresAt: NOW + 15_000,
    ...overrides,
  };
}

function fakeLedger() {
  return {
    polls: [],
    reconciliation: null,
    async recordPoll(input) {
      this.polls.push(input);
    },
    async markReconciliationRequired(input) {
      this.reconciliation = input;
    },
  };
}

test("RFQ order binding validates chain, signer, target price limits and quote expiry", () => {
  assert.doesNotThrow(() => validateRfqOrderBinding(binding()));
  assert.throws(() => validateRfqOrderBinding(binding({ chainId: 97 })));
  assert.throws(() => validateRfqOrderBinding(binding({
    targetPriceLowerBound: "51",
    targetPriceUpperBound: "50",
  })));
  assert.throws(() => validateRfqOrderBinding(binding({ expiresAt: NOW })));
});

test("typed-data exposure remains blocked until the provider schema validator is fixture-verified", () => {
  const typedData = { domain: { chainId: 56 }, message: { orderId: "test" } };
  assert.throws(
    () => extractRfqTypedDataVerbatim({ data: { rfq: { typedDataToSign: typedData } } }),
    (error) => error.code === "RFQ_SCHEMA_UNVERIFIED",
  );
  assert.throws(
    () => extractRfqTypedDataVerbatim({ data: { rfq: {} } }),
    (error) => error.code === "RFQ_SCHEMA_UNVERIFIED",
  );
});

test("bounded polling stops on FILLED and durably records each observation", async () => {
  const ledger = fakeLedger();
  const waits = [];
  let time = NOW;
  const statuses = ["OPEN", "FILLED"];
  const result = await pollRfqOrderStatus({
    requestId: REQUEST_ID,
    orderId: ORDER_ID,
    ledger,
    getStatus: async () => ({ code: 0, data: { status: statuses.shift() } }),
    sleep: async (milliseconds) => waits.push(milliseconds),
    now: () => time++,
  });
  assert.deepEqual(result, { status: "FILLED", attempts: 2, orderId: ORDER_ID });
  assert.deepEqual(ledger.polls.map((poll) => poll.providerState), ["PENDING", "FILLED"]);
  assert.deepEqual(waits, [250]);
  assert.equal(ledger.reconciliation, null);
});

test("bounded polling returns durable reconciliation state on provider uncertainty", async () => {
  const ledger = fakeLedger();
  let time = NOW;
  const result = await pollRfqOrderStatus({
    requestId: REQUEST_ID,
    orderId: ORDER_ID,
    ledger,
    getStatus: async () => { throw new Error("temporary provider failure"); },
    sleep: async () => {},
    now: () => time++,
  });
  assert.equal(result.status, "RECONCILIATION_REQUIRED");
  assert.equal(result.attempts, 6);
  assert.equal(ledger.polls.length, 6);
  assert.equal(ledger.polls[0].providerState, "UNKNOWN");
  assert.equal(ledger.reconciliation.orderId, ORDER_ID);
});

test("autonomous RFQ has no key-based fallback", () => {
  assert.throws(
    () => assertAutonomousRfqUnavailable(),
    (error) => error.code === "AUTONOMOUS_RFQ_UNAVAILABLE",
  );
});
