import "server-only";
import type { Q } from "@/lib/quotes";
import { marketQuoteUsd, quoteAgeSeconds } from "@/lib/quotes";
import {
  buildOpportunityRow,
  buildVenueResult,
  marketLabel,
  positiveNumberValue,
  type OpportunityRow,
  type VenueResult,
} from "@/lib/opportunityMath";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { isRwaAssetListResponse, parseRwaAssetRecords, type RwaAssetRecord } from "@/lib/rwaAssetResponse";
import { getRWATokenList } from "@/lib/binance";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";
import { getSupabaseClient } from "@/lib/supabaseClient";

export const MARKET_PULSE_TICKERS = ["SPY", "QQQ", "NVDA", "ORCL"] as const;
const MARKET_PULSE_TABLE = "tokenized_market_pulse";
const QUOTE_AMOUNT_USDT = 100;
const MAX_QUOTE_CONCURRENCY = 3;

type MarketPulseRecord = {
  ticker: string;
  price: number | null;
  indicative_estimate: number | null;
  reference_price: number | null;
  reference_gap: number | null;
  quote_freshness_seconds: number | null;
  market_status: string;
  session_mismatch: boolean;
  payload: OpportunityRow;
  updated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function isValidQuote(value: unknown): value is Q {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.ts !== "number" || !Number.isFinite(value.ts)) {
    return false;
  }
  if (value.ok) {
    return typeof value.usd === "number" && Number.isFinite(value.usd) && value.usd > 0 &&
      typeof value.mode === "string" && typeof value.vendor === "string" &&
      (value.impact === null || (typeof value.impact === "number" && Number.isFinite(value.impact)));
  }
  return typeof value.err === "string";
}

function validateStoredRow(value: unknown): OpportunityRow {
  if (!isRecord(value) || typeof value.ticker !== "string" || !Array.isArray(value.venues)) {
    throw new Error("Supabase returned a malformed market pulse payload.");
  }

  const venues: VenueResult[] = value.venues.flatMap((rawVenue) => {
    if (!isRecord(rawVenue) || !isRecord(rawVenue.token) || !isValidQuote(rawVenue.quote)) return [];
    const token = parseRwaAssetRecords({ data: [rawVenue.token] })[0];
    if (!token) return [];
    return [buildVenueResult(token, rawVenue.quote)];
  });
  if (venues.length !== value.venues.length) {
    throw new Error(`Supabase returned an invalid venue in the ${value.ticker} market pulse payload.`);
  }

  return withComparableSessionMismatch(buildOpportunityRow(value.ticker, venues));
}

function withComparableSessionMismatch(row: OpportunityRow): OpportunityRow {
  const comparableStatuses = row.venues
    .filter((venue) => venue.quote.ok && !venue.stale && !venue.unreliable &&
      venue.referencePerShare != null && venue.executablePerShare != null)
    .map((venue) => marketLabel(venue.token))
    .filter((status) => status !== "status unavailable");
  const statuses = Array.from(new Set(comparableStatuses));
  return { ...row, statuses, statusMismatch: statuses.length > 1 };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}

export async function updateMarketPulse(): Promise<{ updated: string[]; missing: string[] }> {
  const response: unknown = await getRWATokenList();
  if (!isRwaAssetListResponse(response, { allowEmpty: true })) {
    throw new Error("Binance returned an invalid RWA token list.");
  }

  const assets = filterSpotEligibleAssets(parseRwaAssetRecords(response));
  const grouped = new Map<string, Map<string, RwaAssetRecord>>();
  for (const asset of assets) {
    const ticker = asset.underlyingTicker.trim().toUpperCase();
    if (!(MARKET_PULSE_TICKERS as readonly string[]).includes(ticker)) continue;
    const venues = grouped.get(ticker) ?? new Map<string, RwaAssetRecord>();
    if (!venues.has(asset.platformId)) venues.set(asset.platformId, asset);
    grouped.set(ticker, venues);
  }

  const tickers = MARKET_PULSE_TICKERS.filter((ticker) => (grouped.get(ticker)?.size ?? 0) > 0);
  if (!tickers.length) {
    throw new Error(`Binance returned no eligible assets for ${MARKET_PULSE_TICKERS.join(", ")}.`);
  }

  const rows = await mapWithConcurrency(tickers, MAX_QUOTE_CONCURRENCY, async (ticker) => {
    const assetsForTicker = Array.from(grouped.get(ticker)?.values() ?? []);
    const venues = await Promise.all(assetsForTicker.map(async (asset) =>
      buildVenueResult(
        asset,
        await marketQuoteUsd(asset.tokenContractAddress, QUOTE_AMOUNT_USDT),
      )
    ));
    const row = withComparableSessionMismatch(buildOpportunityRow(ticker, venues));
    const primaryVenue = row.venues.find((venue) => venue.quote.ok) ?? row.venues[0];

    return {
      ticker,
      price: positiveNumberValue(primaryVenue.token.tokenPrice),
      indicative_estimate: finiteOrNull(primaryVenue.executablePerShare),
      reference_price: finiteOrNull(primaryVenue.referencePerShare),
      reference_gap: finiteOrNull(primaryVenue.referenceGap),
      quote_freshness_seconds: primaryVenue.quote.ok ? quoteAgeSeconds(primaryVenue.quote) : null,
      market_status: row.statuses.length ? row.statuses.join(" / ") : marketLabel(primaryVenue.token),
      session_mismatch: row.statusMismatch,
      payload: row,
      updated_at: new Date().toISOString(),
    } satisfies MarketPulseRecord;
  });

  const { error } = await getSupabaseAdminClient()
    .from(MARKET_PULSE_TABLE)
    .upsert(rows, { onConflict: "ticker" });
  if (error) throw new Error(`Supabase market pulse upsert failed: ${error.message}`);

  return {
    updated: rows.map((row) => row.ticker),
    missing: MARKET_PULSE_TICKERS.filter((ticker) => !grouped.has(ticker)),
  };
}

export async function getMarketPulseRows(
  tickers: readonly string[] = MARKET_PULSE_TICKERS,
): Promise<OpportunityRow[]> {
  if (!tickers.length) return [];

  const { data, error } = await getSupabaseClient()
    .from(MARKET_PULSE_TABLE)
    .select("ticker,payload")
    .in("ticker", [...tickers]);
  if (error) throw new Error(`Supabase market pulse read failed: ${error.message}`);
  if (!data) throw new Error("Supabase returned no market pulse query result.");

  const byTicker = new Map<string, OpportunityRow>();
  for (const record of data) {
    if (!isRecord(record) || typeof record.ticker !== "string") {
      throw new Error("Supabase returned a malformed market pulse record.");
    }
    const row = validateStoredRow(record.payload);
    if (row.ticker !== record.ticker) {
      throw new Error("Supabase market pulse ticker does not match its stored payload.");
    }
    byTicker.set(row.ticker, row);
  }
  return tickers.flatMap((ticker) => {
    const row = byTicker.get(ticker);
    return row ? [row] : [];
  });
}
