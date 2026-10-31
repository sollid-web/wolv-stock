import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  BawCliError,
} from "../services/bawCli.ts";
import { BSC_USDT_ADDRESS } from "../lib/apiValidation.ts";
import {
  BawExecutionError,
  createBawExecutionApproval,
  executeApprovedBawTrade,
  reconcileBawExecution,
} from "../services/bawExecution.ts";
import { BawExecutionStore } from "../services/bawExecutionStore.ts";
import { BawExecutionMemoryTestStore } from "../services/bawExecutionStore.testAdapter.ts";
import { getBawQuote } from "../services/bawQuote.ts";
import {
  handleBawApprovalPost as handleApprovalHttp,
  handleBawExecutionAction,
} from "../services/bawExecutionHttp.ts";

const TOKEN = "0x0000000000000000000000000000000000000123";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const SECRET = "baw-execution-tests-secret-with-at-least-32-characters";
const TOKEN_VALUE = "test-baw-operator-token-at-least-32-characters";
const NOW = 1_800_000_000_000;
const ORIGINAL_SECRET = process.env.BINANCE_SECRET_KEY;

before(() => {
  process.env.BINANCE_SECRET_KEY = SECRET;
});

after(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BINANCE_SECRET_KEY;
  else process.env.BINANCE_SECRET_KEY = ORIGINAL_SECRET;
});

const asset = {
  tokenContractAddress: TOKEN,
  underlyingTicker: "AAPL",
  symbol: "AAPLon",
  referencePrice: "100",
  tokenToShareRatio: "1",
  statusInfo: { marketStatus: "open", openState: true },
};

function makeSnapshot(overrides = {}) {
  return {
    connected: true,
    fetchedAt: new Date(NOW).toISOString(),
    chains: [{ binanceChainId: "56", name: "BNB Smart Chain", simpleName: "BSC" }],
    addresses: [{ binanceChainId: "56", chainName: "BSC", address: WALLET }],
    balances: [
      { symbol: "USDT", contractAddress: BSC_USDT_ADDRESS, binanceChainId: "56", balance: "1000", priceUsd: "1", valueUsd: "1000" },
      { symbol: "AAPLon", contractAddress: TOKEN, binanceChainId: "56", balance: "100", priceUsd: "100", valueUsd: "10000" },
      { symbol: "BNB", contractAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", binanceChainId: "56", balance: "1", priceUsd: "500", valueUsd: "500" },
    ],
    settings: {
      dailyLimit: 50_000,
      quotaUsed: 0,
      quotaLeft: 50_000,
      abnormalTxnHandling: "AutoReject",
      tradeAllTokens: false,
      predictionEnabled: false,
      sessionExpireTime: new Date(NOW + 60_000).toISOString(),
    },
    errors: [],
    ...overrides,
  };
}

function makeHarness(options = {}) {
  const store = new BawExecutionMemoryTestStore();
  const calls = [];
  let quoteCount = 0;
  let currentNow = NOW;
  const snapshot = options.snapshot ?? makeSnapshot();
  const runner = async (args) => {
    calls.push([...args]);
    if (args[1] === "quote") {
      quoteCount += 1;
      if (options.quoteError && quoteCount > (options.quoteErrorAfter ?? 0)) throw options.quoteError;
      const direction = args[5].toLowerCase() === BSC_USDT_ADDRESS.toLowerCase() ? "BUY" : "SELL";
      const amount = args[3];
      const outputAmount = options.changedQuote && quoteCount > 1
        ? (direction === "BUY" ? "0.099" : "9.9")
        : (direction === "BUY" ? "0.1" : "10");
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            fromCoinSymbol: direction === "BUY" ? "USDT" : "AAPLon",
            fromCoinAmount: amount,
            toCoinSymbol: direction === "BUY" ? "AAPLon" : "USDT",
            toCoinAmount: outputAmount,
            slippage: 0.01,
          },
        }),
      };
    }
    if (args[1] === "swap") {
      if (options.swapError) throw options.swapError;
      return { stdout: '{"success":true,"data":{"orderId":"1234567890"}}' };
    }
    if (args[1] === "list") {
      if (options.listError) throw options.listError;
      const swap = calls.find((call) => call[1] === "swap");
      const fromToken = swap[5];
      const toToken = swap[7];
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            total: 1,
            page: 1,
            pageSize: 20,
            list: [{
              orderType: "market",
              orderId: "1234567890",
              chain: "56",
              fromToken,
              fromTokenName: "USDT",
              fromTokenQty: swap[3],
              toToken,
              toTokenName: "AAPLon",
              toTokenActualQty: swap[5].toLowerCase() === BSC_USDT_ADDRESS.toLowerCase() ? "0.1" : "10",
              status: options.orderStatus ?? "FINISHED",
              slippage: "1",
              txHash: `0x${"a".repeat(64)}`,
              bookTime: options.orderHistoryTime ?? "2026-04-01T23:50:10+08:00",
              updatedTime: "2026-04-01T23:50:12+08:00",
              ...(options.refund ? { refund: [{ tokenAddress: fromToken, amount: "0.1", symbol: "USDT" }] } : {}),
            }],
          },
        }),
      };
    }
    throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
  };
  const dependencies = {
    store,
    runner,
    readSnapshot: async () => options.snapshot ?? snapshot,
    resolveAsset: async (address) => address.toLowerCase() === TOKEN.toLowerCase() ? asset : null,
    now: () => currentNow,
    sleep: async () => {},
    environment: {
      VERCEL: "",
      BAW_EXECUTION_ENABLED: "true",
      BAW_EXECUTION_KILL_SWITCH: "false",
      BAW_EXECUTION_MAX_ORDER_USDT: "1000",
      BAW_EXECUTION_DAILY_LIMIT_USDT: "5000",
      BAW_EXECUTION_MAX_SLIPPAGE_BPS: "100",
      BAW_EXECUTION_MIN_BNB_RESERVE: "0.01",
    },
  };
  return {
    store,
    calls,
    runner,
    dependencies,
    setNow(value) { currentNow = value; },
  };
}

