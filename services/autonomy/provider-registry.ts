import { getValidatedBinanceRoundTripQuote } from "./binance-roundtrip-provider";
import { getValidatedBinanceRwaQuote } from "./binance-quote-provider";
import { buildValidatedBinanceRfqOrder } from "./binance-rfq-order-provider";
import { binanceExecutionAdapter } from "./binance-execution-adapter";
import { createNormalizedProviderRegistry } from "./normalized-provider-registry";
import { createOneInchClassicAdapter } from "./oneinch-classic-adapter";
import type { ValidatedBinanceQuote } from "./binance-quote";
import type { ValidatedRoundTripQuote } from "./binance-roundtrip";
import type { ValidatedBinanceRfqOrder } from "./binance-rfq-order";

/**
 * Provider-neutral boundary used by autonomous workers.
 * Each adapter owns its quote normalization and execution-payload validation.
 * A provider is eligible only when it supports the requested chain and its
 * credentials/configuration are present. Failed providers may be skipped;
 * evidence from different providers is never mixed within one round trip.
 */
export type AutonomyExecutionAdapter = {
  id: string;
  supportedChainIds: readonly string[];
  isConfigured(): boolean;
  getQuote(input: {
    chainId: string; walletAddress: string; inputTokenAddress: string;
    outputTokenAddress: string; amountIn: string; slippageBps: number;
  }): Promise<ValidatedBinanceQuote>;
  getRoundTripQuote(input: {
    chainId: string; walletAddress: string; inputTokenAddress: string;
    outputTokenAddress: string; amountIn: string; slippageBps: number;
    networkFeeBufferBps: number;
  }): Promise<ValidatedRoundTripQuote>;
  buildOrder(input: {
    quote: ValidatedBinanceQuote; slippageBps: number; maxPriceImpactBps: number;
  }): Promise<ValidatedBinanceRfqOrder>;
};

export const binanceWeb3Adapter: AutonomyExecutionAdapter = {
  id: "binance-web3-aggregator",
  supportedChainIds: ["56"],
  isConfigured: () => !!process.env.BINANCE_API_KEY?.trim() && !!process.env.BINANCE_SECRET_KEY?.trim(),
  getQuote: getValidatedBinanceRwaQuote,
  getRoundTripQuote: getValidatedBinanceRoundTripQuote,
  buildOrder: buildValidatedBinanceRfqOrder,
};

export function createAutonomyProviderRegistry(
  adapters: readonly AutonomyExecutionAdapter[],
  preferredIds: readonly string[],
) {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  if (byId.size !== adapters.length) throw new Error("Autonomy provider IDs must be unique");
  const listAvailable = (chainId: string) => preferredIds
    .map((id) => byId.get(id))
    .filter((adapter): adapter is AutonomyExecutionAdapter =>
      !!adapter && adapter.supportedChainIds.includes(chainId) && adapter.isConfigured(),
    );

  const select = (chainId: string): AutonomyExecutionAdapter => {
    const adapter = listAvailable(chainId)[0];
    if (!adapter) throw new Error("No configured autonomy execution provider supports chain " + chainId);
    return adapter;
  };

  const getRoundTripQuote = async (input: Parameters<AutonomyExecutionAdapter["getRoundTripQuote"]>[0]) => {
    const candidates = listAvailable(input.chainId);
    if (!candidates.length) throw new Error("No configured autonomy execution provider supports chain " + input.chainId);
    const failures: string[] = [];
    for (const adapter of candidates) {
      try {
        const result = await adapter.getRoundTripQuote(input);
        if (result.provider !== adapter.id || result.buy.provider !== adapter.id || result.sell.provider !== adapter.id) {
          throw new Error("Provider returned quote evidence with a mismatched provider identity");
        }
        return { adapter, result };
      } catch (error) {
        failures.push(adapter.id + ": " + (error instanceof Error ? error.message : "quote failed"));
      }
    }
    throw new Error("All configured quote providers failed: " + failures.join("; ").slice(0, 500));
  };

  return { listAvailable, select, getRoundTripQuote };
}

const preferred = (process.env.WOLV_AUTONOMY_PROVIDER_ORDER ?? "binance-web3-aggregator")
  .split(",").map((value) => value.trim()).filter(Boolean);

export const autonomyProviderRegistry = createAutonomyProviderRegistry([binanceWeb3Adapter], preferred);


/**
 * Shared provider contract registry for execution preparation. The legacy
 * round-trip interface remains in place for the paper worker until its
 * strategy-specific evidence contract is migrated. Both registries select
 * the same Binance provider identity and credentials.
 */
const normalizedPreferred = (process.env.WOLV_AUTONOMY_NORMALIZED_PROVIDER_ORDER ?? "binance-web3-aggregator,1inch-classic")
  .split(",").map((value) => value.trim()).filter(Boolean);

export const normalizedAutonomyProviderRegistry = createNormalizedProviderRegistry(
  [binanceExecutionAdapter, createOneInchClassicAdapter()],
  normalizedPreferred,
);
