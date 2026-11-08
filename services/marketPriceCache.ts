const CHAIN_ID = 56;
const PROVIDER = "binance-web3-rwa-price";
const MAX_DISPLAY_AGE_MS = 5 * 60_000;

export type MarketPrice = {
  chainId: number;
  tokenAddress: string;
  ticker: string;
  priceUsd: string;
  referencePriceUsd: string | null;
  provider: string;
  providerTimestamp: string;
  observedAt: string;
  ageMs: number;
  stale: boolean;
};

export type MarketPriceInput = Omit<MarketPrice, "ageMs" | "stale"> & {
  payload: Record<string, unknown>;
};

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and service-role key are required for market-price persistence.");
  return { url, key };
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Supabase market cache request failed (${response.status}): ${detail}`);
  }
  return response.status === 204 ? [] : response.json();
}

export async function upsertMarketPrices(rows: MarketPriceInput[]): Promise<number> {
  if (!rows.length) return 0;
  const history = rows.map((row) => ({
    chain_id: row.chainId,
    token_address: row.tokenAddress.toLowerCase(),
    ticker: row.ticker,
    price_usd: row.priceUsd,
    reference_price_usd: row.referencePriceUsd,
    provider: row.provider,
    provider_timestamp: row.providerTimestamp,
    ingested_at: row.observedAt,
    payload: row.payload,
  }));
  await rest("wolv_market_price_history?on_conflict=chain_id,token_address,provider,provider_timestamp", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(history),
  });
  const latest = rows.map((row) => ({
    chain_id: row.chainId,
    token_address: row.tokenAddress.toLowerCase(),
    ticker: row.ticker,
    price_usd: row.priceUsd,
    reference_price_usd: row.referencePriceUsd,
    provider: row.provider,
    provider_timestamp: row.providerTimestamp,
    observed_at: row.observedAt,
    payload: row.payload,
  }));
  await rest("wolv_market_prices_latest?on_conflict=chain_id,token_address", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(latest),
  });
  return rows.length;
}

export async function readLatestMarketPrices(options: {
  ticker?: string;
  tokenAddress?: string;
  limit?: number;
  now?: number;
} = {}): Promise<MarketPrice[]> {
  const query = new URLSearchParams({
    select: "chain_id,token_address,ticker,price_usd,reference_price_usd,provider,provider_timestamp,observed_at",
    order: "ticker.asc",
    limit: String(Math.min(100, Math.max(1, options.limit ?? 50))),
  });
  if (options.ticker) query.set("ticker", `eq.${options.ticker.toUpperCase()}`);
  if (options.tokenAddress) query.set("token_address", `ilike.${options.tokenAddress.toLowerCase()}`);
  const rows = await rest(`wolv_market_prices_latest?${query.toString()}`, { method: "GET" }) as Array<Record<string, unknown>>;
  const now = options.now ?? Date.now();
  return rows.map((row) => {
    const observedAt = String(row.observed_at);
    const ageMs = Math.max(0, now - Date.parse(String(row.provider_timestamp)));
    return {
      chainId: Number(row.chain_id),
      tokenAddress: String(row.token_address),
      ticker: String(row.ticker),
      priceUsd: String(row.price_usd),
      referencePriceUsd: row.reference_price_usd == null ? null : String(row.reference_price_usd),
      provider: String(row.provider),
      providerTimestamp: String(row.provider_timestamp),
      observedAt,
      ageMs,
      stale: !Number.isFinite(ageMs) || ageMs > MAX_DISPLAY_AGE_MS,
    };
  });
}

export function parseBinanceRwaPrices(
  response: unknown,
  catalogue: Array<{ tokenAddress: string; ticker: string; referencePriceUsd?: string | null }>,
  observedAt = new Date().toISOString(),
): MarketPriceInput[] {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new Error("Binance RWA price response did not match the expected data-array contract.");
  }
  const assets = new Map(catalogue.map((asset) => [asset.tokenAddress.toLowerCase(), asset]));
  const result: MarketPriceInput[] = [];
  for (const candidate of response.data) {
    if (!isRecord(candidate)) continue;
    const address = firstString(candidate, ["tokenContractAddress", "tokenAddress", "contractAddress"]);
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) continue;
    const asset = assets.get(address.toLowerCase());
    if (!asset) continue;
    const price = firstDecimal(candidate, ["tokenPrice", "price", "priceUsd", "usdPrice", "currentPrice"]);
    if (!price || Number(price) <= 0) continue;
    const reference = firstDecimal(candidate, ["referencePrice", "referencePriceUsd"]);
    const providerTime = firstTimestamp(candidate, ["timestamp", "updateTime", "updatedAt", "priceTimestamp"]) ?? observedAt;
    result.push({
      chainId: CHAIN_ID,
      tokenAddress: asset.tokenAddress,
      ticker: asset.ticker,
      priceUsd: price,
      referencePriceUsd: reference ?? asset.referencePriceUsd ?? null,
      provider: PROVIDER,
      providerTimestamp: providerTime,
      observedAt,
      payload: candidate,
    });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof row[key] === "string" && row[key].trim()) return row[key].trim();
  return null;
}
function firstDecimal(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if ((typeof value === "string" || typeof value === "number") &&
      /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) > 0) {
      return String(value);
    }
  }
  return null;
}
function firstTimestamp(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      const millis = value < 10_000_000_000 ? value * 1000 : value;
      if (Number.isFinite(new Date(millis).getTime())) return new Date(millis).toISOString();
    }
  }
  return null;
}