async function createQuote(harness, direction = "BUY") {
  return getBawQuote({
    direction,
    tokenAddress: TOKEN,
    amount: direction === "BUY" ? "10" : "0.1",
    chainId: "56",
    slippageBps: 100,
  }, {
    runner: harness.runner,
    readSnapshot: async () => makeSnapshot(),
    resolveAsset: async () => asset,
    now: () => NOW,
  });
}

function request(body, token = TOKEN_VALUE) {
  return new Request("https://wolv.test/api/agent/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("mocked BUY and SELL execution flows require one-time approval and verify provider status", async (t) => {
  for (const direction of ["BUY", "SELL"]) {
    await t.test(direction, async () => {
      const harness = makeHarness();
      try {
        const quote = await createQuote(harness, direction);
        const approval = await createBawExecutionApproval(quote, harness.dependencies);
        assert.equal(approval.trade.direction, direction);
        assert.equal(approval.trade.chainId, "56");
        assert.equal(approval.trade.minimumOutputAmount, direction === "BUY" ? "0.099" : "9.9");
        const result = await executeApprovedBawTrade({
          executionId: approval.executionId,
          approvalToken: approval.approvalToken,
          securityAuditAcknowledged: true,
        }, harness.dependencies);
        assert.equal(result.state, "FILLED");
        assert.equal(result.providerOrderId, "1234567890");
        assert.equal(result.actualReceivedOutput, direction === "BUY" ? "0.1" : "10");
        assert.equal(result.transactionHash, `0x${"a".repeat(64)}`);
        const swap = harness.calls.find((args) => args[1] === "swap");
        assert.equal(swap[3], direction === "BUY" ? "10" : "0.1");
        assert.equal(swap[5].toLowerCase(), direction === "BUY" ? BSC_USDT_ADDRESS.toLowerCase() : TOKEN.toLowerCase());
        assert.equal(swap[7].toLowerCase(), direction === "BUY" ? TOKEN.toLowerCase() : BSC_USDT_ADDRESS.toLowerCase());
        assert.deepEqual(swap.slice(-5), ["--mev", "true", "--gasLevel", "MEDIUM", "--json"]);
      } finally {
        harness.store.close();
      }
    });
  }
});

