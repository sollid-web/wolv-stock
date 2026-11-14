import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  AgentExecutor,
  createWorkerFailureReporter,
  resolveAgentExecutionNetwork,
} from "../services/agentExecutor.ts";
import { AgentWorker } from "../services/agentWorker.ts";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  parseAbiParameters,
  parseEther,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAgentBuyCall } from "../lib/smartAccount.ts";
import { hashAgentPolicy } from "../lib/agentPolicyHash.ts";

const HASH = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;
const OWNER = "0x0000000000000000000000000000000000000111";
const ACCOUNT = "0x0000000000000000000000000000000000000789";
const TARGET = "0x0000000000000000000000000000000000000456";
const router = "0x0000000000000000000000000000000000000123";
const hook = "0x0000000000000000000000000000000000000321";
const INTENT_NONCE = `0x${"d".repeat(64)}`;
const intentSigningAccount = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const INTENT_SIGNER = intentSigningAccount.address;
const POLICY_EXPIRY = 2_000_000_000n;
const POLICY_HASH = hashAgentPolicy({
  strategyId: "aapl-entry",
  ownerAddress: OWNER,
  account: ACCOUNT,
  targetToken: TARGET,
  maxTradeValue: parseEther("0.5"),
  expiresAt: POLICY_EXPIRY,
  intentSigner: INTENT_SIGNER,
  amountBnb: parseEther("0.1"),
  entryPriceMicros: 100_000_000n,
  slippageBps: 100,
  maxPriceImpactBps: 300,
});
const ROUTER_BUY_ABI = [{
  type: "function",
  name: "swapExactETHForTokens",
  stateMutability: "payable",
  inputs: [
    { name: "amountOutMin", type: "uint256" },
    { name: "path", type: "address[]" },
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [{ name: "amounts", type: "uint256[]" }],
}];
const KERNEL_EXECUTE_ABI = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "mode", type: "bytes32" },
    { name: "executionCalldata", type: "bytes" },
  ],
  outputs: [],
}];
const bundlerFlag = process.env.ENABLE_LIVE_USEROP_SUBMISSION;
const autonomousFlag = process.env.WOLV_AUTONOMOUS_TRADING_ENABLED;

afterEach(() => {
  if (bundlerFlag === undefined) delete process.env.ENABLE_LIVE_USEROP_SUBMISSION;
  else process.env.ENABLE_LIVE_USEROP_SUBMISSION = bundlerFlag;
  if (autonomousFlag === undefined) delete process.env.WOLV_AUTONOMOUS_TRADING_ENABLED;
  else process.env.WOLV_AUTONOMOUS_TRADING_ENABLED = autonomousFlag;
});

