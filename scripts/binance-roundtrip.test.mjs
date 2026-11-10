import test from "node:test";
import assert from "node:assert/strict";
import { validateRoundTripQuotes } from "../services/autonomy/binance-roundtrip.ts";

const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const wallet = "0x1111111111111111111111111111111111111111";
const stable = "0x2222222222222222222222222222222222222222";
const rwa = "0x3333333333333333333333333333333333333333";
const buy = {
  provider: "binance-web3-aggregator",
  quoteId: "a1b2c3d4e5f64a8b9c0d1e2f3a4b5c6d",
  vendorName: "PcsXRfq",
  executionMode: "RFQ",
  chainId: "56",
  walletAddress: wallet,
  inputTokenAddress: stable,
  outputTokenAddress: rwa,
  amountIn: "100000000",
  expectedAmountOut: "998500000000000000",
  priceImpactBps: 1,
  gasEstimateRaw: "150000",
  estimatedNetworkFeeUsd: "0.12",
  inputTokenUsdPrice: "1",
  outputTokenUsdPrice: "100",
  approvalTarget: null,
  inputTokenDecimals: 6,
  outputTokenDecimals: 18,
  inputTokenTaxRate: "0",
  outputTokenTaxRate: "0",
  route: stable + "--" + rwa,
  routeFingerprint: "buy-route",
  observedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 20_000).toISOString(),
  rawEvidenceRef: "buy-evidence",
};
const sell = {
  ...buy,
  quoteId: "b1b2c3d4e5f64a8b9c0d1e2f3a4b5c6d",
  inputTokenAddress: rwa,
  outputTokenAddress: stable,
  amountIn: buy.expectedAmountOut,
  expectedAmountOut: "101000000",
  inputTokenUsdPrice: "100",
  outputTokenUsdPrice: "1",
  inputTokenDecimals: 18,
  outputTokenDecimals: 6,
  route: rwa + "--" + stable,
  routeFingerprint: "sell-route",
  rawEvidenceRef: "sell-evidence",
};

test("requires both buy and executable reverse RFQ quotes and calculates buffered net edge", () => {
  const result = validateRoundTripQuotes(buy, sell, { now, networkFeeBufferBps: 10_000 });
  assert.equal(result.indicativeRoundTripEdgeBps, 52);
  assert.equal(result.bufferedNetworkFeesUsd, "0.48");
  assert.equal(result.approvalRequired, false);
  assert.equal(result.buy.quoteId, buy.quoteId);
  assert.equal(result.sell.quoteId, sell.quoteId);
  assert.equal(result.expiresAt, buy.expiresAt);
  assert.match(result.routeFingerprint, /^[a-f0-9]{64}$/);
});

test("rejects non-reversed token routes, wrong amount and inconsistent decimals", () => {
  assert.throws(() => validateRoundTripQuotes(buy, { ...sell, outputTokenAddress: rwa }, { now, networkFeeBufferBps: 0 }), /reverse/);
  assert.throws(() => validateRoundTripQuotes(buy, { ...sell, amountIn: "1" }, { now, networkFeeBufferBps: 0 }), /exactly match/);
  assert.throws(() => validateRoundTripQuotes(buy, { ...sell, outputTokenDecimals: 18 }, { now, networkFeeBufferBps: 0 }), /decimal/);
});

test("rejects non-zero intermediate RWA transfer taxes and expired quotes", () => {
  assert.throws(() => validateRoundTripQuotes(
    { ...buy, outputTokenTaxRate: "0.01" }, sell, { now, networkFeeBufferBps: 0 },
  ), /transfer tax/);
  assert.throws(() => validateRoundTripQuotes(
    buy, { ...sell, expiresAt: new Date(now - 1).toISOString() }, { now, networkFeeBufferBps: 0 },
  ), /expired/);
});

test("flags approval requirements on either leg", () => {
  const result = validateRoundTripQuotes(
    buy, { ...sell, approvalTarget: "0x4444444444444444444444444444444444444444" },
    { now, networkFeeBufferBps: 0 },
  );
  assert.equal(result.approvalRequired, true);
});
