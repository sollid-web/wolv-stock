import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { encodeFunctionData } from "viem";
import { BSC_USDT_ADDRESS } from "../lib/apiValidation.ts";
import {
  createBrowserTradeBinding,
  verifyBrowserTradeBinding,
} from "../lib/browserTradeBinding.ts";
import {
  validateApprovalTransaction,
  validateBinanceRfqTypedData,
  validateBinanceSwapResponse,
} from "../lib/binanceExecutionValidation.ts";
import { verifySwapReceiptOutput } from "../lib/swapOutcomeVerification.ts";
import {
  BrowserTradeQuoteError,
  createBrowserTradeQuote,
  handleBrowserTradeQuoteRequest,
} from "../services/browserTradeQuote.ts";
import {
  BrowserTradeIntentStoreError,
  hashQuoteBinding,
} from "../services/browserTradeIntentStore.ts";
import { rejectUnsupportedBrowserExecution } from "../services/browserTradeExecutionBoundary.ts";

const SECRET = "browser-trade-hardening-test-secret-at-least-32-characters";
const ORIGINAL_SECRET = process.env.BINANCE_SECRET_KEY;
const TOKEN = "0x0000000000000000000000000000000000000123";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const QUOTE_ID = "00112233445566778899aabbccddeeff";
const AMOUNT = "10000000000000000000";
const NOW = 1_800_000_000_000;

before(() => {
  process.env.BINANCE_SECRET_KEY = SECRET;
});

after(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BINANCE_SECRET_KEY;
  else process.env.BINANCE_SECRET_KEY = ORIGINAL_SECRET;
});

class MemoryTradeStore {
  intents = new Map();
  initialized = false;
  failInitialize = false;

  async initialize() {
    if (this.failInitialize) throw new Error("database unavailable");
    this.initialized = true;
  }

  async close() {}

  async create(intent) {
    if (this.intents.has(intent.executionId)) throw new Error("duplicate intent");
    this.intents.set(intent.executionId, structuredClone(intent));
  }

  async get(id) {
    const intent = this.intents.get(id);
    return intent ? structuredClone(intent) : null;
  }

  async prepare(id, wallet, now) {
    const intent = this.intents.get(id);
    if (!intent || intent.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
      throw new BrowserTradeIntentStoreError("NOT_FOUND");
    }
    if (intent.expiresAt <= now) {
      intent.state = "EXPIRED";
      throw new BrowserTradeIntentStoreError("EXPIRED");
    }
    if (intent.state !== "CREATED") {
      throw new BrowserTradeIntentStoreError("CONSUMED");
    }
    intent.state = "PREPARED";
    return structuredClone(intent);
  }

  async reject(id, code) {
    const intent = this.intents.get(id);
    if (!intent || intent.state !== "PREPARED") throw new Error("invalid transition");
    intent.state = "REJECTED";
    intent.failureCode = code;
    return structuredClone(intent);
  }

  async claimSubmission(id, key) {
    const intent = this.intents.get(id);
    if (!intent) throw new BrowserTradeIntentStoreError("NOT_FOUND");
    if (
      intent.idempotencyKey === key &&
      ["SUBMISSION_PENDING", "SUBMITTED", "UNKNOWN", "CONFIRMED", "OUTPUT_VERIFIED", "OUTPUT_MISMATCH", "REVERTED"].includes(intent.state)
    ) return structuredClone(intent);
    if (intent.state !== "PREPARED" || intent.idempotencyKey !== null) {
      throw new BrowserTradeIntentStoreError("CONSUMED");
    }
    intent.state = "SUBMISSION_PENDING";
    intent.idempotencyKey = key;
    return structuredClone(intent);
  }

  async updateSubmission() {
    throw new Error("not used");
  }
}

