export type ProviderQuoteRequest = {
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  slippageBps: number;
};

export type NormalizedExecutionQuote = {
  provider: string;
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  observedAt: string;
  expiresAt: string;
  routeFingerprint: string;
  rawEvidenceRef: string;
  tokenMetadata: {
    inputDecimals: number;
    outputDecimals: number;
  };
  providerEvidence: Record<string, string | number | boolean | null>;
};

export type PreparedEvmTransaction = {
  kind: "EVM_TRANSACTION";
  provider: string;
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  minimumAmountOut: string;
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  gasPrice: string;
  transactionFingerprint: string;
  preparedAt: string;
  quoteExpiresAt: string;
};

export type PreparedTypedDataOrder = {
  kind: "EIP712_TYPED_DATA";
  provider: string;
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  minimumAmountOut: string;
  typedDataHash: string;
  typedDataFormat: "HEX_EIP712_PAYLOAD" | "JSON_TYPED_DATA";
  typedDataToSign: string;
  providerOrderId: string;
  preparedAt: string;
  quoteExpiresAt: string;
};

export type PreparedExecutionPayload = PreparedEvmTransaction | PreparedTypedDataOrder;

/**
 * Vendor-neutral execution contract. Providers own response parsing and
 * payload construction; WOLV owns policy, signing authorization, simulation,
 * submission durability and independent chain settlement verification.
 */
export interface AutonomousExecutionAdapter {
  readonly id: string;
  readonly supportedChainIds: readonly string[];
  isConfigured(): boolean;
  getQuote(input: ProviderQuoteRequest): Promise<NormalizedExecutionQuote>;
  prepareExecution(input: {
    quote: NormalizedExecutionQuote;
    slippageBps: number;
    maxPriceImpactBps: number;
  }): Promise<PreparedExecutionPayload>;
}
