import "server-only";
import { createPublicClient, formatUnits, http } from "viem";
import { bsc } from "viem/chains";
import type { DynamicMarketMetrics } from "../lib/dynamicStrategy.ts";

const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [
    { name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" },
  ] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export type LiveDynamicMetricSource = {
  observedAt: number;
  metrics: DynamicMarketMetrics;
  provenance: Record<string, unknown>;
};

export type DynamicStrategyProviderDependencies = {
  rpcUrl?: string;
  pairAddress?: string;
  assetAddress?: string;
  baselineLiquidityUsd?: number;
  now?: () => number;
  readCandles?: (assetAddress: string, chainId: string, bar: string, limit: string) => Promise<unknown>;
  readGasPriceGwei?: (rpcUrl: string, now: number) => Promise<number>;
  readPairLiquidityUsd?: (rpcUrl: string, pairAddress: string, now: number) => Promise<{ usd: number; reserveTimestamp: number }>;
};

export class DynamicStrategyProviderError extends Error {
  readonly code: "PROVIDER_DISABLED" | "PROVIDER_UNAVAILABLE" | "INVALID_PROVENANCE";
  constructor(code: "PROVIDER_DISABLED" | "PROVIDER_UNAVAILABLE" | "INVALID_PROVENANCE", message: string) {
    super(message);
    this.code = code;
    this.name = "DynamicStrategyProviderError";
  }
}

export async function collectLiveDynamicMetrics(
  dependencies: DynamicStrategyProviderDependencies = {},
): Promise<LiveDynamicMetricSource> {
  const rpcUrl = dependencies.rpcUrl ?? process.env.BSC_RPC_URL ?? process.env.NEXT_PUBLIC_BSC_RPC_URL;
  const pairAddress = dependencies.pairAddress ?? process.env.WOLV_DYNAMIC_PANCAKE_PAIR_ADDRESS;
  const assetAddress = dependencies.assetAddress ?? process.env.WOLV_DYNAMIC_ASSET_ADDRESS;
  const now = dependencies.now ?? Date.now;
  const observedAt = now();

  if (!rpcUrl || !pairAddress) {
    throw new DynamicStrategyProviderError(
      "PROVIDER_DISABLED",
      "Live dynamic metrics require BSC_RPC_URL and WOLV_DYNAMIC_PANCAKE_PAIR_ADDRESS.",
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(pairAddress)) {
    throw new DynamicStrategyProviderError("INVALID_PROVENANCE", "The configured PancakeSwap pair address is invalid.");
  }
  if (!assetAddress || !/^0x[a-fA-F0-9]{40}$/.test(assetAddress)) {
    throw new DynamicStrategyProviderError(
      "PROVIDER_DISABLED",
      "Live dynamic volatility requires WOLV_DYNAMIC_ASSET_ADDRESS.",
    );
  }
  const baselineLiquidityUsd = dependencies.baselineLiquidityUsd;
  if (!Number.isFinite(baselineLiquidityUsd) || !baselineLiquidityUsd || baselineLiquidityUsd <= 0) {
    throw new DynamicStrategyProviderError(
      "INVALID_PROVENANCE",
      "A verified liquidity baseline is unavailable.",
    );
  }

  try {
    const [gasPriceGwei, pair] = await Promise.all([
      dependencies.readGasPriceGwei ? dependencies.readGasPriceGwei(rpcUrl, observedAt) : readGasPriceGwei(rpcUrl),
      dependencies.readPairLiquidityUsd
        ? dependencies.readPairLiquidityUsd(rpcUrl, pairAddress, observedAt)
        : readPairLiquidityUsd(rpcUrl, pairAddress, observedAt),
    ]);
    if (!Number.isFinite(pair.usd) || pair.usd <= 0 ||
      !Number.isSafeInteger(pair.reserveTimestamp) || pair.reserveTimestamp <= 0 ||
      observedAt - pair.reserveTimestamp > 60_000 ||
      pair.reserveTimestamp > observedAt + 30_000) {
      throw new DynamicStrategyProviderError(
        "INVALID_PROVENANCE",
        "PancakeSwap liquidity is missing, stale, or contradictory.",
      );
    }
    const candleResponse = await (dependencies.readCandles ?? readCandles)(assetAddress, "56", "1h", "48");
    const atrBps = calculateAtrBps(candleResponse, observedAt);
    if (!Number.isFinite(atrBps) || atrBps < 0) {
      throw new DynamicStrategyProviderError("INVALID_PROVENANCE", "ATR could not be verified from Binance candle data.");
    }
    const metrics = {
      observedAt,
      pancakeLiquidityUsd: pair.usd,
      baselineLiquidityUsd,
      gasPriceGwei,
      atrBps,
    };
    return {
      observedAt,
      metrics,
      provenance: {
        chainId: 56,
        gasSource: rpcUrl.replace(/\/\/[^@]*@/, "//redacted@"),
        liquiditySource: `PancakeSwap pair ${pairAddress}`,
        liquidityReserveTimestamp: pair.reserveTimestamp,
        baselineSource: "previous_verified_dynamic_cycle_or_explicit_environment_baseline",
        atrSource: "binance_web3_market_api_candles_1h",
        assetAddress,
      },
    };
  } catch (error) {
    if (error instanceof DynamicStrategyProviderError) throw error;
    throw new DynamicStrategyProviderError(
      "PROVIDER_UNAVAILABLE",
      error instanceof Error ? error.message.slice(0, 500) : "Live dynamic providers were unavailable.",
    );
  }
}

async function readGasPriceGwei(rpcUrl: string): Promise<number> {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 8_000 }) });
  const gas = await client.getGasPrice();
  return Number(formatUnits(gas, 9));
}

