import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  BSC_USDT_ADDRESS,
  MINIMUM_ORDER_WEI,
} from "../lib/apiValidation.ts";
import { createQuoteBinding, verifyQuoteBinding } from "../lib/quoteBinding.ts";
import { isFreshQuote, TRADE_QUOTE_TTL_MS } from "../lib/tradeReadiness.ts";
import {
  BawQuoteError,
  getBawQuote,
  parseAgentQuoteInput,
  slippageBpsToBawPercent,
} from "../services/bawQuote.ts";
import {
  BawCliError,
  buildBawMarketQuoteArgs,
  parseBawMarketQuoteArgs,
} from "../services/bawCli.ts";

const TOKEN = "0x0000000000000000000000000000000000000123";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const TOKEN_SYMBOL = "AAPLon";
const SECRET = "baw-quote-tests-secret-with-at-least-32-characters";
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
  symbol: TOKEN_SYMBOL,
  referencePrice: "100",
  tokenToShareRatio: "1",
  statusInfo: { marketStatus: "open", openState: true },
};

const connectedSnapshot = {
  connected: true,
  fetchedAt: new Date(1_000).toISOString(),
  chains: [{ binanceChainId: "56", name: "BNB Smart Chain", simpleName: "BSC" }],
  addresses: [{ binanceChainId: "56", chainName: "BSC", address: WALLET }],
  balances: [],
  settings: null,
  errors: [],
};

function request(direction = "BUY", overrides = {}) {
  return {
    direction,
    tokenAddress: TOKEN,
    amount: direction === "BUY" ? "10" : "0.1",
    chainId: "56",
    slippageBps: 100,
    ...overrides,
  };
}

function cliResponse(direction, overrides = {}) {
  const data = direction === "BUY"
    ? {
        fromCoinSymbol: "USDT",
        fromCoinAmount: "10",
        toCoinSymbol: TOKEN_SYMBOL,
        toCoinAmount: "0.1",
        slippage: 0.01,
      }
    : {
        fromCoinSymbol: TOKEN_SYMBOL,
        fromCoinAmount: "0.1",
        toCoinSymbol: "USDT",
        toCoinAmount: "10",
        slippage: 0.01,
      };
  return JSON.stringify({ success: true, data: { ...data, ...overrides } });
}

function dependencies(direction, options = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      now: () => options.now ?? 1_000,
      readSnapshot: async () => options.snapshot ?? connectedSnapshot,
      resolveAsset: async () => options.asset === undefined ? asset : options.asset,
      runner: async (args) => {
        calls.push([...args]);
        if (options.runnerError) throw options.runnerError;
        return { stdout: options.stdout ?? cliResponse(direction, options.outputOverrides) };
      },
    },
  };
}

test("strict request parsing normalizes human quantities and validates direction, chain, address, amount and slippage", () => {
  assert.deepEqual(parseAgentQuoteInput(request("BUY", { amount: "10.000" })), {
    ok: true,
    input: { ...request("BUY"), amount: "10" },
  });
  for (const invalid of [
    { ...request(), direction: "buy" },
    { ...request(), tokenAddress: "0x123" },
    { ...request(), chainId: "97" },
    { ...request(), amount: "1e2" },
    { ...request(), amount: "0" },
    { ...request(), amount: "1.0000000000000000001" },
    { ...request(), slippageBps: 0 },
    { ...request(), slippageBps: 501 },
    { ...request(), slippageBps: "100" },
    { ...request(), extra: true },
  ]) {
    assert.equal(parseAgentQuoteInput(invalid).ok, false, JSON.stringify(invalid));
  }
});

test("BUY and SELL map explicitly to USDT and selected token using BAW human-readable quantities", async (t) => {
  const cases = [
    { direction: "BUY", amount: "10", from: BSC_USDT_ADDRESS, to: TOKEN },
    { direction: "SELL", amount: "0.1", from: TOKEN, to: BSC_USDT_ADDRESS },
  ];
  for (const entry of cases) {
    await t.test(entry.direction, async () => {
      const harness = dependencies(entry.direction);
      const result = await getBawQuote(request(entry.direction), harness.dependencies);
      assert.equal(result.status, "QUOTED");
      assert.equal(result.eligibility, "ELIGIBLE");
      assert.equal(result.fromTokenAddress, entry.from);
      assert.equal(result.toTokenAddress, entry.to);
      assert.equal(result.tokenPriceUsd, 100);
      assert.equal(
        verifyQuoteBinding(result.quoteBinding, {
          toToken: entry.to,
          fromToken: entry.from,
          amount: entry.amount,
          wallet: WALLET,
          quoteId: result.quoteBindingId,
          chainId: "56",
          direction: entry.direction,
          slippageBps: 100,
        }, result.quoteFetchedAt).ok,
        true,
      );
      assert.deepEqual(harness.calls[0], [
        "market-order", "quote",
        "--fromTokenQty", entry.amount,
        "--fromToken", entry.from,
        "--toToken", entry.to,
        "--binanceChainId", "56",
        "--slippage", "1",
        "--json",
      ]);
      assert.equal(result.execution.transactionSubmitted, false);
      assert.equal(result.execution.signingRequested, false);
    });
  }
});

