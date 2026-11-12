import test from "node:test";
import assert from "node:assert/strict";
import { createLiveExecutionOrchestrator } from "../services/autonomy/live-execution-orchestrator.ts";
import { parsePrivyEip712PolicyTemplate } from "../services/autonomy/privy-eip712-policy.ts";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const intentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const wallet = "0x1111111111111111111111111111111111111111";
const inputToken = "0x2222222222222222222222222222222222222222";
const outputToken = "0x3333333333333333333333333333333333333333";
const sender = "0x4444444444444444444444444444444444444444";
const router = "0x5555555555555555555555555555555555555555";
const now = Date.parse("2026-11-12T12:00:00.000Z");
const expiresAt = new Date(now + 30000).toISOString();
const quoteId = "a".repeat(32);
const orderId = "binance-rfq-order-001";
const payloadHash = "b".repeat(64);

function livePolicy(overrides = {}) {
  return {
    ownerId,
    walletAddress: wallet,
    privyWalletId: "privy-wallet-001",
    chainId: "56",
    inputTokenAddress: inputToken,
    policyVersion: "live-policy-1",
    enabled: true,
    emergencyStop: false,
    globalKillSwitch: false,
    allowedChainIds: ["56"],
    allowedTokenAddresses: [outputToken],
    allowedInputTokenAddresses: [inputToken],
    allowedTransactionSenders: [sender],
    allowedTransactionTargets: [router],
    budgetAmount: "1000000",
    reservedAmount: "0",
    committedAmount: "0",
    dailySpendAmount: "0",
    dailySpendDate: "2026-11-12",
    maxOrderAmount: "10000",
    maxPositionAmount: "10000",
    maxDailySpend: "100000",
    maxOpenPositions: 1,
    maxOpenOrders: 1,
    maxDailyRealizedLoss: "1000",
    minNativeGasBalanceWei: "1000000000000000",
    maxSlippageBps: 100,
    maxPriceImpactBps: 200,
    maxQuoteAgeMs: 20000,
    maxGasCostUsd: "1",
    minExpectedEdgeBps: 100,
    networkFeeBufferBps: 10000,
    ...overrides,
  };
}

function template() {
  return parsePrivyEip712PolicyTemplate({
    vendor: "rfq-vendor-a",
    chainId: 56,
    verifyingContracts: [router],
    primaryType: "RFQOrder",
    expectedDomain: { name: "Binance RFQ", version: "1" },
    expectedTypes: {
      RFQOrder: [
        { name: "maker", type: "address" },
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "minimumOutput", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "quoteId", type: "bytes32" },
      ],
    },
    requiredRoles: ["wallet", "tokenIn", "tokenOut", "amountIn", "minimumOutput", "expiry"],
    fieldBindings: [
      { role: "wallet", path: "maker", kind: "address", source: "walletAddress" },
      { role: "tokenIn", path: "tokenIn", kind: "address", source: "inputTokenAddress" },
      { role: "tokenOut", path: "tokenOut", kind: "address", source: "outputTokenAddress" },
      { role: "amountIn", path: "amountIn", kind: "uint", source: "amountIn" },
      { role: "minimumOutput", path: "minimumOutput", kind: "uint", source: "minimumAmountOut" },
      { role: "expiry", path: "deadline", kind: "uint", source: "quoteExpiryUnixSeconds" },
    ],
  });
}

function quote(overrides = {}) {
  return {
    provider: "binance-web3-aggregator",
    quoteId,
    vendorName: "rfq-vendor-a",
    executionMode: "RFQ",
    chainId: "56",
    walletAddress: wallet,
    inputTokenAddress: inputToken,
    outputTokenAddress: outputToken,
    amountIn: "1000",
    expectedAmountOut: "950",
    priceImpactBps: 50,
    gasEstimateRaw: "21000",
    estimatedNetworkFeeUsd: "0.01",
    inputTokenUsdPrice: "1",
    outputTokenUsdPrice: "1.05",
    approvalTarget: null,
    inputTokenDecimals: 18,
    outputTokenDecimals: 18,
    inputTokenTaxRate: "0",
    outputTokenTaxRate: "0",
    route: "route-a",
    routeFingerprint: "c".repeat(64),
    observedAt: new Date(now - 1000).toISOString(),
    expiresAt,
    rawEvidenceRef: "d".repeat(64),
    ...overrides,
  };
}

