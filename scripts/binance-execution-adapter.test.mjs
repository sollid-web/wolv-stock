import test from "node:test";
import assert from "node:assert/strict";
import { createBinanceExecutionAdapter } from "../services/autonomy/binance-execution-adapter.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const inputToken = "0x2222222222222222222222222222222222222222";
const outputToken = "0x3333333333333333333333333333333333333333";
const quote = {
  provider: "binance-web3-aggregator", quoteId: "a".repeat(32), vendorName: "RFQ Vendor",
  executionMode: "RFQ", chainId: "56", walletAddress: wallet,
  inputTokenAddress: inputToken, outputTokenAddress: outputToken,
  amountIn: "1000", expectedAmountOut: "10000", priceImpactBps: 20,
  gasEstimateRaw: "21000", estimatedNetworkFeeUsd: "0.01",
  inputTokenUsdPrice: "1", outputTokenUsdPrice: "1",
  approvalTarget: null, inputTokenDecimals: 6, outputTokenDecimals: 18,
  inputTokenTaxRate: "0", outputTokenTaxRate: "0", route: "rfq-route",
  routeFingerprint: "a".repeat(64), observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 15_000).toISOString(), rawEvidenceRef: "b".repeat(64),
};
const typedData = JSON.stringify({
  domain: { name: "Test", version: "1", chainId: 56, verifyingContract: inputToken },
  types: { Order: [{ name: "amount", type: "uint256" }] },
  primaryType: "Order", message: { amount: "1000" },
});

test("Binance adapter maps validated RFQ quote into normalized evidence without losing fee/tax fields", async () => {
  const adapter = createBinanceExecutionAdapter({
    getQuote: async () => quote,
    buildOrder: async () => { throw new Error("not expected"); },
  });
  const normalized = await adapter.getQuote({
    chainId: "56", walletAddress: wallet, inputTokenAddress: inputToken,
    outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  assert.equal(normalized.provider, "binance-web3-aggregator");
  assert.equal(normalized.providerEvidence.estimatedNetworkFeeUsd, "0.01");
  assert.equal(normalized.providerEvidence.inputTokenTaxRate, "0");
  assert.equal(normalized.tokenMetadata.outputDecimals, 18);
});

test("Binance adapter restores only its own quote and prepares unsigned typed data with slippage floor", async () => {
  let prepared;
  const adapter = createBinanceExecutionAdapter({
    getQuote: async () => quote,
    buildOrder: async (input) => {
      prepared = input;
      return {
        provider: "binance-web3-aggregator", quoteId: quote.quoteId, orderId: "rfq-order-1",
        vendor: "RFQ Vendor", signingScheme: "EIP712", chainId: "56",
        walletAddress: wallet, inputTokenAddress: inputToken, outputTokenAddress: outputToken,
        amountIn: "1000", expectedAmountOut: "10000",
        typedDataHash: "typed-hash", typedDataToSign: typedData,
        typedDataFormat: "JSON_TYPED_DATA", approvalTarget: null,
        routeFingerprint: "a".repeat(64), rawEvidenceRef: "b".repeat(64),
        approvalRequired: false, preparedAt: new Date().toISOString(),
        quoteExpiresAt: quote.expiresAt,
      };
    },
  });
  const normalized = await adapter.getQuote({
    chainId: "56", walletAddress: wallet, inputTokenAddress: inputToken,
    outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  const result = await adapter.prepareExecution({
    quote: normalized, slippageBps: 50, maxPriceImpactBps: 100,
  });
  assert.equal(prepared.quote.quoteId, quote.quoteId);
  assert.equal(result.kind, "EIP712_TYPED_DATA");
  assert.equal(result.minimumAmountOut, "9950");
  assert.equal(result.providerOrderId, "rfq-order-1");
  assert.equal(result.typedDataToSign, typedData);
});

test("Binance adapter rejects expired or cross-provider normalized quote evidence", async () => {
  const adapter = createBinanceExecutionAdapter({
    getQuote: async () => quote,
    buildOrder: async () => { throw new Error("must not build"); },
  });
  const normalized = await adapter.getQuote({
    chainId: "56", walletAddress: wallet, inputTokenAddress: inputToken,
    outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  await assert.rejects(adapter.prepareExecution({
    quote: { ...normalized, provider: "1inch-classic" },
    slippageBps: 50, maxPriceImpactBps: 100,
  }), /not a supported Binance/);
  await assert.rejects(adapter.prepareExecution({
    quote: { ...normalized, expiresAt: new Date(Date.now() - 1).toISOString() },
    slippageBps: 50, maxPriceImpactBps: 100,
  }), /expired/);
});


test("Binance adapter rejects forged normalized fee, tax and token metadata before provider build", async () => {
  const adapter = createBinanceExecutionAdapter({
    getQuote: async () => quote,
    buildOrder: async () => { throw new Error("must not build"); },
  });
  const normalized = await adapter.getQuote({
    chainId: "56", walletAddress: wallet, inputTokenAddress: inputToken,
    outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
  });
  await assert.rejects(adapter.prepareExecution({
    quote: { ...normalized, providerEvidence: { ...normalized.providerEvidence, outputTokenTaxRate: "2" } },
    slippageBps: 50, maxPriceImpactBps: 100,
  }), /unsafe fee, tax, price or impact evidence/);
  await assert.rejects(adapter.prepareExecution({
    quote: { ...normalized, tokenMetadata: { inputDecimals: 6, outputDecimals: 99 } },
    slippageBps: 50, maxPriceImpactBps: 100,
  }), /invalid token decimals/);
});