test("derives BAW token symbols only from explicit supported provider mappings", async (t) => {
  const bstockAsset = {
    ...asset,
    underlyingTicker: "GLW",
    symbol: undefined,
    platformId: "bstock",
  };
  await t.test("bStock suffix", async () => {
    const harness = dependencies("BUY", {
      asset: bstockAsset,
      stdout: JSON.stringify({
        success: true,
        data: {
          fromCoinSymbol: "USDT",
          fromCoinAmount: "5",
          toCoinSymbol: "GLWB",
          toCoinAmount: "0.04",
          slippage: 0.01,
        },
      }),
    });
    const result = await getBawQuote(request("BUY", { amount: "5" }), harness.dependencies);
    assert.equal(result.toCoinSymbol, "GLWB");
  });

  await t.test("unknown provider rejected without CLI call", async () => {
    const harness = dependencies("BUY", {
      asset: { ...bstockAsset, platformId: "unknown-platform" },
    });
    await assert.rejects(
      getBawQuote(request(), harness.dependencies),
      (error) => error instanceof BawQuoteError && error.code === "UNSUPPORTED_TOKEN",
    );
    assert.equal(harness.calls.length, 0);
  });
});

test("slippage conversion is exact and capped at the existing 500 bps ceiling", () => {
  assert.equal(slippageBpsToBawPercent(1), "0.01");
  assert.equal(slippageBpsToBawPercent(50), "0.5");
  assert.equal(slippageBpsToBawPercent(100), "1");
  assert.equal(slippageBpsToBawPercent(500), "5");
  assert.throws(() => slippageBpsToBawPercent(501), BawQuoteError);
});

test("CLI argument builder and runner allow only validated quote commands", async () => {
  const input = {
    direction: "BUY",
    tokenAddress: TOKEN,
    amount: "5",
    chainId: "56",
    slippagePercent: "0.5",
  };
  const args = buildBawMarketQuoteArgs(input);
  assert.equal(parseBawMarketQuoteArgs(args).direction, "BUY");
  assert.equal(parseBawMarketQuoteArgs([
    ...args.slice(0, -1), "--mev", "false", "--json",
  ]), null);
  for (const invalid of [
    { ...input, chainId: "97" },
    { ...input, tokenAddress: "not-an-address" },
    { ...input, amount: "1e3" },
    { ...input, amount: "0" },
    { ...input, slippagePercent: "auto" },
    { ...input, slippagePercent: "5.01" },
  ]) {
    assert.throws(() => buildBawMarketQuoteArgs(invalid), BawCliError);
  }
});

test("disconnected wallet and unsupported spot tokens are rejected before the quote command", async (t) => {
  await t.test("disconnected BAW session", async () => {
    const harness = dependencies("BUY", {
      snapshot: { ...connectedSnapshot, connected: false, addresses: [], chains: [] },
    });
    await assert.rejects(
      getBawQuote(request(), harness.dependencies),
      (error) => error instanceof BawQuoteError && error.code === "WALLET_DISCONNECTED",
    );
    assert.equal(harness.calls.length, 0);
  });

  await t.test("unsupported asset", async () => {
    const harness = dependencies("BUY", { asset: null });
    await assert.rejects(
      getBawQuote(request(), harness.dependencies),
      (error) => error instanceof BawQuoteError && error.code === "UNSUPPORTED_TOKEN",
    );
    assert.equal(harness.calls.length, 0);
  });
});

test("minimum order and market-session guardrails reject without requesting a quote", async (t) => {
  await t.test("BUY below five USDT", async () => {
    const harness = dependencies("BUY");
    await assert.rejects(
      getBawQuote(request("BUY", { amount: "4.99" }), harness.dependencies),
      (error) => error instanceof BawQuoteError && error.code === "ORDER_BELOW_MINIMUM",
    );
    assert.equal(harness.calls.length, 0);
  });

  await t.test("SELL estimated below five USDT", async () => {
    const harness = dependencies("SELL");
    await assert.rejects(
      getBawQuote(request("SELL", { amount: "0.04" }), harness.dependencies),
      (error) => error instanceof BawQuoteError && error.code === "ORDER_BELOW_MINIMUM",
    );
    assert.equal(harness.calls.length, 0);
  });

  await t.test("closed market session", async () => {
    const harness = dependencies("BUY", {
      asset: { ...asset, statusInfo: { marketStatus: "closed", openState: false } },
    });
    await assert.rejects(
      getBawQuote(request(), harness.dependencies),
      (error) => error instanceof BawQuoteError && error.code === "MARKET_SESSION_CLOSED",
    );
    assert.equal(harness.calls.length, 0);
  });
});

