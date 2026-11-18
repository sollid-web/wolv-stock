import assert from "node:assert/strict";
import test from "node:test";
import { classifyQuoteError, quoteWithSizeFallback } from "../lib/quoteFallback.ts";

const noLiquidity = { ok: false, err: "API error 40374: Insufficient liquidity for a quote.", ts: 1 };
const ok = (usd) => ({ ok: true, usd, mode: "SWAP", vendor: "test", impact: 0, ts: 1 });

test("classifies Binance quote errors", () => {
  assert.equal(classifyQuoteError(noLiquidity.err), "no_liquidity");
  assert.equal(classifyQuoteError("API error 42900: Rate limit exceeded"), "rate_limited");
  assert.equal(classifyQuoteError("no valid market route"), "unavailable");
});

test("returns the first size that has liquidity and records that size", async () => {
  const sizes = [];
  const quote = await quoteWithSizeFallback(async (size) => { sizes.push(size); return size === 10 ? ok(52.1) : noLiquidity; });
  assert.deepEqual(sizes, [100, 25, 10]);
  assert.equal(quote.ok, true);
  assert.equal(quote.sizeUsdt, 10);
});

test("does not retry smaller sizes for non-liquidity errors", async () => {
  const sizes = [];
  const quote = await quoteWithSizeFallback(async (size) => { sizes.push(size); return { ok: false, err: "API error 42900: Rate limit exceeded", ts: 1 }; });
  assert.deepEqual(sizes, [100]);
  assert.equal(quote.ok, false);
  assert.equal(quote.reason, "rate_limited");
});

test("reports no_liquidity when every size fails for liquidity", async () => {
  const quote = await quoteWithSizeFallback(async () => noLiquidity);
  assert.equal(quote.ok, false);
  assert.equal(quote.reason, "no_liquidity");
});