test("approval is single-use, short-lived, and bound to the exact quote", async (t) => {
  await t.test("reused token", async () => {
    const harness = makeHarness();
    try {
      const quote = await createQuote(harness);
      const approval = await createBawExecutionApproval(quote, harness.dependencies);
      await executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies);
      await assert.rejects(
        executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies),
        (error) => error instanceof BawExecutionError && error.code === "APPROVAL_USED",
      );
    } finally { harness.store.close(); }
  });

  await t.test("tampered quote output", async () => {
    const harness = makeHarness();
    try {
      const quote = await createQuote(harness);
      await assert.rejects(
        createBawExecutionApproval({ ...quote, toCoinAmount: "9" }, harness.dependencies),
        (error) => error instanceof BawExecutionError && error.code === "QUOTE_INVALID",
      );
    } finally { harness.store.close(); }
  });

  await t.test("expired approval", async () => {
    const harness = makeHarness();
    try {
      const approval = await createBawExecutionApproval(await createQuote(harness), harness.dependencies);
      harness.setNow(approval.expiresAt + 1);
      await assert.rejects(
        executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies),
        (error) => error instanceof BawExecutionError && error.code === "APPROVAL_EXPIRED",
      );
      assert.equal((await harness.store.get(approval.executionId)).state, "EXPIRED");
    } finally { harness.store.close(); }
  });

  await t.test("invalid approval token does not consume the valid approval", async () => {
    const harness = makeHarness();
    try {
      const approval = await createBawExecutionApproval(await createQuote(harness), harness.dependencies);
      const lastCharacter = approval.approvalToken.at(-1);
      const invalidToken = `${approval.approvalToken.slice(0, -1)}${lastCharacter === "x" ? "y" : "x"}`;
      await assert.rejects(
        executeApprovedBawTrade({ ...approval, approvalToken: invalidToken, securityAuditAcknowledged: true }, harness.dependencies),
        (error) => error instanceof BawExecutionError && error.code === "APPROVAL_USED",
      );
      assert.equal(
        (await executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies)).state,
        "FILLED",
      );
    } finally { harness.store.close(); }
  });

  await t.test("live quote changed after display", async () => {
    const harness = makeHarness({ changedQuote: true });
    try {
      const quote = await createQuote(harness);
      await assert.rejects(
        createBawExecutionApproval(quote, harness.dependencies),
        (error) => error instanceof BawExecutionError && error.code === "QUOTE_CHANGED",
      );
    } finally { harness.store.close(); }
  });
});

test("persistent single-flight lock rejects a second prepared approval", async () => {
  const harness = makeHarness();
  try {
    const quote = await createQuote(harness);
    await createBawExecutionApproval(quote, harness.dependencies);
    await assert.rejects(
      createBawExecutionApproval(quote, harness.dependencies),
      (error) => error instanceof BawExecutionError && error.code === "BUSY",
    );
  } finally { harness.store.close(); }
});

test("execution storage requires a PostgreSQL connection and rejects file-backed SQLite paths", () => {
  assert.throws(
    () => new BawExecutionStore(""),
    (error) => error?.code === "NOT_CONFIGURED",
  );
  assert.throws(
    () => new BawExecutionStore("/tmp/wolv-executions.sqlite"),
    (error) => error?.code === "UNSAFE_PATH",
  );
});