test("reference-gap and actual SELL proceeds guardrails preserve the quote and report rejection reasons", async (t) => {
  await t.test("reference price outlier", async () => {
    const harness = dependencies("BUY", { outputOverrides: { toCoinAmount: "0.08" } });
    const result = await getBawQuote(request(), harness.dependencies);
    assert.equal(result.status, "QUOTED");
    assert.equal(result.eligibility, "REJECTED");
    assert.match(result.rejectionReasons.join(" "), /reference price/i);
  });

  await t.test("quoted SELL proceeds below minimum", async () => {
    const harness = dependencies("SELL", { outputOverrides: { toCoinAmount: "4.99" } });
    const result = await getBawQuote(request("SELL"), harness.dependencies);
    assert.equal(result.eligibility, "REJECTED");
    assert.match(result.rejectionReasons.join(" "), /below the 5 USDT minimum/i);
  });
});

test("timeouts, BAW rate limits, and malformed quote responses fail closed", async (t) => {
  await t.test("timeout", async () => {
    const harness = dependencies("BUY", { runnerError: new BawCliError("BAW_TIMEOUT", "quote") });
    await assert.rejects(getBawQuote(request(), harness.dependencies), /BAW_TIMEOUT/);
  });

  await t.test("rate limit", async () => {
    const harness = dependencies("BUY", {
      stdout: JSON.stringify({ success: false, code: 42900, msg: "rate limit exceeded" }),
    });
    await assert.rejects(getBawQuote(request(), harness.dependencies), /BAW_RATE_LIMITED/);
  });

  await t.test("malformed and unexpected output", async () => {
    for (const stdout of [
      "{",
      JSON.stringify({ success: true, data: { fromCoinAmount: "10" } }),
      JSON.stringify({ success: true, data: {
        fromCoinSymbol: "USDT",
        fromCoinAmount: "10",
        toCoinSymbol: TOKEN_SYMBOL,
        toCoinAmount: "0.1",
        slippage: 0.005,
        orderId: "unexpected",
      } }),
      cliResponse("BUY", { fromCoinAmount: "9" }),
    ]) {
      const harness = dependencies("BUY", { stdout });
      await assert.rejects(
        getBawQuote(request(), harness.dependencies),
        (error) => error instanceof BawCliError && error.code === "INVALID_OUTPUT",
      );
    }
  });
});

test("quote expiry and HMAC tampering are detected by the existing binding and freshness checks", () => {
  const originalSecret = process.env.BINANCE_SECRET_KEY;
  process.env.BINANCE_SECRET_KEY = SECRET;
  try {
    const bindingInput = {
      toToken: TOKEN,
      fromToken: BSC_USDT_ADDRESS,
      amount: "10",
      wallet: WALLET,
      quoteId: "local-quote-id",
      chainId: "56",
      direction: "BUY",
      slippageBps: 100,
    };
    const issuedAt = 10_000;
    const binding = createQuoteBinding(bindingInput, issuedAt);
    assert.equal(verifyQuoteBinding(binding, bindingInput, issuedAt + TRADE_QUOTE_TTL_MS - 1).ok, true);
    assert.deepEqual(
      verifyQuoteBinding(binding, bindingInput, issuedAt + TRADE_QUOTE_TTL_MS),
      { ok: false, reason: "Quote binding expired" },
    );
    const [payload, signature] = binding.split(".");
    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    assert.equal(verifyQuoteBinding(tampered, bindingInput, issuedAt + 1).ok, false);
    assert.equal(verifyQuoteBinding(binding, { ...bindingInput, wallet: TOKEN }, issuedAt + 1).ok, false);
    assert.equal(isFreshQuote({ quoteFetchedAt: issuedAt }, issuedAt + TRADE_QUOTE_TTL_MS), false);
    assert.equal(MINIMUM_ORDER_WEI, BigInt("5000000000000000000"));
  } finally {
    if (originalSecret === undefined) delete process.env.BINANCE_SECRET_KEY;
    else process.env.BINANCE_SECRET_KEY = originalSecret;
  }
});
