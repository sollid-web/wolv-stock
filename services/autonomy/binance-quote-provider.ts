import { getAutonomyAggregatorQuote } from "../../lib/binance";
import {
  parseBinanceRwaExecutableQuote,
  type ValidatedBinanceQuote,
} from "./binance-quote";

export async function getValidatedBinanceRwaQuote(input: {
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  slippageBps: number;
}): Promise<ValidatedBinanceQuote> {
  const response = await getAutonomyAggregatorQuote({
    chainId: input.chainId,
    fromTokenAddress: input.inputTokenAddress,
    toTokenAddress: input.outputTokenAddress,
    amount: input.amountIn,
    userWalletAddress: input.walletAddress,
  });
  return parseBinanceRwaExecutableQuote(response, {
    ...input,
  });
}