test("PostgreSQL execution records survive independent store instances", { skip: !process.env.BAW_TEST_DATABASE_URL }, async () => {
  const harness = makeHarness();
  const firstStore = new BawExecutionStore(process.env.BAW_TEST_DATABASE_URL);
  let firstStoreOpen = true;
  let secondStore;
  let thirdStore;
  try {
    harness.dependencies.store = firstStore;
    const approval = await createBawExecutionApproval(await createQuote(harness), harness.dependencies);
    const record = await firstStore.get(approval.executionId);
    assert.equal(record?.state, "APPROVAL_REQUIRED");
    const challengeHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    const sessionId = randomUUID();
    await firstStore.createChallenge(challengeHash, WALLET, NOW + 60_000, NOW);
    await firstStore.close();
    firstStoreOpen = false;
    await assert.rejects(firstStore.get(approval.executionId));
    secondStore = new BawExecutionStore(process.env.BAW_TEST_DATABASE_URL);
    try {
      assert.equal((await secondStore.get(approval.executionId))?.state, "APPROVAL_REQUIRED");
      thirdStore = new BawExecutionStore(process.env.BAW_TEST_DATABASE_URL);
      const sessionAttempts = await Promise.all([
        secondStore.consumeChallengeAndCreateSession(challengeHash, WALLET, NOW + 1, sessionId, NOW + 60_000),
        thirdStore.consumeChallengeAndCreateSession(challengeHash, WALLET, NOW + 1, sessionId, NOW + 60_000),
      ]);
      assert.deepEqual(sessionAttempts.sort(), [false, true]);
      assert.deepEqual(await thirdStore.getSession(sessionId, NOW + 2), {
        address: WALLET,
        expiresAt: NOW + 60_000,
      });
      await secondStore.revokeSession(sessionId, NOW + 3);
      assert.equal(await thirdStore.getSession(sessionId, NOW + 4), null);
      await assert.rejects(
        secondStore.createApproval(record, "0".repeat(64), NOW + 10_000, NOW),
        (error) => error?.code === "BUSY",
      );
      const approvalHash = createHash("sha256").update(approval.approvalToken).digest("hex");
      const consumptions = await Promise.allSettled([
        secondStore.consumeApproval(approval.executionId, approvalHash, NOW),
        thirdStore.consumeApproval(approval.executionId, approvalHash, NOW),
      ]);
      assert.equal(consumptions.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(consumptions.filter((result) => result.status === "rejected").length, 1);
      assert.equal(consumptions.find((result) => result.status === "rejected")?.reason?.code, "USED");
    } finally {
      const cleanup = secondStore ? await secondStore.get(approval.executionId) : null;
      if (cleanup) {
        cleanup.state = "FAILED";
        await secondStore.update(cleanup);
      }
    }
  } finally {
    harness.store.close();
    if (thirdStore) await thirdStore.close();
    if (secondStore) await secondStore.close();
    if (firstStoreOpen) await firstStore.close();
  }
});

test("daily cap includes consumed executions without counting the active execution twice", async () => {
  const harness = makeHarness();
  try {
    harness.dependencies.environment.BAW_EXECUTION_DAILY_LIMIT_USDT = "10";
    const quote = await createQuote(harness);
    const approval = await createBawExecutionApproval(quote, harness.dependencies);
    const result = await executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies);
    assert.equal(result.state, "FILLED");
    assert.equal(await harness.store.dailyNotionalSince(Date.UTC(2027, 0, 15)), 10);
    await assert.rejects(
      createBawExecutionApproval(await createQuote(harness), harness.dependencies),
      (error) => error instanceof BawExecutionError && error.code === "DAILY_LIMIT",
    );
  } finally {
    harness.store.close();
  }
});

