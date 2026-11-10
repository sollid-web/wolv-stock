import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceRwaExecutableQuote } from "../services/autonomy/binance-quote.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const input = "0x2222222222222222222222222222222222222222";
const output = "0x3333333333333333333333333333333333333333";
const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const request = {
  chainId: "56", walletAddress: wallet, inputTokenAddress: input,
  outputTokenAddress: output, amountIn: "1000000", slippageBps: 50, now,
};
const route = () => ({
  quoteId: "a1b2c3d4e5f64a8b9c0d1e2f3a4b5c6d",
  vendorName: "PcsXRfq",
  binanceChainId: "56",
  fromTokenAmount: "1000000",
  toTokenAmount: "998500000000000000",
  tradeFee: "0.12",
  estimateGasFee: "150000",
  priceImpactPercent: "-0.01",
  router: input + "--" + output,
  fromToken: {
    tokenContractAddress: input, tokenUnitPrice: "1", decimal: "6", isHoneyPot: false, taxRate: "0",
  },
  toToken: {
    tokenContractAddress: output, tokenUnitPrice: "100", decimal: "18", isHoneyPot: false, taxRate: "0",
  },
  executionMode: "RFQ",
  approveTarget: null,
  isBest: true,
});
const response = (r = route(), timestamp = now) => ({
  code: 0, success: true, timestamp, data: [r],
});

test("normalizes a documented Binance BSC RWA RFQ quote", () => {
  const quote = parseBinanceRwaExecutableQuote(response(), request);
  assert.equal(quote.executionMode, "RFQ");
  assert.equal(quote.chainId, "56");
  assert.equal(quote.walletAddress, wallet);
  assert.equal(quote.amountIn, "1000000");
  assert.equal(quote.expectedAmountOut, "998500000000000000");
  assert.equal(quote.priceImpactBps, 1);
  assert.equal(quote.gasEstimateNativeUnits, "150000");
  assert.equal(quote.tradeFeeUsd, "0.12");
  assert.equal(quote.inputTokenUsdPrice, "1");
  assert.equal(quote.outputTokenUsdPrice, "100");
  assert.equal(quote.approvalTarget, null);
  assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.observedAt), 20_000);
  assert.match(quote.rawEvidenceRef, /^[a-f0-9]{64}$/);
});

test("rejects a wrong chain, amount, input token, output token or execution mode", () => {
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), binanceChainId: "1" }), request), /chain/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), fromTokenAmount: "999" }), request), /amount/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), fromToken: { ...route().fromToken, tokenContractAddress: output } }), request), /input token/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), toToken: { ...route().toToken, tokenContractAddress: input } }), request), /output token/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), executionMode: "SWAP" }), request), /RFQ/);
});

test("fails closed when gas, fees, impact or token safety metadata is missing", () => {
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), estimateGasFee: null }), request), /estimateGasFee/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), tradeFee: null }), request), /tradeFee/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), priceImpactPercent: null }), request), /priceImpactPercent/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), toToken: { ...route().toToken, isHoneyPot: true } }), request), /honeypot/);
});

test("rejects malformed envelope, stale timestamp, invalid quote id and expired-looking route", () => {
  assert.throws(() => parseBinanceRwaExecutableQuote({ code: 1, success: false, data: [] }, request), /envelope/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response(route(), now - 11_000), request), /stale/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response({ ...route(), quoteId: "bad" }), request), /quoteId/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response(), { ...request, now: now + 21_000 }), /stale/);
});

test("rejects future-dated and invalid slippage requests", () => {
  assert.throws(() => parseBinanceRwaExecutableQuote(response(route(), now + 6_000), request), /future-dated/);
  assert.throws(() => parseBinanceRwaExecutableQuote(response(), { ...request, slippageBps: 5001 }), /slippage/);
});

test("rounds sub-basis-point price impact upward rather than understating risk", () => {
  const quote = parseBinanceRwaExecutableQuote(
    response({ ...route(), priceImpactPercent: "0.001" }), request,
  );
  assert.equal(quote.priceImpactBps, 1);
});