function quoteResponse(overrides = {}) {
  return {
    success: true,
    data: [{
      quoteId: QUOTE_ID,
      binanceChainId: "56",
      fromTokenAmount: AMOUNT,
      toTokenAmount: "100000",
      fromToken: {
        tokenContractAddress: BSC_USDT_ADDRESS,
        tokenUnitPrice: "1",
        decimal: "18",
      },
      toToken: {
        tokenContractAddress: TOKEN,
        decimal: "6",
      },
      executionMode: "RFQ",
      ...overrides,
    }],
  };
}

function dependencies(store, overrides = {}) {
  const calls = [];
  return {
    calls,
    values: {
      store,
      now: () => NOW,
      createExecutionId: () => EXECUTION_ID,
      isSpotToken: async () => true,
      getAssetList: async () => ({
        data: [{
          tokenContractAddress: TOKEN,
          underlyingTicker: "AAPL",
          platformId: "test",
          referencePrice: "100",
          tokenToShareRatio: "1",
        }],
      }),
      getQuote: async (...args) => {
        calls.push(args);
        return quoteResponse();
      },
      ...overrides,
    },
  };
}

async function createQuote(store, overrides = {}) {
  const deps = dependencies(store, overrides);
  const quote = await createBrowserTradeQuote(
    { toToken: TOKEN, amount: AMOUNT, wallet: WALLET },
    deps.values,
  );
  return { quote, calls: deps.calls, store };
}

test("mocked quote persists a BUY intent before returning the quote", async () => {
  const store = new MemoryTradeStore();
  const { quote, calls } = await createQuote(store);
  const intent = await store.get(EXECUTION_ID);

  assert.equal(store.initialized, true);
  assert.deepEqual(calls, [[TOKEN, AMOUNT, WALLET]]);
  assert.equal(quote.status, "QUOTED");
  assert.equal(quote.executionEligibility, "NOT_AVAILABLE");
  assert.equal(quote.tradeIntent.direction, "BUY");
  assert.equal(quote.tradeIntent.chainId, 56);
  assert.equal(quote.tradeIntent.fromTokenAddress, BSC_USDT_ADDRESS);
  assert.equal(quote.tradeIntent.toTokenAddress, TOKEN);
  assert.equal(quote.tradeIntent.minimumOutputAmount, "99500");
  assert.equal(intent.state, "CREATED");
  assert.equal(intent.inputAmount, AMOUNT);
  assert.equal(intent.expectedOutputAmount, "100000");
  assert.equal(intent.slippageBps, 50);
  assert.equal(intent.quoteBindingHash, hashQuoteBinding(quote.quoteBinding));
});

test("mocked quote API handler returns no-store-ready success and explicit errors", async (t) => {
  const store = new MemoryTradeStore();
  const deps = dependencies(store);
  const url = `https://wolv.test/api/quote?toToken=${TOKEN}&amount=${AMOUNT}&userWalletAddress=${WALLET}`;
  const response = await handleBrowserTradeQuoteRequest(new Request(url), deps.values);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "QUOTED");

  const missing = await handleBrowserTradeQuoteRequest(
    new Request("https://wolv.test/api/quote"),
    deps.values,
  );
  assert.equal(missing.status, 400);

  const failingStore = new MemoryTradeStore();
  failingStore.failInitialize = true;
  const failed = await handleBrowserTradeQuoteRequest(new Request(url), dependencies(failingStore).values);
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /storage is unavailable/i);
});

