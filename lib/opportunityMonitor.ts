import { marketQuoteUsd } from "./quotes";
import type { RwaAssetRecord } from "./spotAssets";
import {
  buildOpportunityRow,
  buildVenueResult,
  getCrossListedPairs,
  type OpportunityRow,
} from "./opportunityMath";

export const QUOTE_AMOUNT_USDT = 100;
const MAX_CONCURRENT_QUOTES = 4;
const OPPORTUNITY_ROW_CACHE_TTL_MS = 30_000;

const rowCache = new Map<string, { row: OpportunityRow; expiresAt: number }>();
const rowInFlight = new Map<string, Promise<OpportunityRow>>();

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

function pairCacheKey(pair: { ticker: string; venues: RwaAssetRecord[] }): string {
  return JSON.stringify({
    ticker: pair.ticker,
    venues: pair.venues.map((token) => ({
      address: token.tokenContractAddress.toLowerCase(),
      referencePrice: token.referencePrice,
      tokenToShareRatio: token.tokenToShareRatio,
      marketStatus: token.statusInfo?.marketStatus,
      openState: token.statusInfo?.openState,
    })),
  });
}

function refreshCachedRow(row: OpportunityRow): OpportunityRow {
  return buildOpportunityRow(
    row.ticker,
    row.venues.map((venue) => buildVenueResult(venue.token, venue.quote, Date.now()))
  );
}

async function loadPair(pair: { ticker: string; venues: RwaAssetRecord[] }, key: string): Promise<OpportunityRow> {
  const cached = rowCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return refreshCachedRow(cached.row);
  if (cached) rowCache.delete(key);

  const inFlight = rowInFlight.get(key);
  if (inFlight) return inFlight;

  const pending = (async () => {
    const venues = await mapWithConcurrency(pair.venues, MAX_CONCURRENT_QUOTES, async (token) => {
      const quote = await marketQuoteUsd(token.tokenContractAddress, QUOTE_AMOUNT_USDT);
      return buildVenueResult(token, quote);
    });
    const row = buildOpportunityRow(pair.ticker, venues);
    rowCache.set(key, { row, expiresAt: Date.now() + OPPORTUNITY_ROW_CACHE_TTL_MS });
    return row;
  })().finally(() => rowInFlight.delete(key));

  rowInFlight.set(key, pending);
  return pending;
}

export async function getOpportunityRows(tokens: RwaAssetRecord[], limit = 8): Promise<OpportunityRow[]> {
  const pairs = getCrossListedPairs(tokens).slice(0, Math.max(0, limit));
  return mapWithConcurrency(pairs, MAX_CONCURRENT_QUOTES, (pair) => loadPair(pair, pairCacheKey(pair)));
}
