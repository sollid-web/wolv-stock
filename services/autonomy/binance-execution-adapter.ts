import { getValidatedBinanceRwaQuote } from "./binance-quote-provider";
import { buildValidatedBinanceRfqOrder } from "./binance-rfq-order-provider";
import { applySlippageFloor } from "./binance-roundtrip";
import type { ValidatedBinanceQuote } from "./binance-quote";
import type {
  AutonomousExecutionAdapter,
  NormalizedExecutionQuote,
  PreparedExecutionPayload,
  ProviderQuoteRequest,
} from "./provider-contracts";

const ID = "binance-web3-aggregator";
const CHAIN = "56";

function requiredEvidence(quote: NormalizedExecutionQuote, key: string): string {
  const value = quote.providerEvidence[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Binance normalized quote is missing provider evidence: " + key);
  }
  return value;
}

function integerEvidence(quote: NormalizedExecutionQuote, key: string): number {
  const value = quote.providerEvidence[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Binance normalized quote has invalid provider evidence: " + key);
  }
  return value;
}

function restoreQuote(quote: NormalizedExecutionQuote): ValidatedBinanceQuote {
  if (quote.provider !== ID || quote.chainId !== CHAIN) {
    throw new Error("Normalized quote is not a supported Binance BSC quote");
  }
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const positiveInteger = /^(0|[1-9][0-9]*)$/;
  if (!addressPattern.test(quote.walletAddress) ||
      !addressPattern.test(quote.inputTokenAddress) ||
      !addressPattern.test(quote.outputTokenAddress) ||
      quote.inputTokenAddress.toLowerCase() === quote.outputTokenAddress.toLowerCase()) {
    throw new Error("Binance normalized quote has invalid wallet or token addresses");
  }
  if (!positiveInteger.test(quote.amountIn) || BigInt(quote.amountIn) <= BigInt(0) ||
      !positiveInteger.test(quote.expectedAmountOut) || BigInt(quote.expectedAmountOut) <= BigInt(0)) {
    throw new Error("Binance normalized quote has invalid amounts");
  }
  if (!/^[a-fA-F0-9]{32}$/.test(requiredEvidence(quote, "quoteId")) ||
      requiredEvidence(quote, "executionMode") !== "RFQ" ||
      !/^[a-f0-9]{64}$/.test(quote.routeFingerprint) ||
      !/^[a-f0-9]{64}$/.test(quote.rawEvidenceRef)) {
    throw new Error("Binance normalized quote has invalid RFQ identity or evidence fingerprints");
  }
  const observedAt = Date.parse(quote.observedAt);
  const expiresAt = Date.parse(quote.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() || observedAt > Date.now() + 5_000) {
    throw new Error("Binance normalized quote timestamps are invalid or expired");
  }
  const approvalTarget = quote.providerEvidence.approvalTarget;
  if (approvalTarget !== null &&
      (typeof approvalTarget !== "string" || !addressPattern.test(approvalTarget))) {
    throw new Error("Binance quote approval target evidence is malformed");
  }
  if (quote.tokenMetadata.inputDecimals < 0 || quote.tokenMetadata.inputDecimals > 36 ||
      quote.tokenMetadata.outputDecimals < 0 || quote.tokenMetadata.outputDecimals > 36 ||
      !Number.isSafeInteger(quote.tokenMetadata.inputDecimals) ||
      !Number.isSafeInteger(quote.tokenMetadata.outputDecimals)) {
    throw new Error("Binance normalized quote has invalid token decimals");
  }
  const priceImpactBps = integerEvidence(quote, "priceImpactBps");
  const gasEstimateRaw = requiredEvidence(quote, "gasEstimateRaw");
  const estimatedNetworkFeeUsd = requiredEvidence(quote, "estimatedNetworkFeeUsd");
  const inputTokenTaxRate = requiredEvidence(quote, "inputTokenTaxRate");
  const outputTokenTaxRate = requiredEvidence(quote, "outputTokenTaxRate");
  const inputTokenUsdPrice = requiredEvidence(quote, "inputTokenUsdPrice");
  const outputTokenUsdPrice = requiredEvidence(quote, "outputTokenUsdPrice");
  const decimalPattern = /^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
  if (priceImpactBps > 100_000 || !positiveInteger.test(gasEstimateRaw) || BigInt(gasEstimateRaw) <= BigInt(0) ||
      !decimalPattern.test(estimatedNetworkFeeUsd) || !Number.isFinite(Number(estimatedNetworkFeeUsd)) || Number(estimatedNetworkFeeUsd) < 0 ||
      !decimalPattern.test(inputTokenTaxRate) || !Number.isFinite(Number(inputTokenTaxRate)) || Number(inputTokenTaxRate) < 0 || Number(inputTokenTaxRate) > 1 ||
      !decimalPattern.test(outputTokenTaxRate) || !Number.isFinite(Number(outputTokenTaxRate)) || Number(outputTokenTaxRate) < 0 || Number(outputTokenTaxRate) > 1 ||
      !decimalPattern.test(inputTokenUsdPrice) || !Number.isFinite(Number(inputTokenUsdPrice)) || Number(inputTokenUsdPrice) <= 0 ||
      !decimalPattern.test(outputTokenUsdPrice) || !Number.isFinite(Number(outputTokenUsdPrice)) || Number(outputTokenUsdPrice) <= 0) {
    throw new Error("Binance normalized quote has incomplete or unsafe fee, tax, price or impact evidence");
  }
  return {
    provider: ID,
    quoteId: requiredEvidence(quote, "quoteId"),
    vendorName: requiredEvidence(quote, "vendorName"),
    executionMode: "RFQ",
    chainId: quote.chainId,
    walletAddress: quote.walletAddress,
    inputTokenAddress: quote.inputTokenAddress,
    outputTokenAddress: quote.outputTokenAddress,
    amountIn: quote.amountIn,
    expectedAmountOut: quote.expectedAmountOut,
    priceImpactBps: integerEvidence(quote, "priceImpactBps"),
    gasEstimateRaw: requiredEvidence(quote, "gasEstimateRaw"),
    estimatedNetworkFeeUsd: requiredEvidence(quote, "estimatedNetworkFeeUsd"),
    inputTokenUsdPrice: requiredEvidence(quote, "inputTokenUsdPrice"),
    outputTokenUsdPrice: requiredEvidence(quote, "outputTokenUsdPrice"),
    approvalTarget: approvalTarget as string | null,
    inputTokenDecimals: integerEvidence(quote, "inputTokenDecimals"),
    outputTokenDecimals: integerEvidence(quote, "outputTokenDecimals"),
    inputTokenTaxRate: requiredEvidence(quote, "inputTokenTaxRate"),
    outputTokenTaxRate: requiredEvidence(quote, "outputTokenTaxRate"),
    route: requiredEvidence(quote, "route"),
    routeFingerprint: quote.routeFingerprint,
    observedAt: quote.observedAt,
    expiresAt: quote.expiresAt,
    rawEvidenceRef: quote.rawEvidenceRef,
  };
}

