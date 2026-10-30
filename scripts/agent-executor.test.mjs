import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AgentExecutor, createWorkerFailureReporter } from "../services/agentExecutor.ts";
import { AgentWorker } from "../services/agentWorker.ts";
import { parseEther } from "viem";

const HASH = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;
const ACCOUNT = "0x0000000000000000000000000000000000000789";
const TARGET = "0x0000000000000000000000000000000000000456";
const router = "0x0000000000000000000000000000000000000123";
const hook = "0x0000000000000000000000000000000000000321";
const bundlerFlag = process.env.ENABLE_LIVE_USEROP_SUBMISSION;

afterEach(() => {
  if (bundlerFlag === undefined) delete process.env.ENABLE_LIVE_USEROP_SUBMISSION;
  else process.env.ENABLE_LIVE_USEROP_SUBMISSION = bundlerFlag;
});

function createHarness(overrides = {}) {
  let now = Date.now();
  const telemetry = [];
  const failures = [];
  const sentCalls = [];
  const waitOptions = [];
  const config = {
    chain: { id: 97 },
    rpcUrl: "https://rpc.test",
    bundlerRpcUrl: "https://bundler.test",
    routerAddress: router,
    policyHookAddress: hook,
    targetTokenAddress: TARGET,
    wrappedNativeAddress: "0x0000000000000000000000000000000000000001",
  };
  const receipt = {
    success: true,
    actualGasUsed: 200_000n,
    actualGasCost: 1_000_000n,
    receipt: { transactionHash: TX_HASH },
  };
  const accountClient = {
    account: { address: ACCOUNT },
    client: {},
    sendUserOperation: async ({ calls }) => {
      sentCalls.push(calls);
      return HASH;
    },
    waitForUserOperationReceipt: async options => {
      waitOptions.push(options);
      return receipt;
    },
  };
  const dependencies = {
    isLiveEnabled: () => true,
    getConfig: () => config,
    resolveAuthorization: async () => ({ ownerValidator: {}, sessionKeySigner: {} }),
    createAccountClient: async () => ({ account: accountClient.account, client: accountClient }),
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
    }),
    buildBuyCall: async () => ({
      to: router,
      value: parseEther("0.1"),
      data: "0x1234",
      quote: {
        amountOutMin: 100n,
        expectedAmountOut: 120n,
        priceImpactBps: 35,
        slippageBps: 100,
        poolAddress: "0x0000000000000000000000000000000000000999",
      },
    }),
    encodeBuyCall: (_request, amountOutMin) => ({
      to: router,
      value: parseEther("0.1"),
      data: `0x${amountOutMin.toString(16)}`,
    }),
    log: event => telemetry.push(event),
    onFailure: (intent, code, error) => failures.push({ intent, code, error }),
    now: () => now,
    receiptTimeoutMs: 20_000,
    receiptPollingIntervalMs: 1_000,
    ...overrides,
  };
  const intent = {
    strategyId: "aapl-entry",
    account: ACCOUNT,
    targetToken: TARGET,
    amountBnb: parseEther("0.1"),
    amountOutMin: 110n,
    priceImpactBps: 30,
    slippageBps: 100,
    maxPriceImpactBps: 300,
    sourcePriceMicros: 90_000_000n,
    createdAt: new Date(now).toISOString(),
  };

  return {
    executor: new AgentExecutor(dependencies),
    dependencies,
    intent,
    telemetry,
    failures,
    sentCalls,
    waitOptions,
    receipt,
    setNow(value) {
      now = value;
    },
  };
}

test("disabled-by-default gate prevents authorization, account setup, and bundler calls", async () => {
  process.env.ENABLE_LIVE_USEROP_SUBMISSION = "false";
  let resolveCalls = 0;
  let accountCalls = 0;
  const harness = createHarness({
    isLiveEnabled: undefined,
    resolveAuthorization: async () => {
      resolveCalls += 1;
      return { ownerValidator: {}, sessionKeySigner: {} };
    },
    createAccountClient: async () => {
      accountCalls += 1;
      throw new Error("should never be called");
    },
  });

  await assert.rejects(
    harness.executor.executeUserOperation(harness.intent),
    error => error.code === "LIVE_SUBMISSION_DISABLED",
  );
  assert.equal(resolveCalls, 0);
  assert.equal(accountCalls, 0);
  assert.equal(harness.sentCalls.length, 0);
  assert.equal(harness.telemetry[0].code, "LIVE_SUBMISSION_DISABLED");
  assert.equal(harness.failures.length, 0);
});

test("blocks mainnet submission even when live submission is enabled", async () => {
  let accountCalls = 0;
  const harness = createHarness({
    getConfig: () => ({
      ...createHarness().dependencies.getConfig(),
      chain: { id: 56 },
    }),
    createAccountClient: async () => {
      accountCalls += 1;
      throw new Error("should never be called");
    },
  });

  await assert.rejects(
    harness.executor.executeUserOperation(harness.intent),
    error => error.code === "MAINNET_SUBMISSION_BLOCKED",
  );
  assert.equal(accountCalls, 0);
  assert.equal(harness.sentCalls.length, 0);
});

