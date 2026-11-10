import { getAutonomyAggregatorSwap } from "../../lib/binance";
import type { ValidatedBinanceQuote } from "./binance-quote";
import {
  parseBinanceRfqOrderBuild,
  type ValidatedBinanceRfqOrder,
} from "./binance-rfq-order";

export async function buildValidatedBinanceRfqOrder(input: {
  quote: ValidatedBinanceQuote;
  slippageBps: number;
  maxPriceImpactBps: number;
}): Promise<ValidatedBinanceRfqOrder> {
  const response = await getAutonomyAggregatorSwap({
    chainId: input.quote.chainId,
    fromTokenAddress: input.quote.inputTokenAddress,
    toTokenAddress: input.quote.outputTokenAddress,
    amount: input.quote.amountIn,
    userWalletAddress: input.quote.walletAddress,
    quoteId: input.quote.quoteId,
    slippageBps: input.slippageBps,
    priceImpactProtectionBps: input.maxPriceImpactBps,
  });
  return parseBinanceRfqOrderBuild(response, input.quote);
}
