import "server-only";
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { isSpotEligibleAsset } from "../lib/compliance.ts";
import {
  detectCrossVenueOpportunity,
  validateMarketObservation,
  type AssetVersionInput,
  type MarketObservationInput,
} from "../lib/agentControlPlane.ts";
import type { AgentMemoryStorePort } from "./agentMemoryStore.ts";

export const MAX_WATCHLIST_ASSETS = 25;
export const MAX_COLLECTION_CONCURRENCY = 3;
export const MAX_MARKET_OBSERVATION_AGE_MS = 60_000;

export type MarketAsset = AssetVersionInput & {
  id: string;
  tokenToShareRatio: string | null;
};

export type CollectorCandle = {
  interval: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  openingAt: number;
  closingAt: number;
  provider: string;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | "REJECTED";
  provenance: Record<string, unknown>;
};

export interface MarketDataAdapter {
  readonly providerId: string;
  loadCatalogue(watchlist: readonly string[]): Promise<AssetVersionInput[]>;
  observe?(asset: MarketAsset, now: number): Promise<Omit<MarketObservationInput, "assetId" | "idempotencyKey"> | null>;
  candles?(asset: MarketAsset, intervals: readonly string[], now: number): Promise<CollectorCandle[]>;
}

export type CollectionResult = {
  provider: string;
  assetsVersioned: number;
  observationsStored: number;
  candlesStored: number;
  evidenceLimitations: string[];
  failures: Array<{ address: string; stage: string; reason: string }>;
  completedAt: number;
};

export class MarketCollectorError extends Error {
  readonly code: "DISABLED" | "INVALID_WATCHLIST" | "PROVIDER_UNAVAILABLE" | "CONTROL_STOPPED";

  constructor(
    code: MarketCollectorError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "MarketCollectorError";
  }
}

export class MarketDataCollector {
  private readonly store: AgentMemoryStorePort;
  private readonly adapter: MarketDataAdapter;
  private readonly options: {
    enabled?: boolean;
    maxObservationAgeMs?: number;
    now?: () => number;
    intervals?: readonly string[];
  };

  constructor(
    store: AgentMemoryStorePort,
    adapter: MarketDataAdapter,
    options: MarketDataCollector["options"] = {},
  ) {
    this.store = store;
    this.adapter = adapter;
    this.options = options;
  }

  async collectWatchlist(watchlist: readonly string[], ownerAddress: string): Promise<CollectionResult> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const owner = requireOwnerAddress(ownerAddress);
    if (!(this.options.enabled ?? process.env.WOLV_MARKET_COLLECTOR_ENABLED === "true")) {
      throw new MarketCollectorError("DISABLED", "Market collection is disabled; set WOLV_MARKET_COLLECTOR_ENABLED=true to enable an explicit collection request.");
    }
    if (watchlist.length < 1 || watchlist.length > MAX_WATCHLIST_ASSETS ||
      watchlist.some((address) => !/^0x[a-fA-F0-9]{40}$/.test(address)) ||
      new Set(watchlist.map((address) => address.toLowerCase())).size !== watchlist.length) {
      throw new MarketCollectorError("INVALID_WATCHLIST", `Watchlist must contain 1–${MAX_WATCHLIST_ASSETS} unique EVM token addresses.`);
    }
    const control = await this.store.getControlState(now());
    if (control.emergency_stop === true || control.stop_monitoring === true ||
      control.reject_new_opportunities === true || control.permission_active !== true) {
      throw new MarketCollectorError("CONTROL_STOPPED", "Emergency stop is active or control permission is missing or expired.");
    }