function createHarness(overrides = {}) {
  process.env.WOLV_AUTONOMOUS_TRADING_ENABLED = "true";
  let now = Date.now();
  const telemetry = [];
  const failures = [];
  const sentCalls = [];
  const waitOptions = [];
  const signedTypedData = [];
  let intentSignature;
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
    resolveAuthorization: async () => ({
      ownerValidator: {},
      sessionKeySigner: {},
    }),
    createIntentSigner: async () => ({
      account: {
        ...intentSigningAccount,
        signTypedData: async typedData => {
          signedTypedData.push(typedData);
          intentSignature = await intentSigningAccount.signTypedData(typedData);
          return intentSignature;
        },
      },
      getSignerData: () => INTENT_SIGNER,
    }),
    getNextIntentNonce: async account => {
      assert.equal(account, ACCOUNT);
      return INTENT_NONCE;
    },
    createAccountClient: async () => ({ account: accountClient.account, client: accountClient }),
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
      policyConfigured: true,
      policyHash: POLICY_HASH,
      maxTradeValue: parseEther("0.5"),
      expiresAt: POLICY_EXPIRY,
      intentSigner: INTENT_SIGNER,
      entryPriceMicros: 100_000_000n,
      maxSlippageBps: 100,
      maxPriceImpactBps: 300,
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
    ownerAddress: OWNER,
    account: ACCOUNT,
    targetToken: TARGET,
    amountBnb: parseEther("0.1"),
    amountOutMin: 110n,
    priceImpactBps: 30,
    slippageBps: 100,
    maxPriceImpactBps: 300,
    sourcePriceMicros: 90_000_000n,
    entryPriceMicros: 100_000_000n,
    createdAt: new Date(now).toISOString(),
    policyHash: POLICY_HASH,
  };

  return {
    executor: new AgentExecutor(dependencies),
    dependencies,
    intent,
    telemetry,
    failures,
    sentCalls,
    waitOptions,
    signedTypedData,
    get intentSignature() {
      return intentSignature;
    },
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

test("network resolver requires separate acknowledgement for mainnet", () => {
  assert.equal(resolveAgentExecutionNetwork(97, {
    ENABLE_LIVE_USEROP_SUBMISSION: "true",
    WOLV_AUTONOMOUS_TRADING_ENABLED: "false",
  }).allowed, false);
  assert.deepEqual(resolveAgentExecutionNetwork(97, {
    ENABLE_LIVE_USEROP_SUBMISSION: "true",
    WOLV_AUTONOMOUS_TRADING_ENABLED: "true",
  }), { allowed: true, chainId: 97 });
  assert.equal(resolveAgentExecutionNetwork(56, {
    ENABLE_LIVE_USEROP_SUBMISSION: "true",
    WOLV_AUTONOMOUS_TRADING_ENABLED: "true",
    ENABLE_MAINNET_AGENT_TRADING: "false",
  }).allowed, false);
  assert.deepEqual(resolveAgentExecutionNetwork(56, {
    ENABLE_LIVE_USEROP_SUBMISSION: "true",
    WOLV_AUTONOMOUS_TRADING_ENABLED: "true",
    ENABLE_MAINNET_AGENT_TRADING: "true",
    MAINNET_AGENT_TRADING_ACK: "I_ACCEPT_AUTONOMOUS_MAINNET_RISK",
  }), { allowed: true, chainId: 56 });
  assert.equal(resolveAgentExecutionNetwork(1, {}).allowed, false);
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
  assert.ok(harness.sentCalls[0][0].data.startsWith("0x6e"));
  assert.ok(harness.sentCalls[0][0].data.length > 200);
  assert.equal(harness.signedTypedData.length, 1);
  assert.equal(harness.signedTypedData[0].domain.verifyingContract, hook);
  assert.equal(harness.signedTypedData[0].primaryType, "TradeIntent");
  assert.equal(harness.signedTypedData[0].message.smartAccount, ACCOUNT);
  assert.equal(harness.signedTypedData[0].message.policyHash, POLICY_HASH);
  assert.equal(harness.signedTypedData[0].message.router, router);
  assert.equal(harness.signedTypedData[0].message.tokenIn, harness.dependencies.getConfig().wrappedNativeAddress);
  assert.equal(harness.signedTypedData[0].message.tokenOut, TARGET);
  assert.equal(harness.signedTypedData[0].message.recipient, ACCOUNT);
  assert.ok(harness.signedTypedData[0].message.deadline > BigInt(Math.floor(Date.now() / 1000)));
  assert.equal(harness.signedTypedData[0].message.amountIn, harness.intent.amountBnb);
  assert.equal(harness.signedTypedData[0].message.amountOutMin, 110n);
  assert.equal(harness.signedTypedData[0].message.nonce, INTENT_NONCE);
  assert.equal(BigInt(quoteRequests[0].deadline), harness.signedTypedData[0].message.deadline);
  assert.equal(
    await recoverTypedDataAddress({
      ...harness.signedTypedData[0],
      signature: harness.intentSignature,
    }),
    INTENT_SIGNER,
  );
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

test("constructs the exact Kernel router call and 320-byte signed intent envelope", async () => {
  const harness = createHarness({
    buildBuyCall: async (_client, request, config) => {
      const call = encodeAgentBuyCall({
        accountAddress: ACCOUNT,
        amountBnb: parseEther("0.1"),
        deadline: request.deadline,
      }, 100n, config);
      return {
        ...call,
        quote: {
          amountOutMin: 100n,
          expectedAmountOut: 120n,
          priceImpactBps: 35,
          slippageBps: request.slippageBps,
          poolAddress: "0x0000000000000000000000000000000000000999",
        },
      };
    },
    encodeBuyCall: (request, amountOutMin, config) => encodeAgentBuyCall({
      accountAddress: request.accountAddress,
      amountBnb: request.amountBnb,
      deadline: request.deadline,
    }, amountOutMin, config),
  });
  await harness.executor.executeUserOperation(harness.intent);

  const call = harness.sentCalls[0][0];
  const routerCalldata = call.data.slice(0, 2 + 228 * 2);
  const envelope = `0x${call.data.slice(2 + 228 * 2)}`;
  assert.equal((call.data.length - 2) / 2, 228 + 320);
  assert.equal(routerCalldata.slice(0, 10), "0x7ff36ab5");
  assert.equal((envelope.length - 2) / 2, 320);

  const routerCall = decodeFunctionData({
    abi: ROUTER_BUY_ABI,
    data: routerCalldata,
  });
  assert.equal(routerCall.functionName, "swapExactETHForTokens");
  assert.equal(routerCall.args[0], 110n);
  assert.deepEqual(routerCall.args[1], [
    harness.dependencies.getConfig().wrappedNativeAddress,
    TARGET,
  ]);
  assert.equal(routerCall.args[2], ACCOUNT);
  assert.equal(BigInt(routerCall.args[3]), harness.signedTypedData[0].message.deadline);

  const wordAt = (hex, byteOffset) =>
    BigInt(`0x${hex.slice(2 + byteOffset * 2, 2 + (byteOffset + 32) * 2)}`);
  assert.equal(wordAt(routerCalldata, 36), 128n);
  assert.equal(wordAt(routerCalldata, 132), 2n);

  const [policyHash, nonce, validUntil, slippageBps, maxPriceImpactBps, signature] =
    decodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, uint64, uint16, uint16, bytes"),
      envelope,
    );
  assert.equal(policyHash, POLICY_HASH);
  assert.equal(nonce, INTENT_NONCE);
  assert.equal(validUntil, harness.signedTypedData[0].message.validUntil);
  assert.equal(slippageBps, harness.intent.slippageBps);
  assert.equal(maxPriceImpactBps, harness.intent.maxPriceImpactBps);
  assert.equal((signature.length - 2) / 2, 65);
  assert.equal(signature, harness.intentSignature);

  const executionCalldata = `0x${call.to.slice(2).padStart(40, "0")}${call.value.toString(16).padStart(64, "0")}${call.data.slice(2)}`;
  const kernelCallData = encodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    functionName: "execute",
    args: [`0x${"00".repeat(32)}`, executionCalldata],
  });
  const kernelCall = decodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    data: kernelCallData,
  });
  assert.equal(kernelCall.functionName, "execute");
  assert.equal(kernelCall.args[0], `0x${"00".repeat(32)}`);
  assert.equal(kernelCall.args[1].slice(2, 42), router.slice(2));
  assert.equal(BigInt(`0x${kernelCall.args[1].slice(42, 106)}`), call.value);
  assert.equal(kernelCall.args[1].slice(106), call.data.slice(2));
  assert.equal((kernelCall.args[1].length - 2) / 2, 52 + 228 + 320);
  const kernelArguments = `0x${kernelCallData.slice(10)}`;
  assert.equal(wordAt(kernelArguments, 0), 0n);
  assert.equal(wordAt(kernelArguments, 32), 64n);
  assert.equal(wordAt(kernelArguments, 64), 52n + 228n + 320n);

  assert.equal(
    await recoverTypedDataAddress({
      ...harness.signedTypedData[0],
      signature,
    }),
    INTENT_SIGNER,
  );
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

  await t.test("intent expires while building the quote", async () => {
    const harness = createHarness();
    const buildBuyCall = harness.dependencies.buildBuyCall;
    harness.dependencies.buildBuyCall = async (...args) => {
      const call = await buildBuyCall(...args);
      harness.setNow(Date.now() + 20_001);
      return call;
    };
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "INTENT_STALE",
    );
    assert.equal(harness.sentCalls.length, 0);
  });
});

