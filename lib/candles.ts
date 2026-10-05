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
