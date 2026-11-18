export type NormalizedCandle = {
  timestamp: number;
  time: string;
  value: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed == null) return null;
  // Accept seconds defensively, although Binance documents milliseconds.
  const milliseconds = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  return milliseconds > 0 ? milliseconds : null;
}

function displayTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function extractRecords(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!isRecord(response)) return [];
  if (Array.isArray(response.data)) return response.data;
  if (isRecord(response.data) && Array.isArray(response.data.klineInfos)) return response.data.klineInfos;
  if (Array.isArray(response.klineInfos)) return response.klineInfos;
  return [];
}

/**
 * Normalize Binance Web3 Market API /api/v1/dex/market/candles data.
 *
 * That endpoint documents each array as:
 * [open, high, low, close, volume, timestampMs, tradeCount]
 * This is intentionally different from Binance's standard spot kline order.
 */
export function normalizeCandles(response: unknown, anchorPrice?: number | null): NormalizedCandle[] {
  const points = extractRecords(response).flatMap((record): NormalizedCandle[] => {
    if (Array.isArray(record)) {
      const open = numberValue(record[0]);
      const high = numberValue(record[1]);
      const low = numberValue(record[2]);
      const close = numberValue(record[3]);
      const timestamp = timestampMs(record[5]);
      if (open == null || high == null || low == null || close == null || timestamp == null) return [];
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || low > high) return [];
      return [{ timestamp, time: displayTime(timestamp), value: close }];
    }

    if (isRecord(record)) {
      const close = numberValue(record.close ?? record.closePrice ?? record.c);
      const timestamp = timestampMs(record.timestamp ?? record.time ?? record.openTime ?? record.closeTime);
      if (close == null || close <= 0 || timestamp == null) return [];
      return [{ timestamp, time: displayTime(timestamp), value: close }];
    }

    return [];
  }).sort((a, b) => a.timestamp - b.timestamp);

  if (points.length < 2) return [];
  if (!points.every((point) => Number.isFinite(point.value) && point.value > 0)) return [];

  if (anchorPrice != null && Number.isFinite(anchorPrice) && anchorPrice > 0) {
    const values = points.map((point) => point.value).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    if (Math.abs(median / anchorPrice - 1) > 0.5) return [];
  }

  return points;
}

export type ChartSeries = {
  points: NormalizedCandle[];
  interval: "1h" | "1d" | null;
  /** Why no chart is shown, in plain language; null when points are shown. */
  unavailableReason: string | null;
};

const HOURLY_MAX_AGE_MS = 6 * 60 * 60_000;
const DAILY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function latestTimestamp(response: unknown): number | null {
  let latest: number | null = null;
  for (const record of extractRecords(response)) {
    const raw = Array.isArray(record) ? record[5] : isRecord(record) ? (record.timestamp ?? record.time ?? record.openTime ?? record.closeTime) : null;
    const timestamp = timestampMs(raw);
    if (timestamp != null && (latest == null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

/**
 * Picks the most recent trustworthy series: hourly if its last candle is under 6 h old, else daily
 * if under 7 days old. Never shows stale or price-inconsistent candles; explains why instead.
 */
export function selectChartSeries(
  hourly: unknown,
  daily: unknown,
  anchorPrice: number | null | undefined,
  now = Date.now(),
): ChartSeries {
  const candidates = [
    { response: hourly, interval: "1h" as const, maxAgeMs: HOURLY_MAX_AGE_MS },
    { response: daily, interval: "1d" as const, maxAgeMs: DAILY_MAX_AGE_MS },
  ];
  let mismatch = false;
  for (const candidate of candidates) {
    const last = latestTimestamp(candidate.response);
    if (last == null || now - last > candidate.maxAgeMs) continue;
    const points = normalizeCandles(candidate.response, anchorPrice);
    if (points.length >= 2) {
      const labelled = candidate.interval === "1d"
        ? points.map((point) => ({ ...point, time: new Date(point.timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) }))
        : points;
      return { points: labelled, interval: candidate.interval, unavailableReason: null };
    }
    if (normalizeCandles(candidate.response).length >= 2) mismatch = true;
  }
  if (mismatch) {
    return { points: [], interval: null, unavailableReason: "Recent on-chain trades are inconsistent with the listed price, so no chart is shown." };
  }
  const lastTrade = [latestTimestamp(hourly), latestTimestamp(daily)].filter((value): value is number => value != null);
  if (lastTrade.length) {
    const date = new Date(Math.max(...lastTrade)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return { points: [], interval: null, unavailableReason: `No recent on-chain trades for this token on BSC (last recorded ${date}).` };
  }
  return { points: [], interval: null, unavailableReason: "Binance has no on-chain candle data for this token." };
}