async function readCandles(
  assetAddress: string,
  chainId: string,
  bar: string,
  limit: string,
): Promise<unknown> {
  const url = new URL("https://web3.binance.com/build/api/v1/dex/market/candles");
  url.searchParams.set("binanceChainId", chainId);
  url.searchParams.set("tokenContractAddress", assetAddress);
  url.searchParams.set("bar", bar);
  url.searchParams.set("limit", limit);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Binance candle provider returned HTTP ${response.status}.`);
  return await response.json();
}

async function readPairLiquidityUsd(rpcUrl: string, pairAddress: string, now: number): Promise<{ usd: number; reserveTimestamp: number }> {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 8_000 }) });
  const [token0, token1, reserves] = await Promise.all([
    client.readContract({ address: pairAddress as `0x${string}`, abi: PAIR_ABI, functionName: "token0" }),
    client.readContract({ address: pairAddress as `0x${string}`, abi: PAIR_ABI, functionName: "token1" }),
    client.readContract({ address: pairAddress as `0x${string}`, abi: PAIR_ABI, functionName: "getReserves" }),
  ]);
  const addresses = new Set([token0.toLowerCase(), token1.toLowerCase()]);
  if (!addresses.has(USDT_ADDRESS.toLowerCase()) || !addresses.has(WBNB_ADDRESS.toLowerCase())) {
    throw new Error("PancakeSwap pair must contain USDT and WBNB.");
  }
  const [reserve0, reserve1, reserveTimestamp] = reserves;
  if (token0.toLowerCase() !== USDT_ADDRESS.toLowerCase() &&
    token0.toLowerCase() !== WBNB_ADDRESS.toLowerCase()) {
    throw new Error("PancakeSwap pair contains unsupported assets.");
  }
  if (token0.toLowerCase() === USDT_ADDRESS.toLowerCase()) {
    const usdtReserve = Number(formatUnits(reserve0, 18));
    const reserveTimestampMs = Number(reserveTimestamp) * 1000;
    if (now - reserveTimestampMs > 60_000 || reserveTimestampMs > now + 30_000) {
      throw new Error("PancakeSwap reserves are stale or contradictory.");
    }
    return { usd: usdtReserve * 2, reserveTimestamp: reserveTimestampMs };
  }
  const usdtReserve = Number(formatUnits(reserve1, 18));
  const reserveTimestampMs = Number(reserveTimestamp) * 1000;
  if (now - reserveTimestampMs > 60_000 || reserveTimestampMs > now + 30_000) {
    throw new Error("PancakeSwap reserves are stale or contradictory.");
  }
  return { usd: usdtReserve * 2, reserveTimestamp: reserveTimestampMs };
}

function calculateAtrBps(response: unknown, now: number): number {
  const rows = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.data)
      ? response.data
      : isRecord(response) && isRecord(response.data) && Array.isArray(response.data.klineInfos)
        ? response.data.klineInfos
        : isRecord(response) && Array.isArray(response.klineInfos)
          ? response.klineInfos
          : [];
  let latestTimestamp = 0;
  const candles = rows.slice(-48).flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const high = numeric(row[1]);
    const low = numeric(row[2]);
    const close = numeric(row[3]);
    const timestamp = numeric(row[5]);
    if (high === null || low === null || close === null || timestamp === null || high <= 0 || low <= 0 || close <= 0 || low > high) return [];
    const ms = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    latestTimestamp = Math.max(latestTimestamp, ms);
    return ms <= now + 30_000 ? [{ high, low, close }] : [];
  });
  if (candles.length < 14) return Number.NaN;
  if (latestTimestamp < now - 90 * 60_000 || latestTimestamp > now + 30_000) return Number.NaN;
  let total = 0;
  let previousClose = candles[0].close;
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (previousClose > 0) total += (trueRange / previousClose) * 10_000;
    previousClose = candle.close;
  }
  return total / (candles.length - 1);
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
