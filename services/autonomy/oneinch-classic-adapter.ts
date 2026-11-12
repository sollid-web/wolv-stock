import type {
  AutonomousExecutionAdapter, NormalizedExecutionQuote, PreparedExecutionPayload,
} from "./provider-contracts";
import {
  createOneInchClassicClient,
  type OneInchClassicQuote,
} from "./oneinch-classic";

export function createOneInchClassicAdapter(
  client = createOneInchClassicClient({}),
): AutonomousExecutionAdapter {
  return {
    id: "1inch-classic",
    supportedChainIds: ["56"],
    isConfigured: () => !!process.env.ONEINCH_API_KEY?.trim(),
    async getQuote(input): Promise<NormalizedExecutionQuote> {
      const quote = await client.getQuote(input);
      return {
        provider: quote.provider,
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
          inputDecimals: quote.sourceTokenDecimals,
          outputDecimals: quote.destinationTokenDecimals,
        },
        providerEvidence: { gasEstimate: quote.gasEstimate },
      };
    },
    async prepareExecution(input): Promise<PreparedExecutionPayload> {
      if (input.quote.provider !== "1inch-classic" || input.quote.chainId !== "56") {
        throw new Error("1inch adapter received quote evidence from another provider or chain");
      }
      if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 5000) {
        throw new Error("Invalid 1inch slippage policy");
      }
      const gasEstimate = input.quote.providerEvidence.gasEstimate;
      if (typeof gasEstimate !== "string") throw new Error("1inch quote is missing gas estimate evidence");
      const quote: OneInchClassicQuote = {
        provider: "1inch-classic",
        chainId: "56",
        walletAddress: input.quote.walletAddress,
        inputTokenAddress: input.quote.inputTokenAddress,
        outputTokenAddress: input.quote.outputTokenAddress,
        amountIn: input.quote.amountIn,
        expectedAmountOut: input.quote.expectedAmountOut,
        gasEstimate,
        observedAt: input.quote.observedAt,
        expiresAt: input.quote.expiresAt,
        routeFingerprint: input.quote.routeFingerprint,
        rawEvidenceRef: input.quote.rawEvidenceRef,
        sourceTokenDecimals: input.quote.tokenMetadata.inputDecimals,
        destinationTokenDecimals: input.quote.tokenMetadata.outputDecimals,
      };
      const tx = await client.buildTransaction(quote, input.slippageBps);
      const minimumAmountOut = (
        BigInt(tx.expectedAmountOut) * BigInt(10_000 - input.slippageBps) / BigInt(10_000)
      ).toString();
      return {
        kind: "EVM_TRANSACTION",
        provider: tx.provider,
        chainId: tx.chainId,
        walletAddress: tx.walletAddress,
        inputTokenAddress: tx.inputTokenAddress,
        outputTokenAddress: tx.outputTokenAddress,
        amountIn: tx.amountIn,
        minimumAmountOut,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gas,
        gasPrice: tx.gasPrice,
        transactionFingerprint: tx.transactionFingerprint,
        preparedAt: tx.preparedAt,
        quoteExpiresAt: tx.quoteExpiresAt,
      };
    },
  };
}