    const result: CollectionResult = {
      provider: this.adapter.providerId,
      assetsVersioned: 0,
      observationsStored: 0,
      candlesStored: 0,
      evidenceLimitations: [],
      failures: [],
      completedAt: startedAt,
    };
    const assetIds = new Map<string, MarketAsset>();
    try {
      const catalogue = await this.adapter.loadCatalogue(watchlist);
      const selected = new Set(watchlist.map((address) => address.toLowerCase()));
      const validCatalogue = catalogue.filter((asset) =>
        asset.chainId === 56 &&
        selected.has(asset.tokenAddress.toLowerCase()) &&
        /^0x[a-fA-F0-9]{40}$/.test(asset.tokenAddress) &&
        asset.ticker.trim().length > 0 &&
        asset.platform.trim().length > 0 &&
        asset.metadataSource.trim().length > 0 &&
        (asset.decimals === null || (Number.isSafeInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 255)) &&
        isRecord(asset.metadata) &&
        isSpotEligibleAsset({
          underlyingTicker: asset.ticker,
          tokenName: typeof asset.metadata.tokenName === "string" ? asset.metadata.tokenName : null,
          underlyingName: typeof asset.metadata.underlyingName === "string" ? asset.metadata.underlyingName : null,
          leverage: typeof asset.metadata.leverage === "string" || typeof asset.metadata.leverage === "number"
            ? asset.metadata.leverage
            : null,
          leverageFactor: typeof asset.metadata.leverageFactor === "string" || typeof asset.metadata.leverageFactor === "number"
            ? asset.metadata.leverageFactor
            : null,
        }),
      );
      for (const address of watchlist) {
        const asset = validCatalogue.find((candidate) =>
          candidate.tokenAddress.toLowerCase() === address.toLowerCase());
        if (!asset) {
          result.failures.push({ address, stage: "CATALOGUE", reason: "Asset is absent from the trusted eligible catalogue." });
          continue;
        }
        try {
          const canonicalAddress = getAddress(asset.tokenAddress);
          const stored = await this.store.recordAssetVersion({ ...asset, tokenAddress: canonicalAddress });
          result.assetsVersioned += Number(stored.created);
          assetIds.set(address.toLowerCase(), {
            ...asset,
            tokenAddress: canonicalAddress,
            id: stored.assetId,
            tokenToShareRatio: typeof asset.shareDenomination?.tokenToShareRatio === "string"
              ? asset.shareDenomination.tokenToShareRatio
              : null,
          });
        } catch (error) {
          result.failures.push({ address, stage: "CATALOGUE_VALIDATION", reason: safeErrorMessage(error) });
        }
      }

      const entries = [...assetIds.values()];
      const observed = await mapBounded(entries, MAX_COLLECTION_CONCURRENCY, async (asset) => {
        if (!this.adapter.observe) {
          result.evidenceLimitations.push(
            `${asset.ticker}: provider adapter does not expose a provider timestamp for price observations.`,
          );
          return;
        }
        try {
          const observation = await this.adapter.observe(asset, now());
          if (!observation) return;
          const complete: MarketObservationInput = {
            ...observation,
            ownerAddress: owner,
            assetId: asset.id,
            ingestedAt: now(),
            idempotencyKey: buildObservationIdempotencyKey(asset.id, observation),
          };
          const errors = validateMarketObservation(
            complete,
            now(),
            this.options.maxObservationAgeMs ?? MAX_MARKET_OBSERVATION_AGE_MS,
          );
          if (errors.length) {
            result.failures.push({ address: asset.tokenAddress, stage: "OBSERVATION_VALIDATION", reason: errors.join(" ") });
            return;
          }
          const stored = await this.store.recordObservation(complete);
          result.observationsStored += Number(stored.created);
        } catch (error) {
          result.failures.push({ address: asset.tokenAddress, stage: "OBSERVATION", reason: safeErrorMessage(error) });
        }
      });
      void observed;

      const intervals = this.options.intervals ?? [];
      if (intervals.length && this.adapter.candles) {
        await mapBounded(entries, MAX_COLLECTION_CONCURRENCY, async (asset) => {
          try {
            const candles = await this.adapter.candles!(asset, intervals, now());
            for (const candle of candles) {
              const invalid = validateCandle(candle, now());
              if (invalid) {
                result.failures.push({ address: asset.tokenAddress, stage: "CANDLE_VALIDATION", reason: invalid });
                continue;
              }
              const stored = await this.store.recordCandle({
                ownerAddress: owner,
                assetId: asset.id,
                ...candle,
              });
              result.candlesStored += Number(stored.created);
            }
          } catch (error) {
            result.failures.push({ address: asset.tokenAddress, stage: "CANDLES", reason: safeErrorMessage(error) });
          }
        });
      }

      result.completedAt = now();
      await this.store.appendEvent(null, {
        eventType: "MARKET_COLLECTION_COMPLETED",
        occurredAt: result.completedAt,
        correlationId: `${this.adapter.providerId}:${startedAt}`,
        payload: {
          provider: result.provider,
          assetsVersioned: result.assetsVersioned,
          observationsStored: result.observationsStored,
          candlesStored: result.candlesStored,
          failureCount: result.failures.length,
          evidenceLimitations: result.evidenceLimitations,
        },
        provenance: { source: "market-data-collector", provider: this.adapter.providerId },
      }, owner);
      return result;
    } catch (error) {
      const reason = safeErrorMessage(error);
      await this.store.appendEvent(null, {
        eventType: "MARKET_COLLECTION_FAILED",
        occurredAt: now(),
        correlationId: `${this.adapter.providerId}:${startedAt}`,
        payload: { provider: this.adapter.providerId, reason },
        provenance: { source: "market-data-collector", provider: this.adapter.providerId },
      }, owner);
      throw new MarketCollectorError("PROVIDER_UNAVAILABLE", "Market collection failed; sanitized failure details were recorded.");
    }

