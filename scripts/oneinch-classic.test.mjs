import test from "node:test";
import assert from "node:assert/strict";
import { createOneInchClassicAdapter } from "../services/autonomy/oneinch-classic-adapter.ts";
import {
  createOneInchClassicClient,
  parseOneInchClassicQuote,
  parseOneInchClassicTransaction,
} from "../services/autonomy/oneinch-classic.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const usdt = "0x2222222222222222222222222222222222222222";
const rwa = "0x3333333333333333333333333333333333333333";
const request = {
  chainId: "56", walletAddress: wallet, inputTokenAddress: usdt,
  outputTokenAddress: rwa, amountIn: "1000000", now: 1_800_000_000_000,
};
const quoteResponse = {
  srcToken: { address: usdt, decimals: 6 },
  dstToken: { address: rwa, decimals: 18 },
  srcAmount: "1000000", dstAmount: "950000000000000000",
  gas: "250000", protocols: [[[{ name: "Mock DEX" }]]],
};

test("parses a BSC quote and binds wallet, token direction and exact input", () => {
  const quote = parseOneInchClassicQuote(quoteResponse, request);
  assert.equal(quote.provider, "1inch-classic");
  assert.equal(quote.expectedAmountOut, "950000000000000000");
  assert.equal(quote.chainId, "56");
  assert.equal(quote.walletAddress, wallet);
});

test("rejects wrong chain, token direction, amount and malformed gas", () => {
  assert.throws(() => parseOneInchClassicQuote(quoteResponse, { ...request, chainId: "1" }));
  assert.throws(() => parseOneInchClassicQuote(quoteResponse, { ...request, outputTokenAddress: usdt }));
  assert.throws(() => parseOneInchClassicQuote(quoteResponse, { ...request, amountIn: "2" }));
  assert.throws(() => parseOneInchClassicQuote({ ...quoteResponse, gas: "0" }, request));
});

test("validates unsigned transaction fields and rejects malformed calldata", () => {
  const quote = parseOneInchClassicQuote(quoteResponse, request);
  const tx = parseOneInchClassicTransaction({
    srcAmount: "1000000", dstAmount: "950000000000000000",
    tx: {
      to: "0x4444444444444444444444444444444444444444",
      data: "0x12345678", value: "0", gas: "300000", gasPrice: "3000000000",
    },
  }, quote, 50, request.now + 1);
  assert.equal(tx.provider, "1inch-classic");
  assert.equal(tx.value, "0");
  assert.equal(tx.gas, "300000");
  assert.match(tx.transactionFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => parseOneInchClassicTransaction({
    srcAmount: "1000000", dstAmount: "950000000000000000",
    tx: { to: wallet, data: "0x123", value: "0", gas: "1", gasPrice: "1" },
  }, quote, 50, request.now + 1));
});

test("rejects transaction construction after local quote safety expiry", () => {
  const quote = parseOneInchClassicQuote(quoteResponse, request);
  assert.throws(() => parseOneInchClassicTransaction({ tx: {} }, quote, 50, request.now + 10_001), /expired/);
});

test("client sends authenticated quote and swap requests and builds no signature", async () => {
  const calls = [];
  const client = createOneInchClassicClient({
    apiKey: "test-key",
    now: () => request.now + 1,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const isSwap = String(url).includes("/swap?");
      return new Response(JSON.stringify(isSwap ? {
        srcAmount: "1000000", dstAmount: "950000000000000000",
        tx: { to: "0x4444444444444444444444444444444444444444", data: "0x12345678",
          value: "0", gas: "300000", gasPrice: "3000000000" },
      } : quoteResponse), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const quote = await client.getQuote(request);
  const tx = await client.buildTransaction(quote, 50);
  assert.equal(tx.provider, "1inch-classic");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.match(calls[0].url, /\/56\/quote\?/);
  assert.match(calls[1].url, /\/56\/swap\?/);
  assert.equal(calls[1].init.method, "GET");
});

test("fails closed without API key and rejects invalid slippage", async () => {
  const client = createOneInchClassicClient({ apiKey: "" });
  await assert.rejects(client.getQuote(request), /ONEINCH_API_KEY/);
  const configured = createOneInchClassicClient({ apiKey: "x", fetchImpl: async () =>
    new Response(JSON.stringify(quoteResponse), { status: 200 }) });
  const quote = await configured.getQuote(request);
  await assert.rejects(configured.buildTransaction(quote, 0), /slippage/);
});

test("rejects a swap response whose output breaches the configured slippage floor", () => {
  const quote = parseOneInchClassicQuote(quoteResponse, request);
  assert.throws(() => parseOneInchClassicTransaction({
    srcAmount: "1000000", dstAmount: "900000000000000000",
    tx: { to: "0x4444444444444444444444444444444444444444", data: "0x12345678",
      value: "0", gas: "300000", gasPrice: "3000000000" },
  }, quote, 50, request.now + 1), /below the quote minimum/);
});

test("rejects a swap response with a changed input amount or missing gas price", () => {
  const quote = parseOneInchClassicQuote(quoteResponse, request);
  const base = { srcAmount: "999999", dstAmount: "950000000000000000",
    tx: { to: "0x4444444444444444444444444444444444444444", data: "0x12345678",
      value: "0", gas: "300000", gasPrice: "3000000000" } };
  assert.throws(() => parseOneInchClassicTransaction(base, quote, 50, request.now + 1), /input amount/);
  assert.throws(() => parseOneInchClassicTransaction({
    ...base, srcAmount: "1000000", tx: { ...base.tx, gasPrice: undefined },
  }, quote, 50, request.now + 1), /gasPrice/);
});

test("1inch adapter implements vendor-neutral quote and EVM transaction contracts", async () => {
  const client = createOneInchClassicClient({
    apiKey: "test-key",
    now: () => request.now + 1,
    fetchImpl: async (url) => new Response(JSON.stringify(String(url).includes("/swap?") ? {
      srcAmount: "1000000", dstAmount: "950000000000000000",
      tx: { to: "0x4444444444444444444444444444444444444444", data: "0x12345678",
        value: "0", gas: "300000", gasPrice: "3000000000" },
    } : quoteResponse), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const adapter = createOneInchClassicAdapter(client);
  assert.equal(adapter.isConfigured(), true);
  assert.deepEqual(adapter.supportedChainIds, ["56"]);
  const quote = await adapter.getQuote({ ...request, slippageBps: 50 });
  assert.equal(quote.provider, "1inch-classic");
  assert.equal(quote.tokenMetadata.outputDecimals, 18);
  const prepared = await adapter.prepareExecution({ quote, slippageBps: 50, maxPriceImpactBps: 100 });
  assert.equal(prepared.kind, "EVM_TRANSACTION");
  assert.equal(prepared.provider, "1inch-classic");
  assert.equal(prepared.minimumAmountOut, "945250000000000000");
});