/**
 * Common-contract adapter for Binance's BSC RWA RFQ flow.
 * It only obtains quotes and prepares unsigned EIP-712 payloads. Signing,
 * approval transactions, order submission and settlement remain separate
 * capabilities and are intentionally not exposed by this adapter.
 */
export function createBinanceExecutionAdapter(dependencies: {
  getQuote: typeof getValidatedBinanceRwaQuote;
  buildOrder: typeof buildValidatedBinanceRfqOrder;
} = { getQuote: getValidatedBinanceRwaQuote, buildOrder: buildValidatedBinanceRfqOrder }): AutonomousExecutionAdapter {
  return {
  id: ID,
  supportedChainIds: [CHAIN],
  isConfigured: () =>
    !!process.env.BINANCE_API_KEY?.trim() &&
    !!process.env.BINANCE_SECRET_KEY?.trim(),

  async getQuote(input: ProviderQuoteRequest): Promise<NormalizedExecutionQuote> {
    if (input.chainId !== CHAIN) throw new Error("Binance RWA adapter supports BSC chain 56 only");
    const quote = await dependencies.getQuote(input);
    return {
      provider: ID,
      chainId: quote.chainId,
      walletAddress: quote.walletAddress,
      inputTokenAddress: quote.inputTokenAddress,
      outputTokenAddress: quote.outputTokenAddress,
      amountIn: quote.amountIn,
      expectedAmountOut: quote.expectedAmountOut,
      observedAt: quote.observedAt,
      expiresAt: quote.expiresAt,
      routeFingerprint: quote.routeFingerprint,
      rawEvidenceRef: quote.rawEvidenceRef,
      tokenMetadata: {
        inputDecimals: quote.inputTokenDecimals,
        outputDecimals: quote.outputTokenDecimals,
      },
      providerEvidence: {
        quoteId: quote.quoteId,
        vendorName: quote.vendorName,
        priceImpactBps: quote.priceImpactBps,
        gasEstimateRaw: quote.gasEstimateRaw,
        estimatedNetworkFeeUsd: quote.estimatedNetworkFeeUsd,
        inputTokenUsdPrice: quote.inputTokenUsdPrice,
        outputTokenUsdPrice: quote.outputTokenUsdPrice,
        approvalTarget: quote.approvalTarget,
        inputTokenTaxRate: quote.inputTokenTaxRate,
        outputTokenTaxRate: quote.outputTokenTaxRate,
        route: quote.route,
        inputTokenDecimals: quote.inputTokenDecimals,
        outputTokenDecimals: quote.outputTokenDecimals,
        executionMode: quote.executionMode,
      },
    };
  },

  async prepareExecution(input): Promise<PreparedExecutionPayload> {
    const quote = restoreQuote(input.quote);
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      throw new Error("Binance quote expired before unsigned RFQ preparation");
    }
    const order = await dependencies.buildOrder({
      quote,
      slippageBps: input.slippageBps,
      maxPriceImpactBps: input.maxPriceImpactBps,
    });
    return {
      kind: "EIP712_TYPED_DATA",
      provider: ID,
      chainId: order.chainId,
      walletAddress: order.walletAddress,
      inputTokenAddress: order.inputTokenAddress,
      outputTokenAddress: order.outputTokenAddress,
      amountIn: order.amountIn,
      minimumAmountOut: applySlippageFloor(quote.expectedAmountOut, input.slippageBps),
      typedDataHash: order.typedDataHash,
      typedDataFormat: order.typedDataFormat,
      typedDataToSign: order.typedDataToSign,
      providerOrderId: order.orderId,
      preparedAt: order.preparedAt,
      quoteExpiresAt: order.quoteExpiresAt,
    };
  },
  };
}

export const binanceExecutionAdapter = createBinanceExecutionAdapter();
