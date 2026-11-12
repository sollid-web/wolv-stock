import type {
  AutonomousExecutionAdapter,
  NormalizedExecutionQuote,
  ProviderQuoteRequest,
} from "./provider-contracts";

/**
 * Selects one provider for a quote. The returned adapter must also prepare
 * that quote; WOLV never combines quote evidence from different providers.
 * Provider fallback is allowed only before a quote is accepted.
 */
export function createNormalizedProviderRegistry(
  adapters: readonly AutonomousExecutionAdapter[],
  preferredIds: readonly string[],
) {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  if (byId.size !== adapters.length) throw new Error("Normalized provider IDs must be unique");

  const listAvailable = (chainId: string) => preferredIds
    .map((id) => byId.get(id))
    .filter((adapter): adapter is AutonomousExecutionAdapter =>
      !!adapter && adapter.supportedChainIds.includes(chainId) && adapter.isConfigured(),
    );

  const select = (chainId: string): AutonomousExecutionAdapter => {
    const adapter = listAvailable(chainId)[0];
    if (!adapter) throw new Error("No configured normalized execution provider supports chain " + chainId);
    return adapter;
  };

  const getQuote = async (input: ProviderQuoteRequest): Promise<{
    adapter: AutonomousExecutionAdapter;
    quote: NormalizedExecutionQuote;
  }> => {
    const candidates = listAvailable(input.chainId);
    if (!candidates.length) {
      throw new Error("No configured normalized execution provider supports chain " + input.chainId);
    }
    const failures: string[] = [];
    for (const adapter of candidates) {
      try {
        const quote = await adapter.getQuote(input);
        if (quote.provider !== adapter.id || quote.chainId !== input.chainId ||
            quote.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() ||
            quote.inputTokenAddress.toLowerCase() !== input.inputTokenAddress.toLowerCase() ||
            quote.outputTokenAddress.toLowerCase() !== input.outputTokenAddress.toLowerCase() ||
            quote.amountIn !== input.amountIn) {
          throw new Error("Provider quote does not match the requested wallet, chain, token direction or amount");
        }
        if (!Number.isFinite(Date.parse(quote.observedAt)) ||
            !Number.isFinite(Date.parse(quote.expiresAt)) ||
            Date.parse(quote.expiresAt) <= Date.now() ||
            Date.parse(quote.observedAt) > Date.now() + 5_000) {
          throw new Error("Provider quote has invalid or expired timestamps");
        }
        return { adapter, quote };
      } catch (error) {
        failures.push(adapter.id + ": " + (error instanceof Error ? error.message : "quote failed"));
      }
    }
    throw new Error("All normalized quote providers failed: " + failures.join("; ").slice(0, 500));
  };

  return { listAvailable, select, getQuote };
}
