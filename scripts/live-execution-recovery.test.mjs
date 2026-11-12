import test from "node:test";
import assert from "node:assert/strict";
import { createLiveExecutionRecovery } from "../services/autonomy/live-execution-recovery.ts";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const wallet = "0x1111111111111111111111111111111111111111";
const txHash = `0x${"a".repeat(64)}`;
const now = Date.parse("2026-11-12T12:00:00.000Z");

function attempt(overrides = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    owner_id: ownerId,
    intent_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    attempt_number: 1,
    request_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    provider: "binance-web3-aggregator",
    chain_id: "56",
    wallet_address: wallet,
    status: "SUBMISSION_UNKNOWN",
    version: 3,
    execution_side: "BUY",
    policy_version: "live-policy-v1",
    quote_expires_at: new Date(now + 30000).toISOString(),
    simulation_fingerprint: "e".repeat(64),
    simulated_at: new Date(now).toISOString(),
    native_gas_balance_wei: "1000000000000000000",
    native_gas_preflight_at: new Date(now).toISOString(),
    provider_idempotency_window_seconds: 0,
    submission_started_at: new Date(now - 5000).toISOString(),
    retry_not_after: null,
    provider_quote_id: "a".repeat(32),
    provider_order_id: "rfq-order-123",
    prepared_payload_hash: "f".repeat(64),
    signer_operation_id: "signer-operation-123",
    signer_address: wallet,
    transaction_hash: null,
    amount_in: null,
    amount_out: null,
    fee_amount: null,
    settlement_block: null,
    last_error_code: null,
    created_at: new Date(now - 10000).toISOString(),
    updated_at: new Date(now - 5000).toISOString(),
    ...overrides,
  };
}

function harness(initial, options = {}) {
  const state = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const events = [];
  const released = [];
  const committed = [];
  const providerCalls = [];
  const settlementCalls = [];
  const repo = {
    async listRecoverable(id) {
      return [...state.values()].filter((item) => item.owner_id === id &&
        !["SETTLED", "FAILED", "REJECTED", "ABORTED", "SECURITY_HOLD"].includes(item.status));
    },
    async listSettled(id) {
      return [...state.values()].filter((item) => item.owner_id === id && item.status === "SETTLED");
    },
    async transition(input) {
      const current = state.get(input.attemptId);
      if (!current || current.owner_id !== input.ownerId || current.version !== input.expectedVersion) return null;
      const next = {
        ...current,
        ...Object.fromEntries(Object.entries(input.evidence ?? {}).map(([key, value]) => [key, value])),
        status: input.nextStatus,
        version: current.version + 1,
      };
      state.set(current.id, next);
      events.push({ from: current.status, to: input.nextStatus, eventType: input.eventType });
      return structuredClone(next);
    },
    async commitFill(owner, id) {
      committed.push(id);
      return options.commitResult ?? true;
    },
    async releaseBudget(owner, id) {
      released.push(id);
      return true;
    },
  };
  const provider = {
    async reconcile(input) {
      providerCalls.push(input);
      return options.providerResult ?? {
        status: "PROVIDER_FILLED",
        checkedAt: new Date(now).toISOString(),
        providerOrderId: "rfq-order-123",
        transactionHash: txHash,
        amountIn: "1000",
        amountOut: "950",
      };
    },
  };
  const settlement = {
    async verify(item) {
      settlementCalls.push(item.id);
      return options.settlementResult ?? {
        status: "SETTLED",
        transactionHash: txHash,
        amountIn: "1000",
        amountOut: "950",
        feeAmount: "21000000000000",
        settlementBlock: "12345",
      };
    },
  };
  const recovery = createLiveExecutionRecovery({
    repository: repo,
    provider,
    settlement,
    ...(options.isNewEntryAllowed ? { isNewEntryAllowed: options.isNewEntryAllowed } : {}),
    now: () => now,
  });
  return { recovery, state, events, released, committed, providerCalls, settlementCalls };
}

test("recovers an ambiguous provider submission through fill, chain settlement and atomic ledger commit", async () => {
  const h = harness([attempt()]);
  const report = await h.recovery.run(ownerId);
  assert.equal(report.scanned, 1);
  assert.equal(report.reconciled, 1);
  assert.equal(report.settled, 1);
  assert.deepEqual(h.events.map((event) => event.to), ["PROVIDER_FILLED", "SETTLEMENT_PENDING", "SETTLED"]);
  assert.equal(h.providerCalls[0].requestId, attempt().request_id);
  assert.equal(h.providerCalls[0].providerOrderId, attempt().provider_order_id);
  assert.deepEqual(h.committed, [attempt().id]);
  assert.deepEqual(h.released, []);
});