test("concurrent submissions consume one approval once", async () => {
  const harness = makeHarness();
  try {
    const approval = await createBawExecutionApproval(await createQuote(harness), harness.dependencies);
    const request = { ...approval, securityAuditAcknowledged: true };
    const results = await Promise.allSettled([
      executeApprovedBawTrade(request, harness.dependencies),
      executeApprovedBawTrade(request, harness.dependencies),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(harness.calls.filter((args) => args[1] === "swap").length, 1);
  } finally {
    harness.store.close();
  }
});

test("wallet, token, chain, session, balance, and kill-switch failures fail closed", async (t) => {
  const cases = [
    ["disconnected wallet", { connected: false }, "WALLET_DISCONNECTED", "BUY"],
    ["unsupported chain", { chains: [] }, "UNSUPPORTED_CHAIN", "BUY"],
    ["expired session", { settings: { ...makeSnapshot().settings, sessionExpireTime: new Date(NOW - 1).toISOString() } }, "WALLET_SESSION_EXPIRED", "BUY"],
    ["insufficient USDT balance", { balances: [] }, "INSUFFICIENT_TRADE_BALANCE", "BUY"],
    ["insufficient selected-token balance", {
      balances: makeSnapshot().balances.filter((balance) => balance.symbol !== "AAPLon"),
    }, "INSUFFICIENT_TRADE_BALANCE", "SELL"],
    ["insufficient BNB reserve", {
      balances: makeSnapshot().balances.map((balance) => balance.symbol === "BNB" ? { ...balance, balance: "0" } : balance),
    }, "INSUFFICIENT_FEE_RESERVE", "BUY"],
  ];
  for (const [label, snapshotPatch, code, direction] of cases) {
    await t.test(label, async () => {
      const harness = makeHarness({ snapshot: makeSnapshot(snapshotPatch) });
      try {
        const quote = await createQuote(harness, direction);
        await assert.rejects(
          createBawExecutionApproval(quote, harness.dependencies),
          (error) => error instanceof BawExecutionError && error.code === code,
        );
      } finally { harness.store.close(); }
    });
  }

  await t.test("unconfigured token asset", async () => {
    const harness = makeHarness();
    try {
      const quote = await createQuote(harness);
      harness.dependencies.resolveAsset = async () => null;
      await assert.rejects(createBawExecutionApproval(quote, harness.dependencies));
    } finally { harness.store.close(); }
  });

  await t.test("kill switch", async () => {
    const harness = makeHarness();
    try {
      harness.dependencies.environment.BAW_EXECUTION_KILL_SWITCH = "true";
      await assert.rejects(
        createBawExecutionApproval({}, harness.dependencies),
        (error) => error instanceof BawExecutionError && error.code === "EXECUTION_DISABLED",
      );
    } finally { harness.store.close(); }
  });
});

test("missing and excessive execution limits keep order submission disabled", async (t) => {
  const cases = [
    ["missing slippage limit", "BAW_EXECUTION_MAX_SLIPPAGE_BPS", undefined],
    ["slippage over hard cap", "BAW_EXECUTION_MAX_SLIPPAGE_BPS", "101"],
    ["order over hard cap", "BAW_EXECUTION_MAX_ORDER_USDT", "1001"],
    ["daily amount over hard cap", "BAW_EXECUTION_DAILY_LIMIT_USDT", "5001"],
    ["BNB reserve below minimum", "BAW_EXECUTION_MIN_BNB_RESERVE", "0.009"],
  ];
  for (const [label, key, value] of cases) {
    await t.test(label, async () => {
      const harness = makeHarness();
      try {
        if (value === undefined) delete harness.dependencies.environment[key];
        else harness.dependencies.environment[key] = value;
        await assert.rejects(
          createBawExecutionApproval(await createQuote(harness), harness.dependencies),
          (error) => error instanceof BawExecutionError && error.code === "EXECUTION_LIMITS_NOT_CONFIGURED",
        );
        assert.equal(harness.calls.some((args) => args[1] === "swap"), false);
      } finally { harness.store.close(); }
    });
  }
});

test("uncertain submission and provider states are never represented as success", async (t) => {
  for (const [options, expectedState] of [
    [{ swapError: new BawCliError("BAW_TIMEOUT", "market-order") }, "UNKNOWN"],
    [{ orderStatus: "PENDING" }, "PENDING"],
    [{ orderStatus: "FAILED" }, "FAILED"],
    [{ refund: true }, "PARTIALLY_FILLED"],
    [{ listError: new BawCliError("INVALID_OUTPUT", "market-order") }, "UNKNOWN"],
  ]) {
    await t.test(expectedState, async () => {
      const harness = makeHarness(options);
      try {
        const quote = await createQuote(harness);
        const approval = await createBawExecutionApproval(quote, harness.dependencies);
        const result = await executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies);
        assert.equal(result.state, expectedState);
        if (expectedState === "UNKNOWN") assert.equal(result.transactionHash, null);
      } finally { harness.store.close(); }
    });
  }
});

test("uncertain submission is reconciled through the documented filtered order history", async () => {
  const harness = makeHarness({
    swapError: new BawCliError("BAW_TIMEOUT", "market-order"),
    orderHistoryTime: new Date(NOW).toISOString(),
  });
  try {
    const quote = await createQuote(harness);
    const approval = await createBawExecutionApproval(quote, harness.dependencies);
    const uncertain = await executeApprovedBawTrade({ ...approval, securityAuditAcknowledged: true }, harness.dependencies);
    assert.equal(uncertain.state, "UNKNOWN");
    assert.equal(uncertain.providerOrderId, null);
    const reconciled = await reconcileBawExecution(approval.executionId, harness.dependencies);
    assert.equal(reconciled.providerOrderId, "1234567890");
    assert.equal(reconciled.state, "FILLED");
    assert.ok(harness.calls.some((args) => args[1] === "list" && args.includes("--startTime")));
  } finally { harness.store.close(); }
});

test("execution API rejects missing, invalid, and unconfigured bearer credentials before service calls", async (t) => {
  for (const [label, configuredToken, requestToken, status] of [
    ["missing token", TOKEN_VALUE, null, 401],
    ["invalid token", TOKEN_VALUE, "wrong-token-value-with-more-than-32-chars", 401],
    ["unconfigured", "", TOKEN_VALUE, 503],
  ]) {
    await t.test(label, async () => {
      let called = false;
      const response = await handleApprovalHttp(request({ quote: {} }, requestToken), {
        configuredToken,
        resolveAsset: async () => { called = true; return asset; },
      });
      assert.equal(response.status, status);
      assert.equal(called, false);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
  }
});

test("approval API returns a one-time token only after live quote and wallet revalidation", async () => {
  const harness = makeHarness();
  try {
    const quote = await createQuote(harness);
    const response = await handleApprovalHttp(request({ quote }), {
      ...harness.dependencies,
      configuredToken: TOKEN_VALUE,
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.status, "APPROVAL_REQUIRED");
    assert.equal(body.trade.direction, "BUY");
    assert.match(body.approvalToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.trade.walletAddress, WALLET);
  } finally { harness.store.close(); }
});

test("execution API requires bearer authentication and an exact approval payload", async (t) => {
  for (const [label, token, body, expectedStatus] of [
    ["no token", null, { action: "executeBaw", executionId: "id", approvalToken: "x" }, 401],
    ["extra payload arguments", TOKEN_VALUE, { action: "executeBaw", executionId: "id", approvalToken: "x", amount: "999" }, 422],
  ]) {
    await t.test(label, async () => {
      const req = new Request("https://wolv.test/api/agent/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      const response = await handleBawExecutionAction(req, body, {
        configuredToken: TOKEN_VALUE,
        resolveAsset: async () => asset,
      });
      assert.equal(response.status, expectedStatus);
    });
  }
});