test("storage and input guards run before any provider quote request", async (t) => {
  await t.test("storage unavailable", async () => {
    const store = new MemoryTradeStore();
    store.failInitialize = true;
    let quoteRequested = false;
    await assert.rejects(
      createBrowserTradeQuote(
        { toToken: TOKEN, amount: AMOUNT, wallet: WALLET },
        dependencies(store, { getQuote: async () => { quoteRequested = true; return quoteResponse(); } }).values,
      ),
      (error) => error instanceof BrowserTradeQuoteError && error.status === 503,
    );
    assert.equal(quoteRequested, false);
  });

  for (const [label, input] of [
    ["invalid address", { toToken: "invalid", amount: AMOUNT, wallet: WALLET }],
    ["invalid amount", { toToken: TOKEN, amount: "1e18", wallet: WALLET }],
    ["dead wallet", { toToken: TOKEN, amount: AMOUNT, wallet: "0x000000000000000000000000000000000000dEaD" }],
  ]) {
    await t.test(label, async () => {
      const store = new MemoryTradeStore();
      let quoteRequested = false;
      await assert.rejects(
        createBrowserTradeQuote(input, dependencies(store, {
          getQuote: async () => { quoteRequested = true; return quoteResponse(); },
        }).values),
        (error) => error instanceof BrowserTradeQuoteError && error.status === 400,
      );
      assert.equal(quoteRequested, false);
    });
  }

  await t.test("unsupported asset", async () => {
    const store = new MemoryTradeStore();
    let quoteRequested = false;
    await assert.rejects(
      createBrowserTradeQuote(
        { toToken: TOKEN, amount: AMOUNT, wallet: WALLET },
        dependencies(store, {
          isSpotToken: async () => false,
          getQuote: async () => { quoteRequested = true; return quoteResponse(); },
        }).values,
      ),
      (error) => error instanceof BrowserTradeQuoteError && error.status === 400,
    );
    assert.equal(quoteRequested, false);
  });
});

test("malformed quote output and missing reference data fail closed", async (t) => {
  const cases = [
    ["missing quote id", { quoteId: undefined }, undefined],
    ["malformed quote id", { quoteId: "quote_123" }, undefined],
    ["wrong chain", { binanceChainId: "97" }, undefined],
    ["wrong execution mode", { executionMode: "SWAP" }, undefined],
    ["wrong source token", { fromToken: { tokenContractAddress: TOKEN, tokenUnitPrice: "1", decimal: "18" } }, undefined],
    ["wrong destination token", { toToken: { tokenContractAddress: BSC_USDT_ADDRESS, decimal: "18" } }, undefined],
    ["missing output decimals", { toToken: { tokenContractAddress: TOKEN } }, undefined],
    ["non-string smallest-unit amount", { toTokenAmount: 100000000000000000 }, undefined],
    ["hex smallest-unit amount", { toTokenAmount: "0x16345785d8a0000" }, undefined],
    ["malformed output", { toTokenAmount: "0" }, undefined],
    ["missing reference price", {}, { data: [{ tokenContractAddress: TOKEN, referencePrice: null, tokenToShareRatio: "1" }] }],
  ];
  for (const [label, quoteOverrides, assetList] of cases) {
    await t.test(label, async () => {
      const store = new MemoryTradeStore();
      const providers = {};
      if (assetList) providers.getAssetList = async () => assetList;
      providers.getQuote = async () => quoteResponse(quoteOverrides);
      await assert.rejects(
        createBrowserTradeQuote(
          { toToken: TOKEN, amount: AMOUNT, wallet: WALLET },
          dependencies(store, providers).values,
        ),
        (error) => error instanceof BrowserTradeQuoteError && error.status === 502,
      );
      assert.equal(store.intents.size, 0);
    });
  }
});

test("browser quote binding rejects tampering, parameter substitution, and expiry", () => {
  const quoteBinding = createBrowserTradeBinding({
    executionId: EXECUTION_ID,
    quoteId: QUOTE_ID,
    wallet: WALLET,
    chainId: 56,
    direction: "BUY",
    fromToken: BSC_USDT_ADDRESS,
    toToken: TOKEN,
    amount: AMOUNT,
    slippageBps: 50,
  }, NOW);
  const expected = {
    executionId: EXECUTION_ID,
    quoteId: QUOTE_ID,
    wallet: WALLET,
    chainId: 56,
    direction: "BUY",
    fromToken: BSC_USDT_ADDRESS,
    toToken: TOKEN,
    amount: AMOUNT,
    slippageBps: 50,
  };

  assert.equal(verifyBrowserTradeBinding(quoteBinding, expected, NOW + 29_999).ok, true);
  assert.equal(verifyBrowserTradeBinding(`${quoteBinding}x`, expected, NOW).ok, false);
  assert.equal(verifyBrowserTradeBinding(quoteBinding, { ...expected, wallet: TOKEN }, NOW).ok, false);
  assert.equal(verifyBrowserTradeBinding(quoteBinding, { ...expected, chainId: 97 }, NOW).ok, false);
  assert.equal(verifyBrowserTradeBinding(quoteBinding, expected, NOW + 30_000).ok, false);
});