    function requireOwnerAddress(value: string): string {
      if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new TypeError("A valid wallet owner is required for market collection.");
      return value.toLowerCase();
    }
  }
}

export function detectPersistedOpportunities(
  observations: Parameters<typeof detectCrossVenueOpportunity>[0]["evidence"],
  now: number,
  minimumAbsoluteSpreadPercent: number,
) {
  return detectCrossVenueOpportunity({
    evidence: observations,
    now,
    maxAgeMs: MAX_MARKET_OBSERVATION_AGE_MS,
    minimumAbsoluteSpreadPercent,
  });
}

function buildObservationIdempotencyKey(
  assetId: string,
  observation: Omit<MarketObservationInput, "assetId" | "idempotencyKey">,
): string {
  return createHash("sha256").update(JSON.stringify([
    assetId,
    observation.source,
    observation.providerTimestamp,
    observation.price,
    observation.referencePrice,
    observation.bid,
    observation.ask,
    observation.spreadPercent,
    observation.currency,
    observation.priceKind,
    observation.verificationStatus,
  ])).digest("hex");
}

function validateCandle(candle: CollectorCandle, now: number): string | null {
  const amounts = [candle.open, candle.high, candle.low, candle.close];
  if (amounts.some((value) => !isPositiveDecimal(value))) return "Candle OHLC prices must be positive decimals.";
  if (candle.volume !== null && !isNonnegativeDecimal(candle.volume)) return "Candle volume must be a non-negative decimal.";
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (![open, high, low, close].every(Number.isFinite) || low > Math.min(open, close) || high < Math.max(open, close)) {
    return "Candle OHLC values are inconsistent.";
  }
  if (!Number.isSafeInteger(candle.openingAt) || !Number.isSafeInteger(candle.closingAt) ||
    candle.openingAt <= 0 || candle.closingAt <= candle.openingAt || candle.closingAt > now + 30_000) {
    return "Candle timestamps are invalid.";
  }
  if (!candle.interval.trim() || !candle.provider.trim() ||
    !["VERIFIED", "UNVERIFIED", "REJECTED"].includes(candle.verificationStatus) ||
    !isRecord(candle.provenance)) return "Candle provenance is incomplete.";
  return null;
}

function isPositiveDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
}

function isNonnegativeDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Provider returned an unknown error.";
  return error.message
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 300);
}
