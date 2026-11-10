import { createHash } from "node:crypto";
import type { ValidatedBinanceQuote } from "./binance-quote";
import { calculateNetEdge } from "./reference-edge";
import { applyNetworkFeeBuffer, sumUsdAmounts } from "./network-fee";

export type ValidatedRoundTripQuote = {
  provider: "binance-web3-aggregator";
  buy: ValidatedBinanceQuote;
  sell: ValidatedBinanceQuote;
  indicativeRoundTripEdgeBps: number;
  bufferedNetworkFeesUsd: string;
  approvalRequired: boolean;
  expiresAt: string;
  routeFingerprint: string;
  rawEvidenceRef: string;
};

/**
 * Requires both sides of the trade to have fresh RFQ quotes. The sell quote
 * is a current exit-liquidity check, not a guarantee that the later sale fills
 * at that price; the two legs are not atomic.
 */
export function validateRoundTripQuotes(
  buy: ValidatedBinanceQuote,
  sell: ValidatedBinanceQuote,
  input: { now?: number; networkFeeBufferBps: number },
): ValidatedRoundTripQuote {
  const now = input.now ?? Date.now();
  if (Date.parse(buy.expiresAt) <= now || Date.parse(sell.expiresAt) <= now) {
    throw new Error("One side of the Binance round-trip quote has expired");
  }
  if (buy.chainId !== sell.chainId || buy.walletAddress !== sell.walletAddress) {
    throw new Error("Buy and sell quotes must use the same wallet and chain");
  }
  if (buy.inputTokenAddress !== sell.outputTokenAddress ||
      buy.outputTokenAddress !== sell.inputTokenAddress) {
    throw new Error("Sell quote token direction does not reverse the buy quote");
  }
  if (buy.expectedAmountOut !== sell.amountIn) {
    throw new Error("Sell quote amount must exactly match the buy quote output");
  }
  if (buy.inputTokenDecimals !== sell.outputTokenDecimals ||
      buy.outputTokenDecimals !== sell.inputTokenDecimals) {
    throw new Error("Round-trip token decimal metadata is inconsistent");
  }
  // Until transfer-tax behavior is proven for the RFQ vendors, reject taxed
  // intermediate RWA assets instead of guessing whether quotes include tax.
  if (Number(buy.outputTokenTaxRate) !== 0 || Number(sell.inputTokenTaxRate) !== 0) {
    throw new Error("Non-zero RWA transfer tax is not supported by the round-trip evaluator");
  }

  const buyFee = applyNetworkFeeBuffer(buy.estimatedNetworkFeeUsd, input.networkFeeBufferBps);
  const sellFee = applyNetworkFeeBuffer(sell.estimatedNetworkFeeUsd, input.networkFeeBufferBps);
  const bufferedNetworkFeesUsd = sumUsdAmounts([buyFee, sellFee]);
  const edge = calculateNetEdge({
    inputAmount: buy.amountIn,
    inputDecimals: buy.inputTokenDecimals,
    inputTokenUsdPrice: buy.inputTokenUsdPrice,
    inputTokenTaxRate: buy.inputTokenTaxRate,
    outputAmount: sell.expectedAmountOut,
    outputDecimals: sell.outputTokenDecimals,
    outputTokenUsdPrice: sell.outputTokenUsdPrice,
    outputTokenTaxRate: sell.outputTokenTaxRate,
    tradeFeeUsd: "0",
    gasCostUsd: bufferedNetworkFeesUsd,
  });

  const expiresAt = new Date(Math.min(Date.parse(buy.expiresAt), Date.parse(sell.expiresAt))).toISOString();
  const routeFingerprint = createHash("sha256")
    .update(JSON.stringify([buy.routeFingerprint, sell.routeFingerprint]))
    .digest("hex");
  const rawEvidenceRef = createHash("sha256")
    .update(JSON.stringify([buy.rawEvidenceRef, sell.rawEvidenceRef]))
    .digest("hex");
  return {
    provider: "binance-web3-aggregator",
    buy,
    sell,
    indicativeRoundTripEdgeBps: edge.expectedEdgeBps,
    bufferedNetworkFeesUsd,
    approvalRequired: buy.approvalTarget !== null || sell.approvalTarget !== null,
    expiresAt,
    routeFingerprint,
    rawEvidenceRef,
  };
}
