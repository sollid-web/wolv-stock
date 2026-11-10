import { createHash } from "node:crypto";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(?:\\.([0-9]+))?$/;
const QUOTE_TTL_SAFETY_MS = 20_000;

export type BinanceQuoteRequest = {
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  slippageBps: number;
  now?: number;
};

export type ValidatedBinanceQuote = {
  provider: "binance-web3-aggregator";
  quoteId: string;
  vendorName: string;
  executionMode: "RFQ";
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  priceImpactBps: number;
  gasEstimateNativeUnits: string;
  tradeFeeUsd: string;
  inputTokenDecimals: number;
  outputTokenDecimals: number;
  inputTokenTaxRate: string;
  outputTokenTaxRate: string;
  route: string;
  routeFingerprint: string;
  observedAt: string;
  expiresAt: string;
  rawEvidenceRef: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Binance quote missing ${field}`);
  return value.trim();
}
function positiveInteger(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (!INTEGER.test(text) || BigInt(text) <= 0n) throw new Error(`Binance quote has invalid ${field}`);
  return text;
}
function decimal(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (!DECIMAL.test(text)) throw new Error(`Binance quote has invalid ${field}`);
  return text;
}
function tokenAddress(value: unknown, field: string): string {
  const address = nonEmpty(value, field);
  if (!EVM_ADDRESS.test(address)) throw new Error(`Binance quote has invalid ${field}`);
  return address.toLowerCase();
}
function decimalPercentToBps(value: unknown): number {
  const text = decimal(value, "priceImpactPercent");
  const unsigned = text.startsWith("-") ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = (fraction + "00").slice(0, 2);
  const bps = Number(whole) * 100 + Number(padded);
  if (!Number.isSafeInteger(bps) || bps > 100_000) throw new Error("Binance quote has invalid priceImpactPercent");
  return bps;
}
function tokenDecimals(token: Record<string, unknown>, field: string): number {
  const value = nonEmpty(token.decimal, field);
  if (!/^\\d{1,2}$/.test(value)) throw new Error(`Binance quote has invalid ${field}`);
  const parsed = Number(value);
  if (parsed > 36) throw new Error(`Binance quote has invalid ${field}`);
  return parsed;
}
function taxRate(token: Record<string, unknown>, field: string): string {
  const value = decimal(token.taxRate, field);
  if (Number(value) < 0 || Number(value) > 1) throw new Error(`Binance quote has invalid ${field}`);
  return value;
}
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Normalize the documented Binance GET /aggregator/quote envelope.
 * RWA routes are RFQ and quote IDs have an approximately 30-second TTL;
 * a 20-second local expiry is deliberately conservative.
 *
 * This parser does not infer missing gas, fees, price impact, or token metadata.
 */
export function parseBinanceRwaExecutableQuote(
  response: unknown,
  request: BinanceQuoteRequest,
): ValidatedBinanceQuote {
  if (!EVM_ADDRESS.test(request.walletAddress) ||
      !EVM_ADDRESS.test(request.inputTokenAddress) ||
      !EVM_ADDRESS.test(request.outputTokenAddress)) {
    throw new Error("Invalid quote request wallet or token address");
  }
  if (!/^\\d+$/.test(request.chainId) || request.chainId !== "56") {
    throw new Error("Unsupported quote request chain");
  }
  if (request.inputTokenAddress.toLowerCase() === request.outputTokenAddress.toLowerCase()) {
    throw new Error("Quote input and output tokens must differ");
  }
  if (!INTEGER.test(request.amountIn) || BigInt(request.amountIn) <= 0n) {
    throw new Error("Quote amount must be a positive base-unit integer");
  }
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 5000) {
    throw new Error("Quote slippage must be an integer from 0 to 5000 bps");
  }
  if (!record(response) || response.code !== 0 || response.success !== true || !Array.isArray(response.data)) {
    throw new Error("Binance aggregator quote returned an unsuccessful or malformed envelope");
  }
  const observedMs = typeof response.timestamp === "number" ? response.timestamp : NaN;
  const now = request.now ?? Date.now();
  if (!Number.isSafeInteger(observedMs) || observedMs <= 0 || observedMs > now + 5_000 || now - observedMs > 10_000) {
    throw new Error("Binance quote response timestamp is missing, future-dated, or stale");
  }
  const route = response.data.find((item: unknown) =>
    record(item) && item.isBest === true &&
    typeof item.toTokenAmount === "string" && INTEGER.test(item.toTokenAmount),
  ) ?? response.data[0];
  if (!record(route)) throw new Error("Binance quote contains no route");
  const quoteId = nonEmpty(route.quoteId, "quoteId");
  if (!/^[a-fA-F0-9]{32}$/.test(quoteId)) throw new Error("Binance quote has invalid quoteId");
  const vendorName = nonEmpty(route.vendorName, "vendorName");
  if (route.binanceChainId !== request.chainId) throw new Error("Binance quote chain does not match request");
  if (route.executionMode !== "RFQ") throw new Error("RWA quote did not return the documented RFQ execution mode");
  const amountIn = positiveInteger(route.fromTokenAmount, "fromTokenAmount");
  if (amountIn !== request.amountIn) throw new Error("Binance quote input amount does not match request");
  const expectedAmountOut = positiveInteger(route.toTokenAmount, "toTokenAmount");
  if (!record(route.fromToken) || !record(route.toToken)) throw new Error("Binance quote token metadata is missing");
  const inputTokenAddress = tokenAddress(route.fromToken.tokenContractAddress, "fromToken.tokenContractAddress");
  const outputTokenAddress = tokenAddress(route.toToken.tokenContractAddress, "toToken.tokenContractAddress");
  if (inputTokenAddress !== request.inputTokenAddress.toLowerCase()) throw new Error("Binance quote input token does not match request");
  if (outputTokenAddress !== request.outputTokenAddress.toLowerCase()) throw new Error("Binance quote output token does not match request");
  if (route.fromToken.isHoneyPot !== false || route.toToken.isHoneyPot !== false) {
    throw new Error("Binance quote token honeypot status is missing or unsafe");
  }
  const gasEstimateNativeUnits = positiveInteger(route.estimateGasFee, "estimateGasFee");
  const tradeFeeUsd = decimal(route.tradeFee, "tradeFee");
  const priceImpactBps = decimalPercentToBps(route.priceImpactPercent);
  const routeText = nonEmpty(route.router, "router");
  const inputTokenDecimals = tokenDecimals(route.fromToken, "fromToken.decimal");
  const outputTokenDecimals = tokenDecimals(route.toToken, "toToken.decimal");
  const inputTokenTaxRate = taxRate(route.fromToken, "fromToken.taxRate");
  const outputTokenTaxRate = taxRate(route.toToken, "toToken.taxRate");
  const observedAt = new Date(observedMs).toISOString();
  const expiresAt = new Date(observedMs + QUOTE_TTL_SAFETY_MS).toISOString();
  const fingerprint = sha256({
    quoteId, vendorName, chainId: request.chainId, inputTokenAddress, outputTokenAddress,
    amountIn, expectedAmountOut, routeText, executionMode: route.executionMode,
  });
  return {
    provider: "binance-web3-aggregator",
    quoteId, vendorName, executionMode: "RFQ",
    chainId: request.chainId,
    walletAddress: request.walletAddress.toLowerCase(),
    inputTokenAddress, outputTokenAddress,
    amountIn, expectedAmountOut, priceImpactBps,
    gasEstimateNativeUnits, tradeFeeUsd,
    inputTokenDecimals, outputTokenDecimals,
    inputTokenTaxRate, outputTokenTaxRate,
    route: routeText,
    routeFingerprint: fingerprint,
    observedAt, expiresAt,
    rawEvidenceRef: sha256(route),
  };
}