test("never blindly resubmits an unknown order and leaves pending provider status recoverable", async () => {
  const h = harness([attempt()], {
    providerResult: { status: "PENDING", checkedAt: new Date(now).toISOString(), providerOrderId: "rfq-order-123" },
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(report.providerPending, 1);
  assert.equal(h.state.get(attempt().id).status, "PROVIDER_PENDING");
  assert.equal(h.events.some((event) => event.to === "SUBMITTING"), false);
});

test("keeps unknown provider results unchanged instead of manufacturing a new order", async () => {
  const h = harness([attempt()], {
    providerResult: { status: "UNKNOWN", checkedAt: new Date(now).toISOString(), reason: "status timeout" },
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(report.unchanged, 1);
  assert.equal(h.state.get(attempt().id).status, "SUBMISSION_UNKNOWN");
  assert.equal(h.events.length, 0);
});

test("moves a crashed in-flight submission to UNKNOWN and reconciles by the persisted order ID", async () => {
  const h = harness([attempt({ status: "SUBMITTING" })], {
    providerResult: { status: "PENDING", checkedAt: new Date(now).toISOString(), providerOrderId: "rfq-order-123" },
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(h.events[0].to, "SUBMISSION_UNKNOWN");
  assert.equal(h.state.get(attempt().id).status, "PROVIDER_PENDING");
  assert.equal(report.reconciled, 1);
});

test("aborts and releases an expired unsigned PREPARED attempt", async () => {
  const h = harness([attempt({
    status: "PREPARED",
    quote_expires_at: new Date(now - 1000).toISOString(),
    version: 0,
  })]);
  const report = await h.recovery.run(ownerId);
  assert.equal(h.state.get(attempt().id).status, "ABORTED");
  assert.deepEqual(h.released, [attempt().id]);
  assert.equal(report.failed, 1);
  assert.equal(h.providerCalls.length, 0);
});

test("leaves a fresh signer-unknown attempt resumable with its persisted signer operation", async () => {
  const h = harness([attempt({ status: "SIGNER_UNKNOWN" })], {
    isNewEntryAllowed: async () => true,
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(h.state.get(attempt().id).status, "SIGNER_UNKNOWN");
  assert.equal(report.unchanged, 1);
  assert.deepEqual(h.released, []);
  assert.equal(h.providerCalls.length, 0);
});

test("aborts a pre-submit signer-unknown attempt when the global entry stop is engaged", async () => {
  const h = harness([attempt({ status: "SIGNER_UNKNOWN" })], {
    isNewEntryAllowed: async () => false,
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(h.state.get(attempt().id).status, "REJECTED");
  assert.equal(report.failed, 1);
  assert.deepEqual(h.released, [attempt().id]);
  assert.equal(h.providerCalls.length, 0);
});

test("keeps settlement pending until enough independent chain evidence exists", async () => {
  const h = harness([attempt({ status: "SETTLEMENT_PENDING" })], {
    settlementResult: { status: "PENDING", reason: "WAITING_FOR_CONFIRMATIONS" },
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(h.state.get(attempt().id).status, "SETTLEMENT_PENDING");
  assert.equal(report.providerPending, 1);
  assert.deepEqual(h.committed, []);
});

test("chain evidence mismatch enters security hold and keeps the reservation locked", async () => {
  const h = harness([attempt({ status: "SETTLEMENT_PENDING" })], {
    settlementResult: { status: "FAILED", reasonCode: "BSC_RFQ_TOKEN_DELTA_MISMATCH" },
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(h.state.get(attempt().id).status, "SECURITY_HOLD");
  assert.deepEqual(h.released, []);
  assert.equal(report.held, 1);
});

test("a reverted BSC transaction releases the live budget", async () => {
  const h = harness([attempt({ status: "SETTLEMENT_PENDING" })], {
    settlementResult: { status: "FAILED", reasonCode: "BSC_TRANSACTION_REVERTED" },
  });
  const report = await h.recovery.run(ownerId);
  assert.equal(h.state.get(attempt().id).status, "FAILED");
  assert.deepEqual(h.released, [attempt().id]);
  assert.equal(report.failed, 1);
});

test("retries an idempotent portfolio commit for already-settled attempts", async () => {
  const h = harness([attempt({ status: "SETTLED", version: 8 })]);
  const report = await h.recovery.run(ownerId);
  assert.deepEqual(h.committed, [attempt().id]);
  assert.equal(report.settled, 1);
});
