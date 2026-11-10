import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceRfqOrderBuild } from "../services/autonomy/binance-rfq-order.ts";

const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const wallet = "0x1111111111111111111111111111111111111111";
const input = "0x2222222222222222222222222222222222222222";
const output = "0x3333333333333333333333333333333333333333";
const quote = {
  provider: "binance-web3-aggregator",
  quoteId: "a1b2c3d4e5f64a8b9c0d1e2f3a4b5c6d",
  vendorName: "PcsXRfq",
  executionMode: "RFQ",
  chainId: "56",
  walletAddress: wallet,
  inputTokenAddress: input,
  outputTokenAddress: output,
  amountIn: "1000000",
  expectedAmountOut: "998500000000000000",
  priceImpactBps: 1,
  gasEstimateRaw: "150000",
  tradeFeeUsd: "0.12",
  inputTokenUsdPrice: "1",
  outputTokenUsdPrice: "100",
  approvalTarget: null,
  inputTokenDecimals: 6,
  outputTokenDecimals: 18,
  inputTokenTaxRate: "0",
  outputTokenTaxRate: "0",
  route: input + "--" + output,
  routeFingerprint: "route-fingerprint",
  observedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 20_000).toISOString(),
  rawEvidenceRef: "quote-evidence-hash",
};
const buildData = () => ({
  executionMode: "RFQ",
  routerResult: {
    binanceChainId: "56",
    vendorName: "PcsXRfq",
    fromTokenAmount: quote.amountIn,
    toTokenAmount: quote.expectedAmountOut,
    fromToken: { tokenContractAddress: input },
    toToken: { tokenContractAddress: output },
  },
  rfq: {
    vendor: "PcsXRfq",
    orderId: "rfq-order-123",
    txType: "EIP712",
    signingScheme: "EIP712",
    typedDataToSign: "0x1901abcdef0123456789",
    signatureData: [],
  },
});
const response = (data = buildData(), timestamp = now) => ({
  code: 0, success: true, timestamp, data,
});

test("validates unsigned RFQ order against the exact quoted route", () => {
  const result = parseBinanceRfqOrderBuild(response(), quote, now);
  assert.equal(result.orderId, "rfq-order-123");
  assert.equal(result.vendor, "PcsXRfq");
  assert.equal(result.signingScheme, "EIP712");
  assert.equal(result.amountIn, quote.amountIn);
  assert.equal(result.expectedAmountOut, quote.expectedAmountOut);
  assert.equal(result.walletAddress, wallet);
  assert.equal(result.approvalRequired, false);
  assert.match(result.typedDataHash, /^[a-f0-9]{64}$/);
  assert.equal(result.typedDataToSign, "0x1901abcdef0123456789");
  assert.equal(result.typedDataFormat, "HEX_EIP712_PAYLOAD");
  assert.equal(result.quoteExpiresAt, quote.expiresAt);
});

test("rejects a different chain, vendor, amount, token direction or execution mode", () => {
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), routerResult: { ...buildData().routerResult, binanceChainId: "1" },
  }), quote, now), /chain/);
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), routerResult: { ...buildData().routerResult, vendorName: "CowSwap" },
  }), quote, now), /vendor/);
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), routerResult: { ...buildData().routerResult, fromTokenAmount: "999" },
  }), quote, now), /input amount/);
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), routerResult: { ...buildData().routerResult, toToken: { tokenContractAddress: input } },
  }), quote, now), /token direction/);
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), executionMode: "SWAP",
  }), quote, now), /RFQ/);
});

test("rejects invalid typed data, vendor signing mismatch and missing EIP712 metadata", () => {
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), rfq: { ...buildData().rfq, typedDataToSign: "not-hex" },
  }), quote, now), /hex payload/);
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), rfq: { ...buildData().rfq, vendor: "CowSwap" },
  }), quote, now), /signing vendor/);
  assert.throws(() => parseBinanceRfqOrderBuild(response({
    ...buildData(), rfq: { ...buildData().rfq, signingScheme: "personal_sign" },
  }), quote, now), /EIP712/);
});

test("flags approval payloads and rejects expired or stale RFQ builds", () => {
  const withApproval = buildData();
  withApproval.routerResult.approveTarget = "0x4444444444444444444444444444444444444444";
  assert.equal(parseBinanceRfqOrderBuild(response(withApproval), quote, now).approvalRequired, true);
  assert.equal(parseBinanceRfqOrderBuild(response(withApproval), quote, now).approvalTarget, "0x4444444444444444444444444444444444444444");
  assert.throws(() => parseBinanceRfqOrderBuild(response(), {
    ...quote, expiresAt: new Date(now - 1).toISOString(),
  }, now), /expired/);
  assert.throws(() => parseBinanceRfqOrderBuild(response(buildData(), now - 11_000), quote, now), /stale/);
});

test("accepts documented JSON-encoded EIP712 typed data", () => {
  const data = buildData();
  data.rfq.typedDataToSign = JSON.stringify({
    domain: { name: "WOLV RFQ", chainId: 56 },
    types: { Order: [{ name: "amount", type: "uint256" }] },
    primaryType: "Order",
    message: { amount: "1000000" },
  });
  const result = parseBinanceRfqOrderBuild(response(data), quote, now);
  assert.equal(result.typedDataFormat, "JSON_TYPED_DATA");
  assert.equal(result.typedDataToSign, data.rfq.typedDataToSign);
});

test("rejects malformed JSON typed data objects", () => {
  const data = buildData();
  data.rfq.typedDataToSign = JSON.stringify({ types: {}, message: {} });
  assert.throws(() => parseBinanceRfqOrderBuild(response(data), quote, now), /missing domain/);
});
