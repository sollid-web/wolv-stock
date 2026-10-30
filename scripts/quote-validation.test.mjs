import assert from "node:assert/strict";
import test from "node:test";
import { isQuoteReferenceReliable, validateQuote } from "../lib/quoteValidation.ts";

const amount = "100000000000000000000";

test("accepts a finite route whose input amount matches the request", () => {
  const result = validateQuote({
    fromTokenAmount: amount,
    toTokenAmount: "2000000000000000000",
    tokenUnitPrice: 1,
    expectedFromTokenAmount: amount,
  });
  assert.deepEqual(result, { ok: true, usd: 50, referenceGap: null });
});

test("rejects malformed or mismatched route amounts", () => {
  assert.equal(validateQuote({ fromTokenAmount: amount, toTokenAmount: "not-an-integer", tokenUnitPrice: 1 }).ok, false);
  assert.equal(validateQuote({ fromTokenAmount: "200000000000000000000", toTokenAmount: "2000000000000000000", tokenUnitPrice: 1, expectedFromTokenAmount: amount }).ok, false);
  assert.equal(validateQuote({ fromTokenAmount: amount, toTokenAmount: "2000000000000000000", tokenUnitPrice: 1, expectedFromTokenAmount: `0x${BigInt(amount).toString(16)}` }).ok, true);
  assert.equal(validateQuote({ fromTokenAmount: amount, toTokenAmount: "2000000000000000000", tokenUnitPrice: 1, expectedFromTokenAmount: "0x2" }).ok, false);
  assert.equal(validateQuote({ fromTokenAmount: amount, toTokenAmount: "2000000000000000000", tokenUnitPrice: 1, expectedFromTokenAmount: "not-an-integer" }).ok, false);
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
