import { NextResponse } from "next/server";
import { getCandles, getRWAPrice, getRWATokenList } from "@/lib/binance";
import { EVM_ADDRESS_PATTERN } from "@/lib/apiValidation";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { normalizeCandles } from "@/lib/candles";
import { parseRwaAssetRecords } from "@/lib/spotAssets";

export const dynamic = "force-dynamic";

const TIMEFRAMES = {
  "1H": { bar: "1m", limit: "60" },
  "1D": { bar: "15m", limit: "96" },
  "1W": { bar: "1h", limit: "168" },
  "1M": { bar: "4h", limit: "180" },
  ALL: { bar: "1w", limit: "260" },
} as const;

type Timeframe = keyof typeof TIMEFRAMES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractRecords(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.data)) return value.data;
  if (isRecord(value.data) && Array.isArray(value.data.klineInfos)) return value.data.klineInfos;
  return [];
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address") ?? "";
    const requestedTimeframe = (searchParams.get("timeframe") ?? "1D").toUpperCase();

    if (!EVM_ADDRESS_PATTERN.test(address)) {
      return NextResponse.json({ error: "Invalid asset address" }, { status: 400 });
    }
    if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES, requestedTimeframe)) {
      return NextResponse.json({ error: "Unsupported candle interval" }, { status: 400 });
    }

    const response: unknown = await getRWATokenList();
    const asset = filterSpotEligibleAssets(parseRwaAssetRecords(response))
      .find((item) => item.tokenContractAddress.toLowerCase() === address.toLowerCase());
    if (!asset) {
      return NextResponse.json({ error: "Only verified eligible BSC spot assets are supported" }, { status: 404 });
    }

    const timeframe = TIMEFRAMES[requestedTimeframe as Timeframe];
    const [priceResult, candleResult] = await Promise.allSettled([
      getRWAPrice([asset.tokenContractAddress], "56"),
      getCandles(asset.tokenContractAddress, "56", timeframe.bar, timeframe.limit),
    ]);

    const priceResponse = priceResult.status === "fulfilled" ? priceResult.value : null;
    const priceItems = isRecord(priceResponse) && Array.isArray(priceResponse.data) ? priceResponse.data : [];
    const priceRecord = priceItems.find((item) => isRecord(item)
      && typeof item.tokenContractAddress === "string"
      && item.tokenContractAddress.toLowerCase() === asset.tokenContractAddress.toLowerCase());
    const freshPrice = isRecord(priceRecord) ? priceRecord : null;
    const tokenPrice = numberOrNull(freshPrice?.tokenPrice) ?? numberOrNull(asset.tokenPrice);
    const referencePrice = numberOrNull(freshPrice?.referencePrice) ?? numberOrNull(asset.referencePrice);

    const rawCandles = candleResult.status === "fulfilled" ? candleResult.value : null;
    const candles = normalizeCandles(rawCandles, tokenPrice);
    const rawRows = extractRecords(rawCandles);
    const volumeByTimestamp = new Map<number, number>();
    for (const row of rawRows) {
      if (Array.isArray(row)) {
        const timestamp = numberOrNull(row[5]);
        const volume = numberOrNull(row[4]);
        if (timestamp != null && volume != null) volumeByTimestamp.set(timestamp, volume);
      }
    }

    const snapshot = {
      tokenPrice,
      referencePrice,
      tokenToShareRatio: numberOrNull(asset.tokenToShareRatio),
      decimals: numberOrNull(asset.decimals),
      volume24H: numberOrNull(asset.volume24H),
      marketCap: numberOrNull(asset.marketCap),
      marketStatus: asset.statusInfo?.marketStatus ?? null,
      openState: asset.statusInfo?.openState ?? null,
      priceUpdatedAt: numberOrNull(freshPrice?.tokenPriceUpdatedAt),
    };

    return NextResponse.json({
      snapshot,
      candles: candles.map((point) => ({
        ...point,
        volume: volumeByTimestamp.get(point.timestamp) ?? null,
      })),
      fetchedAt: Date.now(),
      candleError: candleResult.status === "rejected" || candles.length < 2 ? "Verified candle history is currently unavailable for this interval." : null,
      priceError: priceResult.status === "rejected" ? "Latest price refresh is unavailable; showing the last validated asset-list snapshot." : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    console.error("Terminal market refresh failed:", error);
    return NextResponse.json({ error: "Market data is temporarily unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
