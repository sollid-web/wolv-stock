import { getValidatedBinanceRwaQuote } from "./binance-quote-provider";
import {
  applySlippageFloor, validateRoundTripQuotes,
  type ValidatedRoundTripQuote,
} from "./binance-roundtrip";

export async function getValidatedBinanceRoundTripQuote(input: {
  walletAddress: string;
  chainId: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  slippageBps: number;
  networkFeeBufferBps: number;
}): Promise<ValidatedRoundTripQuote> {
  const buy = await getValidatedBinanceRwaQuote({
    chainId: input.chainId,
    walletAddress: input.walletAddress,
    inputTokenAddress: input.inputTokenAddress,
    outputTokenAddress: input.outputTokenAddress,
    amountIn: input.amountIn,
    slippageBps: input.slippageBps,
  });
  if (Number(buy.outputTokenTaxRate) !== 0) {
    throw new Error("Buy-side RWA transfer tax is not supported by the round-trip evaluator");
  }
  const sell = await getValidatedBinanceRwaQuote({
    chainId: input.chainId,
    walletAddress: input.walletAddress,
    inputTokenAddress: buy.outputTokenAddress,
    outputTokenAddress: buy.inputTokenAddress,
    amountIn: applySlippageFloor(buy.expectedAmountOut, input.slippageBps),
    slippageBps: input.slippageBps,
  });
  return validateRoundTripQuotes(buy, sell, {
    networkFeeBufferBps: input.networkFeeBufferBps,
    slippageBps: input.slippageBps,
  });
}
