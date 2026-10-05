export type RouterQuoteCandidate = { effectiveUsd: number | null };

export function selectBestRouterQuote<T extends RouterQuoteCandidate>(rows: readonly T[]): T | undefined {
  return rows
    .filter((row) => row.effectiveUsd != null && Number.isFinite(row.effectiveUsd) && row.effectiveUsd > 0)
    .sort((a, b) => (a.effectiveUsd ?? Infinity) - (b.effectiveUsd ?? Infinity))[0];
}
