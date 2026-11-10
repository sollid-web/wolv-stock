/**
 * Deterministic market-dislocation scanner.
 * Signals are research candidates, not executable quotes or trade instructions.
 */
export type ScannerPrice = {
  chainId: number; tokenAddress: string; ticker: string; priceUsd: string;
  referencePriceUsd: string | null; providerTimestamp: string; stale: boolean;
};
export type OpportunitySignal = {
  chainId: number; tokenAddress: string; ticker: string;
  direction: "DISCOUNT" | "PREMIUM"; marketPriceUsd: string; referencePriceUsd: string;
  deviationBps: number; thresholdBps: number; providerTimestamp: string;
  status: "ACTIVE" | "CLEARED"; observedAt: string;
};

export function scanMarketDislocations(
  prices: ScannerPrice[],
  options: { minDeviationBps?: number; now?: string } = {},
): OpportunitySignal[] {
  const threshold = options.minDeviationBps ?? 100;
  const now = options.now ?? new Date().toISOString();
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10_000) {
    throw new Error("minDeviationBps must be an integer between 1 and 10000.");
  }
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid scanner clock.");
  return prices.flatMap((price) => {
    if (price.stale || !price.referencePriceUsd) return [];
    if (!/^0x[a-fA-F0-9]{40}$/.test(price.tokenAddress)) return [];
    const market = Number(price.priceUsd);
    const reference = Number(price.referencePriceUsd);
    const providerTime = Date.parse(price.providerTimestamp);
    if (!Number.isFinite(market) || !Number.isFinite(reference) || market <= 0 || reference <= 0 ||
      !Number.isFinite(providerTime) || providerTime > Date.parse(now) + 30_000) return [];
    const deviationBps = Math.round(((reference - market) / reference) * 10_000);
    const absoluteDeviation = Math.abs(deviationBps);
    return [{
      chainId: price.chainId, tokenAddress: price.tokenAddress.toLowerCase(), ticker: price.ticker,
      direction: deviationBps >= 0 ? "DISCOUNT" as const : "PREMIUM" as const,
      marketPriceUsd: price.priceUsd, referencePriceUsd: price.referencePriceUsd,
      deviationBps, thresholdBps: threshold, providerTimestamp: price.providerTimestamp,
      status: absoluteDeviation >= threshold ? "ACTIVE" as const : "CLEARED" as const,
      observedAt: now,
    }];
  });
}