test("unsupported execution intent is atomically consumed and cannot be reused", async () => {
  const store = new MemoryTradeStore();
  const { quote } = await createQuote(store);
  const input = {
    executionId: quote.executionIntentId,
    quoteId: quote.quoteId,
    quoteBinding: quote.quoteBinding,
    wallet: WALLET,
    toToken: TOKEN,
    amount: AMOUNT,
    operation: "SWAP",
    now: NOW,
    store,
  };

  const rejected = await rejectUnsupportedBrowserExecution(input);
  assert.deepEqual(rejected, { ok: true, code: "UNSUPPORTED_SWAP_SCHEMA" });
  assert.equal((await store.get(EXECUTION_ID)).state, "REJECTED");
  const retry = await rejectUnsupportedBrowserExecution(input);
  assert.deepEqual(retry, {
    ok: false,
    status: 409,
    code: "CONSUMED",
    reason: "Trade intent has already been consumed.",
  });
});

test("expired bound intent is durably marked expired before rejection", async () => {
  const store = new MemoryTradeStore();
  const { quote } = await createQuote(store);
  const result = await rejectUnsupportedBrowserExecution({
    executionId: quote.executionIntentId,
    quoteId: quote.quoteId,
    quoteBinding: quote.quoteBinding,
    wallet: WALLET,
    toToken: TOKEN,
    amount: AMOUNT,
    operation: "SWAP",
    now: NOW + 30_000,
    store,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 410);
  assert.equal((await store.get(EXECUTION_ID)).state, "EXPIRED");
});

test("intent submission is single-use, idempotent by key, and concurrent-safe in the adapter", async (t) => {
  await t.test("same idempotency key returns the existing intent", async () => {
    const store = new MemoryTradeStore();
    await createQuote(store);
    await store.prepare(EXECUTION_ID, WALLET, NOW);
    const key = "123e4567-e89b-42d3-a456-426614174001";
    const first = await store.claimSubmission(EXECUTION_ID, key);
    const retry = await store.claimSubmission(EXECUTION_ID, key);
    assert.equal(first.state, "SUBMISSION_PENDING");
    assert.deepEqual(retry, first);
  });

  await t.test("different idempotency key cannot consume the same intent", async () => {
    const store = new MemoryTradeStore();
    await createQuote(store);
    await store.prepare(EXECUTION_ID, WALLET, NOW);
    await store.claimSubmission(EXECUTION_ID, "123e4567-e89b-42d3-a456-426614174001");
    await assert.rejects(
      store.claimSubmission(EXECUTION_ID, "123e4567-e89b-42d3-a456-426614174002"),
      (error) => error instanceof BrowserTradeIntentStoreError && error.code === "CONSUMED",
    );
  });

  await t.test("concurrent different keys allow exactly one claim", async () => {
    const store = new MemoryTradeStore();
    await createQuote(store);
    await store.prepare(EXECUTION_ID, WALLET, NOW);
    const results = await Promise.allSettled([
      store.claimSubmission(EXECUTION_ID, "123e4567-e89b-42d3-a456-426614174001"),
      store.claimSubmission(EXECUTION_ID, "123e4567-e89b-42d3-a456-426614174002"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  });
});

test("approval calldata is exact, quote-bound, and limited to reviewed spenders", () => {
  const spender = "0x0000000000000000000000000000000000000456";
  const trustedSpenders = [spender];
  const calldata = encodeFunctionData({
    abi: [{
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: [{ type: "bool" }],
    }],
    functionName: "approve",
    args: [spender, BigInt(AMOUNT)],
  });
  const input = {
    tokenAddress: BSC_USDT_ADDRESS,
    calldata,
    spender,
    quoteBoundSpender: spender,
    trustedSpenders,
    expectedAmount: AMOUNT,
    currentAllowance: "0",
  };

  assert.deepEqual(validateApprovalTransaction(input), { ok: true, spender, amount: AMOUNT, kind: "EXACT" });
  assert.equal(validateApprovalTransaction({ ...input, calldata: "0x1234" }).ok, false);
  assert.equal(validateApprovalTransaction({ ...input, expectedAmount: "1" }).ok, false);
  assert.equal(validateApprovalTransaction({ ...input, quoteBoundSpender: TOKEN }).ok, false);
  assert.equal(validateApprovalTransaction({ ...input, trustedSpenders: [] }).ok, false);
  assert.equal(validateApprovalTransaction({ ...input, tokenAddress: TOKEN }).ok, false);
});

test("approval validator supports only a necessary zero-reset approval", () => {
  const spender = "0x0000000000000000000000000000000000000456";
  const calldata = encodeFunctionData({
    abi: [{
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: [{ type: "bool" }],
    }],
    functionName: "approve",
    args: [spender, 0n],
  });
  const input = {
    tokenAddress: BSC_USDT_ADDRESS,
    calldata,
    spender,
    quoteBoundSpender: spender,
    trustedSpenders: [spender],
    expectedAmount: AMOUNT,
    currentAllowance: "1",
    resetOnly: true,
  };
  assert.deepEqual(validateApprovalTransaction(input), { ok: true, spender, amount: "0", kind: "ZERO_RESET" });
  assert.equal(validateApprovalTransaction({ ...input, currentAllowance: "0" }).ok, false);
});

test("Binance execution schemas fail closed without verified fixtures", () => {
  assert.equal(validateBinanceSwapResponse({ tx: { to: TOKEN, data: "0x12345678" } }).code, "UNSUPPORTED_SWAP_SCHEMA");
  assert.equal(validateBinanceRfqTypedData({ domain: {}, message: {} }).code, "UNSUPPORTED_RFQ_SCHEMA");
});

test("receipt verification requires successful status and expected token transfer", async (t) => {
  const recipientTopic = `0x${WALLET.slice(2).padStart(64, "0")}`;
  const transferLog = {
    address: TOKEN,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(64)}`,
      recipientTopic,
    ],
    data: `0x${BigInt("100").toString(16).padStart(64, "0")}`,
  };
  const base = {
    receipt: { status: "success", logs: [transferLog] },
    tokenAddress: TOKEN,
    recipientAddress: WALLET,
    minimumOutputAmount: "100",
  };

  assert.deepEqual(verifySwapReceiptOutput(base), {
    state: "OUTPUT_VERIFIED",
    receivedAmount: "100",
    reason: null,
  });
  await t.test("missing receipt", () => {
    assert.equal(verifySwapReceiptOutput({ ...base, receipt: null }).state, "UNKNOWN");
  });
  await t.test("reverted receipt", () => {
    assert.equal(verifySwapReceiptOutput({ ...base, receipt: { status: "reverted", logs: [] } }).state, "REVERTED");
  });
  await t.test("wrong recipient", () => {
    assert.equal(verifySwapReceiptOutput({
      ...base,
      receipt: { status: "success", logs: [{ ...transferLog, topics: [transferLog.topics[0], transferLog.topics[1], `0x${"0".repeat(64)}`] }] },
    }).state, "OUTPUT_MISMATCH");
  });
  await t.test("wrong token", () => {
    assert.equal(verifySwapReceiptOutput({ ...base, tokenAddress: WALLET }).state, "OUTPUT_MISMATCH");
  });
  await t.test("below minimum", () => {
    assert.equal(verifySwapReceiptOutput({ ...base, minimumOutputAmount: "101" }).state, "OUTPUT_MISMATCH");
  });
});
