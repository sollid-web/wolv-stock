import type { Q } from "./quotes";
import type { RwaAssetRecord } from "./spotAssets";
import { MAX_RELIABLE_GAP_PERCENT } from "./marketThresholds.js";

export { MAX_RELIABLE_GAP_PERCENT } from "./marketThresholds.js";

export const OPPORTUNITY_QUOTE_TTL_MS = 30_000;
const UNAVAILABLE_MARKET_STATUSES = new Set([
  "unknown", "n/a", "na", "not available", "unavailable", "unspecified",
  "none", "null", "undefined", "pending", "not set", "-", "--", "–", "—", "status unavailable",
]);

export type VenueResult = {
  token: RwaAssetRecord;
  quote: Q;
  multiplier: number | null;
  referencePrice: number | null;
  referencePerShare: number | null;
  executablePerShare: number | null;
  referenceGap: number | null;
  stale: boolean;
  unreliable: boolean;
};

export type OpportunityRow = {
  ticker: string;
  venues: VenueResult[];
  crossVenueSpread: number | null;
  statusMismatch: boolean;
  statuses: string[];
};

export type CrossListedPair = { ticker: string; venues: RwaAssetRecord[] };

export function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function positiveNumberValue(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizePerSharePrice(value: unknown, tokenToShareRatio: unknown): number | null {
  const price = positiveNumberValue(value);
  const ratio = positiveNumberValue(tokenToShareRatio);
  if (price == null || ratio == null) return null;
  const perShare = price / ratio;
  return Number.isFinite(perShare) && perShare > 0 ? perShare : null;
}

export function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(3)}%`;
}

export function marketLabel(token: { statusInfo?: { openState?: boolean | null; marketStatus?: string | null } | null }): string {
  const status = token.statusInfo?.marketStatus;
  const normalizedStatus = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (normalizedStatus && !UNAVAILABLE_MARKET_STATUSES.has(normalizedStatus)) return normalizedStatus;
  if (token.statusInfo?.openState === true) return "open";
  if (token.statusInfo?.openState === false) return "closed";
  return "status unavailable";
}

export function getCrossListedPairs(tokens: RwaAssetRecord[]): CrossListedPair[] {
  const grouped = new Map<string, Map<string, RwaAssetRecord>>();

  for (const token of tokens) {
    const ticker = token.underlyingTicker.trim();
    const platform = token.platformId.trim();
    if (!ticker || !platform) continue;
    const venues = grouped.get(ticker) ?? new Map<string, RwaAssetRecord>();
    if (!venues.has(platform)) venues.set(platform, token);
    grouped.set(ticker, venues);
  }

  return Array.from(grouped.entries())
    .filter(([, venues]) => venues.size >= 2)
    .map(([ticker, venues]) => ({ ticker, venues: Array.from(venues.values()) }))
    .sort((a, b) =>
      Math.max(...b.venues.map((token) => numberValue(token.volume24H))) -
      Math.max(...a.venues.map((token) => numberValue(token.volume24H)))
    );
}

export function buildVenueResult(token: RwaAssetRecord, quote: Q, now = Date.now()): VenueResult {
  const multiplier = positiveNumberValue(token.tokenToShareRatio);
  const referencePrice = positiveNumberValue(token.referencePrice);
  const referencePerShare = normalizePerSharePrice(token.referencePrice, token.tokenToShareRatio);
  const executablePerShare = quote.ok
    ? normalizePerSharePrice(quote.usd, token.tokenToShareRatio)
    : null;
  const referenceGap = executablePerShare != null && referencePerShare != null && referencePerShare > 0
    ? (executablePerShare / referencePerShare - 1) * 100
    : null;

  return {
    token,
    quote,
    multiplier,
    referencePrice,
    referencePerShare,
    executablePerShare,
    referenceGap,
    stale: !(now - quote.ts < OPPORTUNITY_QUOTE_TTL_MS),
    unreliable: referenceGap != null && Math.abs(referenceGap) > MAX_RELIABLE_GAP_PERCENT,
  };
}

export function buildOpportunityRow(ticker: string, venues: VenueResult[]): OpportunityRow {
  const reliablePrices = venues
    .filter((venue) =>
      venue.quote.ok &&
      !venue.stale &&
      !venue.unreliable &&
      venue.referenceGap != null
    )
    .map((venue) => venue.executablePerShare)
    .filter((value): value is number => value != null && value > 0);
  const statuses = Array.from(new Set(
    venues.map((venue) => marketLabel(venue.token)).filter((status) => status !== "status unavailable")
  ));

  return {
    ticker,
    venues,
    crossVenueSpread: reliablePrices.length >= 2
      ? (Math.max(...reliablePrices) / Math.min(...reliablePrices) - 1) * 100
      : null,
    statusMismatch: statuses.length > 1,
    statuses,
  };
}