function roundTrip() {
  return {
    provider: "binance-web3-aggregator",
    buy: quote(),
    sell: quote({
      quoteId: "e".repeat(32),
      inputTokenAddress: outputToken,
      outputTokenAddress: inputToken,
      amountIn: "945",
      expectedAmountOut: "1010",
      priceImpactBps: 60,
    }),
    indicativeRoundTripEdgeBps: 250,
    slippageBps: 50,
    buyMinimumAmountOut: "945",
    sellMinimumAmountOut: "959",
    bufferedNetworkFeesUsd: "0.02",
    approvalRequired: false,
    expiresAt,
    routeFingerprint: "f".repeat(64),
    rawEvidenceRef: "1".repeat(64),
  };
}

function order(overrides = {}) {
  return {
    provider: "binance-web3-aggregator",
    quoteId,
    orderId,
    vendor: "rfq-vendor-a",
    signingScheme: "EIP712",
    chainId: "56",
    walletAddress: wallet,
    inputTokenAddress: inputToken,
    outputTokenAddress: outputToken,
    amountIn: "1000",
    expectedAmountOut: "950",
    typedDataHash: payloadHash,
    typedDataToSign: JSON.stringify({ domain: {}, types: {}, primaryType: "RFQOrder", message: {} }),
    typedDataFormat: "JSON_TYPED_DATA",
    approvalTarget: null,
    routeFingerprint: "c".repeat(64),
    rawEvidenceRef: "d".repeat(64),
    approvalRequired: false,
    preparedAt: new Date(now).toISOString(),
    quoteExpiresAt: expiresAt,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    owner_id: ownerId,
    intent_id: intentId,
    attempt_number: 1,
    request_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    provider: "binance-web3-aggregator",
    chain_id: "56",
    wallet_address: wallet,
    token_address: outputToken,
    input_token_address: inputToken,
    expected_amount_in: "1000",
    minimum_amount_out: "945",
    settlement_allowed_senders: [sender],
    settlement_allowed_targets: [router],
    status: "PREPARED",
    version: 0,
    execution_side: "BUY",
    policy_version: "live-policy-1",
    quote_expires_at: expiresAt,
    provider_quote_id: quoteId,
    provider_order_id: orderId,
    prepared_payload_hash: payloadHash,
    signer_operation_id: null,
    signer_address: null,
    simulation_fingerprint: null,
    simulated_at: null,
    native_gas_balance_wei: "1000000000000000000",
    native_gas_preflight_at: null,
    provider_idempotency_window_seconds: 0,
    submission_started_at: null,
    retry_not_after: null,
    transaction_hash: null,
    amount_in: null,
    amount_out: null,
    fee_amount: null,
    settlement_block: null,
    last_error_code: null,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...overrides,
  };
}

function harness(options = {}) {
  let current = attempt(options.initialAttemptOverrides);
  const transitions = [];
  const calls = { reserve: 0, create: 0, gas: 0, simulation: 0, sign: 0, submit: 0, release: 0, unboundRelease: 0 };
  const repository = {
    async findActive() { return options.activeAttempt ? structuredClone(options.activeAttempt) : null; },
    async reserve() { calls.reserve += 1; return options.reserveResult ?? true; },
    async create() { calls.create += 1; return structuredClone(current); },
    async transition(input) {
      transitions.push(input.nextStatus);
      current = {
        ...current,
        ...input.evidence,
        status: input.nextStatus,
        version: current.version + 1,
      };
      return structuredClone(current);
    },
    async recordGasPreflight() { calls.gas += 1; return true; },
    async recordSimulation() { calls.simulation += 1; return options.simulationRecordResult ?? true; },
    async releaseBudget() { calls.release += 1; return true; },
    async releaseUnboundReservation() { calls.unboundRelease += 1; return true; },
  };
  const provider = {
    async getRoundTripQuote() { return roundTrip(); },
    async buildOrder() { return order(options.approvalRequired ? { approvalRequired: true, approvalTarget: router } : {}); },
    async submit(input) {
      calls.submit += 1;
      assert.equal(input.requestId, current.request_id);
      return options.submitResult ?? {
        status: "SUBMITTED",
        providerOrderId: orderId,
        submittedAt: new Date(now).toISOString(),
      };
    },
  };
  const signer = {
    async sign(input) {
      calls.sign += 1;
      await input.beforeSign?.();
      if (options.signError) throw new Error("simulated signer timeout");
      return `0x${"a".repeat(130)}`;
    },
  };
  const simulator = {
    async simulate() {
      calls.simulation += 1;
      if (options.simulationError) throw new Error("RFQ simulation unavailable");
      return { orderHash: options.simulationOrderHash ?? payloadHash, fingerprint: "b".repeat(64), simulatedAt: new Date(now).toISOString() };
    },
  };
  const orchestrator = createLiveExecutionOrchestrator({
    loadPolicy: async () => livePolicy(options.policyOverrides),
    loadPolicyTemplate: async () => template(),
    provider,
    signer,
    simulator,
    repository,
    getNativeBalanceWei: async () => "1000000000000000000",
    now: () => now,
  });
  return { orchestrator, calls, transitions, getAttempt: () => structuredClone(current) };
}

