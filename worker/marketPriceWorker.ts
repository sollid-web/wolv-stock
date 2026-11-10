import { getRWAPrice, getRWATokenList } from "../lib/binance.ts";
import { isRwaAssetListResponse } from "../lib/rwaAssetResponse.ts";
import { parseBinanceRwaPrices, upsertMarketPrices, upsertMarketOpportunities } from "../services/marketPriceCache.ts";
import { scanMarketDislocations } from "../services/autonomy/opportunity-scanner.ts";

const INTERVAL_MS = Math.max(15_000, Number(process.env.WOLV_MARKET_REFRESH_MS ?? 30_000));
const BATCH_SIZE = 20;

type CatalogueAsset = { tokenContractAddress: string; underlyingTicker: string; referencePrice?: string | number };

function watchlist(): string[] {
  const raw = process.env.WOLV_MARKET_WATCHLIST;
  if (!raw) throw new Error("WOLV_MARKET_WATCHLIST must be a JSON array of BSC token addresses.");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < 1 ||
    parsed.some((item) => typeof item !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(item))) {
    throw new Error("WOLV_MARKET_WATCHLIST must contain valid EVM token addresses.");
  }
  return [...new Set(parsed.map((item: string) => item.toLowerCase()))];
}

async function refreshOnce() {
  const addresses = watchlist();
  const rawCatalogue: unknown = await getRWATokenList();
  if (!isRwaAssetListResponse(rawCatalogue)) throw new Error("Binance returned an invalid RWA catalogue.");
  const catalogue = (rawCatalogue.data as CatalogueAsset[])
    .filter((asset) => addresses.includes(asset.tokenContractAddress.toLowerCase()))
    .map((asset) => ({
      tokenAddress: asset.tokenContractAddress,
      ticker: asset.underlyingTicker,
      referencePriceUsd: asset.referencePrice == null ? null : String(asset.referencePrice),
    }));
  if (catalogue.length !== addresses.length) {
    const found = new Set(catalogue.map((asset) => asset.tokenAddress.toLowerCase()));
    const missing = addresses.filter((address) => !found.has(address));
    console.warn(`[market-worker] ${missing.length} watchlist assets missing from Binance catalogue`);
  }
  let stored = 0;
  for (let index = 0; index < catalogue.length; index += BATCH_SIZE) {
    const batch = catalogue.slice(index, index + BATCH_SIZE);
    const response = await getRWAPrice(batch.map((asset) => asset.tokenAddress), "56");
    const rows = parseBinanceRwaPrices(response, batch);
    stored += await upsertMarketPrices(rows);
    const now = new Date().toISOString();
    const signals = scanMarketDislocations(rows.map((row) => ({
      chainId: row.chainId, tokenAddress: row.tokenAddress, ticker: row.ticker,
      priceUsd: row.priceUsd, referencePriceUsd: row.referencePriceUsd,
      providerTimestamp: row.providerTimestamp,
      stale: !Number.isFinite(Date.parse(row.providerTimestamp)) ||
        Date.now() - Date.parse(row.providerTimestamp) > 5 * 60_000 ||
        Date.parse(row.providerTimestamp) > Date.now() + 30_000,
    })), {
      minDeviationBps: Math.max(1, Math.min(10_000, Number(process.env.WOLV_SCANNER_MIN_EDGE_BPS ?? 100))),
      now,
    });
    await upsertMarketOpportunities(signals);
    if (rows.length !== batch.length) {
      console.warn(`[market-worker] parsed ${rows.length}/${batch.length} price rows in batch`);
    }
  }
  console.info(`[market-worker] refreshed ${stored}/${catalogue.length} assets at ${new Date().toISOString()}`);
}

async function main() {
  console.info(`[market-worker] starting; refresh interval=${INTERVAL_MS}ms`);
  for (;;) {
    const started = Date.now();
    try { await refreshOnce(); }
    catch (error) {
      console.error("[market-worker] refresh failed:", error instanceof Error ? error.message : "unknown error");
    }
    const wait = Math.max(1_000, INTERVAL_MS - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main().catch((error) => {
  console.error("[market-worker] fatal startup error:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
