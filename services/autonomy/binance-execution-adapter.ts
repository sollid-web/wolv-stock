import { getValidatedBinanceRwaQuote } from "./binance-quote-provider";
import { buildValidatedBinanceRfqOrder } from "./binance-rfq-order-provider";
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
  const approvalTarget = quote.providerEvidence.approvalTarget;
  if (approvalTarget !== null && typeof approvalTarget !== "string") {
    throw new Error("Binance quote approval target evidence is malformed");
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
export const binanceExecutionAdapter: AutonomousExecutionAdapter = {
  id: ID,
  supportedChainIds: [CHAIN],
  isConfigured: () =>
    !!process.env.BINANCE_API_KEY?.trim() &&
    !!process.env.BINANCE_SECRET_KEY?.trim(),

  async getQuote(input: ProviderQuoteRequest): Promise<NormalizedExecutionQuote> {
    if (input.chainId !== CHAIN) throw new Error("Binance RWA adapter supports BSC chain 56 only");
    const quote = await getValidatedBinanceRwaQuote(input);
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
    const order = await buildValidatedBinanceRfqOrder({
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
      minimumAmountOut: quote.expectedAmountOut,
      typedDataHash: order.typedDataHash,
      typedDataFormat: order.typedDataFormat,
      typedDataToSign: order.typedDataToSign,
      providerOrderId: order.orderId,
      preparedAt: order.preparedAt,
      quoteExpiresAt: order.quoteExpiresAt,
    };
  },
};