test("autonomously reserves, signs, simulates and submits an eligible RFQ without a per-trade human approval", async () => {
  const h = harness();
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "SUBMITTED");
  assert.deepEqual(h.transitions, ["SIGNING_REQUESTED", "SIGNED", "SUBMITTING", "SUBMITTED"]);
  assert.equal(h.calls.reserve, 1);
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.sign, 1);
  assert.equal(h.calls.simulation, 2); // simulator call + durable simulation proof
  assert.equal(h.calls.submit, 1);
  assert.equal(h.calls.release, 0);
});

test("blocks new live entry when the global kill switch is engaged", async () => {
  const h = harness({ policyOverrides: { globalKillSwitch: true } });
  await assert.rejects(() => h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  }), /disabled or stopped/);
  assert.equal(h.calls.reserve, 0);
  assert.equal(h.calls.submit, 0);
});

test("aborts and releases the reservation when RFQ simulation fails before submission", async () => {
  const h = harness({ simulationError: true });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(h.getAttempt().status, "ABORTED");
  assert.equal(h.calls.submit, 0);
  assert.equal(h.calls.release, 1);
});

test("keeps reservation and attempt when signer outcome is ambiguous", async () => {
  const h = harness({ signError: true });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(h.getAttempt().status, "SIGNER_UNKNOWN");
  assert.equal(h.calls.submit, 0);
  assert.equal(h.calls.release, 0);
});

test("never resubmits when Binance returns an unknown submission outcome", async () => {
  const h = harness({
    submitResult: { status: "UNKNOWN", observedAt: new Date(now).toISOString(), reason: "timeout" },
  });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "SUBMISSION_UNKNOWN");
  assert.equal(h.getAttempt().status, "SUBMISSION_UNKNOWN");
  assert.equal(h.calls.submit, 1);
  assert.equal(h.calls.release, 0);
});

test("rejects an RFQ that requires an unsupported token approval transaction", async () => {
  const h = harness({ approvalRequired: true });
  await assert.rejects(() => h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  }), /Unsigned RFQ order does not match/);
  assert.equal(h.calls.reserve, 0);
  assert.equal(h.calls.sign, 0);
  assert.equal(h.calls.submit, 0);
});

test("resumes a signer-unknown attempt using the persisted signer idempotency key", async () => {
  const h = harness({
    initialAttemptOverrides: {
      status: "SIGNER_UNKNOWN",
      version: 2,
      signer_operation_id: "wolv-existing-signer-operation",
      signer_address: wallet,
      prepared_payload_hash: payloadHash,
    },
  });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "SUBMITTED");
  assert.deepEqual(h.transitions, ["SIGNED", "SUBMITTING", "SUBMITTED"]);
  assert.equal(h.calls.sign, 1);
});

test("does not re-submit an attempt that is already in the submission state", async () => {
  const h = harness({
    initialAttemptOverrides: { status: "SUBMISSION_UNKNOWN", version: 6 },
  });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(h.calls.sign, 0);
  assert.equal(h.calls.submit, 0);
});

test("returns the existing active attempt before reserving new capital", async () => {
  const existing = attempt({ status: "SUBMISSION_UNKNOWN", version: 6 });
  const h = harness({ activeAttempt: existing });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(h.calls.reserve, 0);
  assert.equal(h.calls.sign, 0);
  assert.equal(h.calls.submit, 0);
});

test("rejects simulation evidence for a different prepared RFQ payload", async () => {
  const h = harness({ simulationOrderHash: "9".repeat(64) });
  const result = await h.orchestrator.execute({
    ownerId, intentId, outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(h.getAttempt().status, "ABORTED");
  assert.equal(h.calls.submit, 0);
  assert.equal(h.calls.release, 1);
});
