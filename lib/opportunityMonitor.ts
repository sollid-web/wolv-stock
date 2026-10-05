import { quoteUsd } from "./quotes";
import type { RwaAssetRecord } from "./spotAssets";
import {
  buildOpportunityRow,
  buildVenueResult,
  getCrossListedPairs,
  type OpportunityRow,
} from "./opportunityMath";

export const QUOTE_AMOUNT_USDT = 100;
const MAX_CONCURRENT_QUOTES = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export async function getOpportunityRows(tokens: RwaAssetRecord[], limit = 8): Promise<OpportunityRow[]> {
  const pairs = getCrossListedPairs(tokens).slice(0, Math.max(0, limit));
  return mapWithConcurrency(pairs, MAX_CONCURRENT_QUOTES, async (pair) => {
    const venues = await mapWithConcurrency(pair.venues, MAX_CONCURRENT_QUOTES, async (token) => {
      const quote = await quoteUsd(token.tokenContractAddress, QUOTE_AMOUNT_USDT);
      return buildVenueResult(token, quote);
    });
    return buildOpportunityRow(pair.ticker, venues);
  });
}