test("submits a signed UserOperation and returns final receipt and gas accounting", async () => {
  const quoteRequests = [];
  const harness = createHarness({
    buildBuyCall: async (_client, request) => {
      quoteRequests.push(request);
      return {
        to: router,
        value: parseEther("0.1"),
        data: "0x1234",
        quote: {
          amountOutMin: 100n,
          expectedAmountOut: 120n,
          priceImpactBps: 35,
          slippageBps: request.slippageBps,
          poolAddress: "0x0000000000000000000000000000000000000999",
        },
      };
    },
  });
  const result = await harness.executor.executeUserOperation(harness.intent);

  assert.equal(result.userOperationHash, HASH);
  assert.equal(result.transactionHash, TX_HASH);
  assert.equal(result.status, "success");
  assert.equal(result.gasUsed, 200_000n);
  assert.equal(result.gasCostWei, 1_000_000n);
  assert.equal(harness.sentCalls.length, 1);
  assert.equal(harness.sentCalls[0][0].to, router);
  assert.equal(harness.sentCalls[0][0].value, parseEther("0.1"));
  assert.equal(harness.sentCalls[0][0].data, "0x6e");
  assert.equal(quoteRequests[0].slippageBps, harness.intent.slippageBps);
  assert.equal(quoteRequests[0].maxPriceImpactBps, harness.intent.maxPriceImpactBps);
  assert.equal(harness.waitOptions[0].hash, HASH);
  assert.equal(harness.waitOptions[0].timeout, 20_000);
  assert.deepEqual(harness.telemetry.map(event => event.event), [
    "userop_prepared",
    "userop_submitted",
    "userop_confirmed",
  ]);
  assert.equal(harness.failures.length, 0);
});

test("labels bundler validation rejections and feeds them into worker failure reporting", async () => {
  const harness = createHarness({
    createAccountClient: async () => ({
      account: { address: ACCOUNT },
      client: {
        sendUserOperation: async () => {
          throw new Error("AA23 invalid account nonce");
        },
        waitForUserOperationReceipt: async () => {
          throw new Error("should not poll");
        },
      },
    }),
  });

  await assert.rejects(
    harness.executor.executeUserOperation(harness.intent),
    error => error.code === "BUNDLER_MEMPOOL_REJECTED",
  );
  assert.equal(harness.failures[0].code, "BUNDLER_MEMPOOL_REJECTED");
  assert.equal(harness.telemetry.at(-1).code, "BUNDLER_MEMPOOL_REJECTED");
});

test("labels included-but-reverted UserOperations and receipt timeouts distinctly", async t => {
  await t.test("on-chain revert", async () => {
    const harness = createHarness();
    harness.receipt.success = false;
    harness.receipt.reason = "execution reverted";
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "ONCHAIN_EXECUTION_REVERTED",
    );
    assert.equal(harness.failures[0].code, "ONCHAIN_EXECUTION_REVERTED");
  });

  await t.test("receipt timeout", async () => {
    const harness = createHarness({
      createAccountClient: async () => ({
        account: { address: ACCOUNT },
        client: {
          sendUserOperation: async () => HASH,
          waitForUserOperationReceipt: async () => {
            throw new Error("Timed out waiting for UserOperation receipt");
          },
        },
      }),
    });
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "USEROP_RECEIPT_TIMEOUT",
    );
    assert.equal(harness.failures[0].code, "USEROP_RECEIPT_TIMEOUT");
  });
});

test("rechecks validator limits and rejects stale or malformed intents before dispatch", async t => {
  await t.test("validator cap", async () => {
    const harness = createHarness({
      readValidator: async () => ({
        paused: false,
        installed: true,
        revoked: false,
        rollingVolume: parseEther("0.95"),
      }),
    });
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
    );
    assert.equal(harness.sentCalls.length, 0);
  });

  await t.test("stale intent", async () => {
    const harness = createHarness();
    harness.setNow(Date.now() + 120_000);
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "INTENT_STALE",
    );
    assert.equal(harness.sentCalls.length, 0);
  });
});

test("worker failure reporter trips the worker panic stop on repeated dispatch failures", async () => {
  const events = [];
  const alerts = [];
  const worker = new AgentWorker({
    strategies: [{
      id: "aapl-entry",
      account: ACCOUNT,
      targetToken: TARGET,
      amountBnb: parseEther("0.1"),
      entryPriceMicros: 100_000_000n,
      slippageBps: 100,
      maxPriceImpactBps: 300,
    }],
    readMarket: async () => { throw new Error("unused"); },
    readValidator: async () => { throw new Error("unused"); },
    log: event => events.push(event),
    alert: event => alerts.push(event),
  }, { intervalMs: 1000, maxConsecutiveFailures: 2, maxMarketAgeMs: 1000 });
  const reportFailure = createWorkerFailureReporter(worker);
  const harness = createHarness({
    onFailure: reportFailure,
    createAccountClient: async () => ({
      account: { address: ACCOUNT },
      client: {
        sendUserOperation: async () => {
          throw new Error("mock bundler rejected operation");
        },
        waitForUserOperationReceipt: async () => {
          throw new Error("should not poll");
        },
      },
    }),
  });

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "BUNDLER_MEMPOOL_REJECTED",
    );
  }
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(events.at(-1).reasonCode, "WORKER_PANIC_STOP");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].priority, "high");
});