test("fails closed when persistent nonce allocation is unavailable", async () => {
  const harness = createHarness({
    getNextIntentNonce: async () => {
      throw new Error("Redis unavailable");
    },
  });
  await assert.rejects(
    harness.executor.executeUserOperation(harness.intent),
    error => error.code === "INTENT_NONCE_UNAVAILABLE" && /nonce allocation failed/i.test(error.message),
  );
  assert.equal(harness.signedTypedData.length, 0);
  assert.equal(harness.sentCalls.length, 0);
  assert.equal(harness.failures[0].code, "INTENT_NONCE_UNAVAILABLE");
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

test("executor rejects an unknown strategy label before signing or dispatch", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.executor.executeUserOperation({
      ...harness.intent,
      strategyId: "unregistered-entry",
    }),
    error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
  );
  assert.equal(harness.signedTypedData.length, 0);
  assert.equal(harness.sentCalls.length, 0);
});

test("onchain account policy rejects missing, expired, capped, and mismatched intent bindings", async () => {
  const policyHash = `0x${"a".repeat(64)}`;
  const expiredHarness = createHarness({
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
      policyConfigured: true,
      policyHash,
      maxTradeValue: parseEther("0.5"),
      expiresAt: 1n,
      intentSigner: INTENT_SIGNER,
    }),
  });

  test("refuses dispatch when the configured onchain intent signer differs from the session key", async () => {
    const harness = createHarness({
      readValidator: async () => ({
        paused: false,
        installed: true,
        revoked: false,
        rollingVolume: 0n,
        policyConfigured: true,
        policyHash: POLICY_HASH,
        maxTradeValue: parseEther("0.5"),
        expiresAt: BigInt(Math.floor((Date.now() + 60_000) / 1000)),
        intentSigner: "0x0000000000000000000000000000000000000789",
      }),
    });
    await assert.rejects(
      harness.executor.executeUserOperation(harness.intent),
      error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
    );
    assert.equal(harness.signedTypedData.length, 0);
    assert.equal(harness.sentCalls.length, 0);
  });
  await assert.rejects(
    expiredHarness.executor.executeUserOperation({ ...expiredHarness.intent, policyHash }),
    error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
  );

  const mismatchHarness = createHarness({
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
      policyConfigured: true,
      policyHash,
      maxTradeValue: parseEther("0.5"),
      expiresAt: BigInt(Math.floor((Date.now() + 60_000) / 1000)),
      intentSigner: INTENT_SIGNER,
    }),
  });
  await assert.rejects(
    mismatchHarness.executor.executeUserOperation({
      ...mismatchHarness.intent,
      policyHash: `0x${"b".repeat(64)}`,
    }),
    error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
  );

  const capHarness = createHarness({
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
      policyConfigured: true,
      policyHash,
      maxTradeValue: parseEther("0.05"),
      expiresAt: BigInt(Math.floor((Date.now() + 60_000) / 1000)),
      intentSigner: INTENT_SIGNER,
    }),
  });
  await assert.rejects(
    capHarness.executor.executeUserOperation({ ...capHarness.intent, policyHash }),
    error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
  );
});

test("refuses dispatch when on-chain V2 risk limits differ from the strategy", async () => {
  const harness = createHarness({
    readValidator: async () => ({
      paused: false,
      installed: true,
      revoked: false,
      rollingVolume: parseEther("0.2"),
      policyConfigured: true,
      policyHash: POLICY_HASH,
      maxTradeValue: parseEther("0.5"),
      expiresAt: POLICY_EXPIRY,
      intentSigner: INTENT_SIGNER,
      entryPriceMicros: 100_000_000n,
      maxSlippageBps: 101,
      maxPriceImpactBps: 300,
    }),
  });
  await assert.rejects(
    harness.executor.executeUserOperation(harness.intent),
    error => error.code === "VALIDATOR_PREFLIGHT_FAILED",
  );
  assert.equal(harness.signedTypedData.length, 0);
  assert.equal(harness.sentCalls.length, 0);
});
