import { createHash } from "node:crypto";
import type { ValidatedBinanceQuote } from "./binance-quote";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Binance RFQ build missing ${field}`);
  return value.trim();
}
function address(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^0x[a-fA-F0-9]{40}$/.test(result)) throw new Error(`Binance RFQ build has invalid ${field}`);
  return result.toLowerCase();
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type ValidatedBinanceRfqOrder = {
  provider: "binance-web3-aggregator";
  quoteId: string;
  orderId: string;
  vendor: string;
  signingScheme: "EIP712";
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  typedDataHash: string;
  typedDataToSign: string;
  routeFingerprint: string;
  rawEvidenceRef: string;
  approvalRequired: boolean;
  preparedAt: string;
  quoteExpiresAt: string;
};

/**
 * Validate the unsigned /swap RFQ payload against the exact quote that WOLV
 * requested. The typed data is hashed, never signed or submitted here.
 */
export function parseBinanceRfqOrderBuild(
  response: unknown,
  quote: ValidatedBinanceQuote,
  now = Date.now(),
): ValidatedBinanceRfqOrder {
  if (Date.parse(quote.expiresAt) <= now) throw new Error("Binance quote expired before RFQ build");
  if (!record(response) || response.code !== 0 || response.success !== true || !record(response.data)) {
    throw new Error("Binance RFQ build returned an unsuccessful or malformed envelope");
  }
  const timestamp = typeof response.timestamp === "number" ? response.timestamp : NaN;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now + 5_000 || now - timestamp > 10_000) {
    throw new Error("Binance RFQ build timestamp is missing, future-dated, or stale");
  }
  const data = response.data;
  if (data.executionMode !== "RFQ" || !record(data.routerResult) || !record(data.rfq)) {
    throw new Error("Binance swap response is not a complete RFQ order build");
  }
  const route = data.routerResult;
  const rfq = data.rfq;
  if (route.binanceChainId !== quote.chainId) throw new Error("RFQ build chain does not match quote");
  if (text(route.vendorName, "routerResult.vendorName") !== quote.vendorName) {
    throw new Error("RFQ build vendor does not match quote");
  }
  if (text(route.fromTokenAmount, "routerResult.fromTokenAmount") !== quote.amountIn) {
    throw new Error("RFQ build input amount does not match quote");
  }
  if (text(route.toTokenAmount, "routerResult.toTokenAmount") !== quote.expectedAmountOut) {
    throw new Error("RFQ build output amount does not match quote");
  }
  if (!record(route.fromToken) || !record(route.toToken)) throw new Error("RFQ build token metadata is missing");
  const inputTokenAddress = address(route.fromToken.tokenContractAddress, "routerResult.fromToken");
  const outputTokenAddress = address(route.toToken.tokenContractAddress, "routerResult.toToken");
  if (inputTokenAddress !== quote.inputTokenAddress || outputTokenAddress !== quote.outputTokenAddress) {
    throw new Error("RFQ build token direction does not match quote");
  }
  const vendor = text(rfq.vendor, "rfq.vendor");
  if (vendor !== quote.vendorName) throw new Error("RFQ signing vendor does not match quoted route");
  if (rfq.txType !== "EIP712" || rfq.signingScheme !== "EIP712") {
    throw new Error("RFQ build did not return the documented EIP712 signing scheme");
  }
  const orderId = text(rfq.orderId, "rfq.orderId");
  const typedDataToSign = text(rfq.typedDataToSign, "rfq.typedDataToSign");
  if (!/^0x[0-9a-fA-F]+$/.test(typedDataToSign) || typedDataToSign.length < 10) {
    throw new Error("RFQ build typedDataToSign is not a valid hex payload");
  }
  const signatureData = rfq.signatureData;
  const approvalRequired = Array.isArray(signatureData) && signatureData.length > 0;
  return {
    provider: "binance-web3-aggregator",
    quoteId: quote.quoteId,
    orderId,
    vendor,
    signingScheme: "EIP712",
    chainId: quote.chainId,
    walletAddress: quote.walletAddress,
    inputTokenAddress,
    outputTokenAddress,
    amountIn: quote.amountIn,
    expectedAmountOut: quote.expectedAmountOut,
    typedDataHash: hash(typedDataToSign),
    typedDataToSign,
    routeFingerprint: quote.routeFingerprint,
    rawEvidenceRef: hash({ routerResult: route, rfq: { ...rfq, typedDataToSign: "[REDACTED]" } }),
    approvalRequired,
    preparedAt: new Date(timestamp).toISOString(),
    quoteExpiresAt: quote.expiresAt,
  };
}
