import assert from "node:assert/strict";
import test from "node:test";
import { isQuoteReferenceReliable, validateQuote } from "../lib/quoteValidation.ts";

const amount = "100000000000000000000";

test("accepts a finite route whose input amount matches the request", () => {
  const result = validateQuote({
    fromTokenAmount: amount,
    toTokenAmount: "2000000000000000000",
    fromTokenDecimals: "18",
    toTokenDecimals: "18",
    tokenUnitPrice: 1,
    expectedFromTokenAmount: amount,
  });
  assert.deepEqual(result, { ok: true, usd: 50, referenceGap: null });
});

test("normalizes provider amounts using 6, 8, and 18 decimal token metadata", () => {
  for (const [decimals, outputAmount] of [
    ["6", "2000000"],
    ["8", "200000000"],
    ["18", "2000000000000000000"],
  ]) {
    const result = validateQuote({
      fromTokenAmount: amount,
      toTokenAmount: outputAmount,
      fromTokenDecimals: "18",
      toTokenDecimals: decimals,
      tokenUnitPrice: 1,
      expectedFromTokenAmount: amount,
    });
    assert.deepEqual(result, { ok: true, usd: 50, referenceGap: null });
  }
});

test("rejects malformed or mismatched route amounts", () => {
  const route = {
    fromTokenAmount: amount,
    toTokenAmount: "2000000000000000000",
    fromTokenDecimals: "18",
    toTokenDecimals: "18",
    tokenUnitPrice: 1,
  };
  assert.equal(validateQuote({ ...route, toTokenAmount: "not-an-integer" }).ok, false);
  assert.equal(validateQuote({ ...route, fromTokenAmount: "200000000000000000000", expectedFromTokenAmount: amount }).ok, false);
  assert.equal(validateQuote({ ...route, expectedFromTokenAmount: `0x${BigInt(amount).toString(16)}` }).ok, true);
  assert.equal(validateQuote({ ...route, expectedFromTokenAmount: "0x2" }).ok, false);
  assert.equal(validateQuote({ ...route, expectedFromTokenAmount: "not-an-integer" }).ok, false);
  assert.equal(validateQuote({ ...route, toTokenDecimals: undefined }).ok, false);
  assert.equal(validateQuote({ ...route, toTokenDecimals: "6.0" }).ok, false);
  assert.equal(validateQuote({ ...route, toTokenDecimals: "256" }).ok, false);
  assert.equal(validateQuote({ usd: Infinity }).ok, false);
});

test("rejects isolated reference-price outliers", () => {
  assert.equal(isQuoteReferenceReliable(100, 100, 1), true);
  assert.equal(isQuoteReferenceReliable(121, 100, 1), false);
  assert.equal(isQuoteReferenceReliable(10_000, 100, 1), false);
});

test("does not let a non-selectable positive quote win route selection", async () => {
  const { selectBestRouterQuote } = await import("../lib/routerQuoteSelection.ts");
  assert.equal(selectBestRouterQuote([
    { effectiveUsd: 1, selectable: false },
    { effectiveUsd: 2, selectable: false },
  ]), undefined);
  assert.deepEqual(selectBestRouterQuote([
    { effectiveUsd: 1, selectable: false },
    { effectiveUsd: 2, selectable: true },
  ]), { effectiveUsd: 2, selectable: true });
});
