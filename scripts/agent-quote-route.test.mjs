import assert from "node:assert/strict";
import test from "node:test";
import { BawQuoteError } from "../services/bawQuote.ts";
import { BawCliError } from "../services/bawCli.ts";
import { handleBawQuotePost } from "../services/bawQuoteHttp.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const INPUT = {
  direction: "BUY",
  tokenAddress: "0x0000000000000000000000000000000000000123",
  amount: "10",
  chainId: "56",
  slippageBps: 100,
};

const QUOTE = {
  status: "QUOTED",
  eligibility: "ELIGIBLE",
  rejectionReasons: [],
  direction: "BUY",
  chainId: "56",
  tokenAddress: INPUT.tokenAddress,
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  fromTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
  toTokenAddress: INPUT.tokenAddress,
  fromCoinSymbol: "USDT",
  fromCoinAmount: "10",
  toCoinSymbol: "AAPLon",
  toCoinAmount: "0.1",
  slippage: 0.01,
  slippageBps: 100,
  tokenPriceUsd: 100,
  referencePrice: 100,
  referenceGapPercent: 0,
  quoteFetchedAt: 1_000,
  expiresAt: 31_000,
  quoteBinding: "mock-binding",
  execution: { transactionSubmitted: false, signingRequested: false },
};

function request(body = INPUT, authorization = `Bearer ${TOKEN}`, headers = {}) {
  return new Request("https://wolv.test/api/agent/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("authenticated API request returns the quote-only result without caching", async () => {
  let received;
  const response = await handleBawQuotePost(request(), {
    configuredToken: TOKEN,
    quote: async (input) => {
      received = input;
      return QUOTE;
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(received, INPUT);
  assert.deepEqual(await response.json(), QUOTE);
});

test("unconfigured and invalid bearer authorization are rejected before the quote service", async (t) => {
  for (const [name, configuredToken, authorization, status] of [
    ["unconfigured", "", `Bearer ${TOKEN}`, 503],
    ["missing", TOKEN, null, 401],
    ["invalid", TOKEN, "Bearer wrong", 401],
    ["wrong scheme", TOKEN, `Basic ${TOKEN}`, 401],
  ]) {
    await t.test(name, async () => {
      let called = false;
      const response = await handleBawQuotePost(request(INPUT, authorization), {
        configuredToken,
        quote: async () => {
          called = true;
          return QUOTE;
        },
      });
      assert.equal(response.status, status);
      assert.equal(called, false);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).status, "REJECTED");
    });
  }
});

test("invalid inputs, unsupported chains, malformed JSON, and oversized requests are rejected", async (t) => {
  const invalidCases = [
    ["unsupported chain", { ...INPUT, chainId: "CT_501" }],
    ["unsupported token address", { ...INPUT, tokenAddress: "not-an-address" }],
    ["invalid direction", { ...INPUT, direction: "SWAP" }],
    ["invalid amount", { ...INPUT, amount: "1e2" }],
    ["excess slippage", { ...INPUT, slippageBps: 501 }],
    ["extra fields", { ...INPUT, execution: true }],
  ];
  for (const [name, body] of invalidCases) {
    await t.test(name, async () => {
      let called = false;
      const response = await handleBawQuotePost(request(body), {
        configuredToken: TOKEN,
        quote: async () => {
          called = true;
          return QUOTE;
        },
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).status, "REJECTED");
      assert.equal(called, false);
    });
  }

  await t.test("malformed JSON", async () => {
    const response = await handleBawQuotePost(request("{"), { configuredToken: TOKEN });
    assert.equal(response.status, 400);
  });

  await t.test("oversized body", async () => {
    const response = await handleBawQuotePost(request(
      { ...INPUT, extra: "x".repeat(9_000) },
      `Bearer ${TOKEN}`,
    ), { configuredToken: TOKEN });
    assert.equal(response.status, 413);
  });
});

test("wallet-disconnected and BAW failures map to explicit rejected API results", async (t) => {
  const errors = [
    ["disconnected wallet", new BawQuoteError("WALLET_DISCONNECTED", "BAW wallet disconnected.", 409), 409],
    ["CLI timeout", new BawCliError("BAW_TIMEOUT", "quote"), 504],
    ["rate limit", new BawCliError("BAW_RATE_LIMITED", "quote"), 429],
    ["malformed BAW response", new BawCliError("INVALID_OUTPUT", "quote"), 502],
  ];
  for (const [name, error, status] of errors) {
    await t.test(name, async () => {
      const response = await handleBawQuotePost(request(), {
        configuredToken: TOKEN,
        quote: async () => {
          throw error;
        },
      });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.status, "REJECTED");
      assert.ok(body.error);
      assert.deepEqual(body.rejectionReasons, [body.error]);
    });
  }
});

test("API rejects requests without JSON content type", async () => {
  const response = await handleBawQuotePost(request(INPUT, `Bearer ${TOKEN}`, {
    "content-type": "text/plain",
  }), { configuredToken: TOKEN, quote: async () => QUOTE });
  assert.equal(response.status, 400);
});
