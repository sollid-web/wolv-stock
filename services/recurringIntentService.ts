import "server-only";
import { createHash } from "node:crypto";
import { BSC_USDT_ADDRESS, usdtAmountToWei } from "../lib/apiValidation.ts";
import type { QuoteAndSwapTransaction } from "../lib/binance.ts";
import type { AgentMemoryStorePort } from "./agentMemoryStore.ts";
import {
  assertAutonomousRfqUnavailable,
  RfqOrderServiceError,
} from "./rfqOrderService.ts";

export const DCA_MARKET_EVIDENCE_MAX_AGE_MS = 3_000;
const MAX_STRATEGY_CONFIG_BYTES = 16_384;
const MAX_ROLLING_WINDOW_SECONDS = 31_536_000;

export type DcaExecutionMode = "MANUAL" | "AUTONOMOUS";

export type DcaSchedule = {
  scheduleId: string;
  name: string;
  enabled: boolean;
  intervalSeconds: number;
  policyHash: string;
  strategyType: string;
  executionMode: DcaExecutionMode;
  strategyConfig: Record<string, unknown>;
  nextRunAt: number;
};

export type DcaStrategyConfig = {
  ticker: string;
  tokenAddress: string;
  amount: string;
  maxPerRun: string;
  maxRollingExposure: string;
  rollingWindowSeconds: number;
  maxPriceDeviationPercent: number;
  autonomousEnabled: boolean;
};

export type DcaMarketEvidence = {
  ticker: string;
  tokenAddress: string;
  sessionMismatch: boolean;
  referenceGapPercent: number;
  observedAt: number;
};

export type DcaCandidate = Readonly<{
  ownerAddress: string;
  scheduleId: string;
  scheduleName: string;
  policyHash: string;
  runKey: string;
  mode: DcaExecutionMode;
  config: DcaStrategyConfig;
  transaction: QuoteAndSwapTransaction["tx"];
  expectedOutputs: QuoteAndSwapTransaction["expectedOutputs"];
  observedAt: number;
  issuedAt: number;
  expiresAt: number;
  referenceGapPercent: number;
  rollingExposureAfterRun: string;
}>;

export type DcaEvaluation =
  | { scheduleId: string; runKey: string; status: "REJECTED"; reason: string }
  | { scheduleId: string; runKey: string; status: "READY"; candidate: DcaCandidate };

export type RecurringIntentDependencies = {
  now?: () => number;
  loadMarketEvidence?: (
    ticker: string,
    tokenAddress: string,
    ownerAddress: string,
  ) => Promise<DcaMarketEvidence>;
  buildQuote?: (
    binanceChainId: string,
    amount: string,
    fromTokenAddress: string,
    toTokenAddress: string,
    userWalletAddress: string,
    vendor: string,
  ) => Promise<QuoteAndSwapTransaction>;
  simulate?: (from: string, to: string, data: string, value: string) => Promise<unknown>;
};

export function createDcaRunKey(ownerAddress: string, scheduleId: string, dueAt: number): string {
  if (!isEvmAddress(ownerAddress) || !isUuid(scheduleId) ||
    !Number.isSafeInteger(dueAt) || dueAt <= 0) {
    throw new TypeError("DCA idempotency key inputs are invalid.");
  }
  return createHash("sha256")
    .update(`${ownerAddress.toLowerCase()}:${scheduleId}:${dueAt}`)
    .digest("hex");
}

export function parseDcaStrategyConfig(value: unknown): DcaStrategyConfig {
  if (!isRecord(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_STRATEGY_CONFIG_BYTES ||
    Object.keys(value).some((key) => ![
      "ticker",
      "tokenAddress",
      "amount",
      "maxPerRun",
      "maxRollingExposure",
      "rollingWindowSeconds",
      "maxPriceDeviationPercent",
      "autonomousEnabled",
    ].includes(key))) {
    throw new TypeError("DCA strategy configuration must be a valid object within 16 KB.");
  }
  const {
    ticker,
    tokenAddress,
    amount,
    maxPerRun,
    maxRollingExposure,
    rollingWindowSeconds,
    maxPriceDeviationPercent,
    autonomousEnabled,
  } = value;
  if (typeof ticker !== "string" || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(ticker) ||
    typeof tokenAddress !== "string" || !isEvmAddress(tokenAddress) ||
    typeof amount !== "string" || !isUsdtAmount(amount) ||
    typeof maxPerRun !== "string" || !isUsdtAmount(maxPerRun) ||
    typeof maxRollingExposure !== "string" || !isUsdtAmount(maxRollingExposure) ||
    typeof rollingWindowSeconds !== "number" || !Number.isSafeInteger(rollingWindowSeconds) ||
    rollingWindowSeconds < 60 || rollingWindowSeconds > MAX_ROLLING_WINDOW_SECONDS ||
    typeof maxPriceDeviationPercent !== "number" || !Number.isFinite(maxPriceDeviationPercent) ||
    maxPriceDeviationPercent < 0 || maxPriceDeviationPercent > 10 ||
    typeof autonomousEnabled !== "boolean") {
    throw new TypeError("DCA strategy configuration is missing valid ticker, token, amount, risk limits, or gates.");
  }

  const amountUnits = BigInt(usdtAmountToWei(amount));
  const maxPerRunUnits = BigInt(usdtAmountToWei(maxPerRun));
  const maxRollingUnits = BigInt(usdtAmountToWei(maxRollingExposure));
  if (amountUnits > maxPerRunUnits || maxPerRunUnits > maxRollingUnits) {
    throw new TypeError("DCA amount must not exceed the per-run limit, which must not exceed the rolling limit.");
  }

  return {
    ticker,
    tokenAddress,
    amount,
    maxPerRun,
    maxRollingExposure,
    rollingWindowSeconds,
    maxPriceDeviationPercent,
    autonomousEnabled,
  };
}

export async function evaluateDueRecurringIntents(
  input: {
    ownerAddress: string;
    store: Pick<AgentMemoryStorePort, "listSchedules" | "getDcaRollingExposure">;
    schedules?: Array<Record<string, unknown>>;
    now?: number;
  },
  dependencies: RecurringIntentDependencies = {},
): Promise<DcaEvaluation[]> {
  const ownerAddress = input.ownerAddress.toLowerCase();
  if (!isEvmAddress(ownerAddress)) throw new TypeError("DCA owner address is invalid.");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("DCA evaluation time is invalid.");

  const claimedSchedules = input.schedules !== undefined;
  const schedules = input.schedules ?? await input.store.listSchedules(ownerAddress, 100);
  const normalizedSchedules: Array<Record<string, unknown>> = claimedSchedules
    ? schedules.map((schedule) => ({
        ...schedule,
        enabled: true,
        nextRunAt: schedule.lastRunAt,
      }))
    : schedules;
  const eligible = normalizedSchedules
    .filter((schedule) => isDueDcaSchedule(schedule) && Number(schedule.nextRunAt) <= now)
    .sort((a, b) => Number(a.nextRunAt) - Number(b.nextRunAt));
  const results: DcaEvaluation[] = [];

  for (const rawSchedule of eligible) {
    const scheduleId = String(rawSchedule.scheduleId);
    const runKey = createDcaRunKey(ownerAddress, scheduleId, Number(rawSchedule.nextRunAt));
    let schedule: DcaSchedule;
    try {
      schedule = normalizeSchedule(rawSchedule);
    } catch (error) {
      results.push(rejected(scheduleId, runKey, errorMessage(error)));
      continue;
    }
    let config: DcaStrategyConfig;
    try {
      config = parseDcaStrategyConfig(schedule.strategyConfig);
    } catch (error) {
      results.push(rejected(schedule.scheduleId, runKey, errorMessage(error)));
      continue;
    }

    try {
      const rollingExposure = await input.store.getDcaRollingExposure(
        ownerAddress,
        now - config.rollingWindowSeconds * 1_000,
      );
      if (!isUsdtAmountOrZero(rollingExposure)) {
        results.push(rejected(schedule.scheduleId, runKey, "Rolling exposure data is invalid."));
        continue;
      }
      const amountUnits = BigInt(usdtAmountToWei(config.amount));
      const rollingUnits = usdtAmountUnits(rollingExposure);
      const rollingLimitUnits = BigInt(usdtAmountToWei(config.maxRollingExposure));
      if (rollingUnits + amountUnits > rollingLimitUnits) {
        results.push(rejected(schedule.scheduleId, runKey, "The DCA run would exceed its rolling exposure limit."));
        continue;
      }

      const market = await (dependencies.loadMarketEvidence ?? loadMarketEvidence)(
        config.ticker,
        config.tokenAddress,
        ownerAddress,
      );
      const checkedAt = (dependencies.now ?? Date.now)();
      if (market.ticker !== config.ticker ||
        market.tokenAddress.toLowerCase() !== config.tokenAddress.toLowerCase() ||
        typeof market.sessionMismatch !== "boolean" ||
        !Number.isFinite(market.referenceGapPercent) ||
        !Number.isSafeInteger(market.observedAt)) {
        results.push(rejected(schedule.scheduleId, runKey, "Market evidence does not match the DCA asset configuration."));
        continue;
      }
      const marketAge = checkedAt - market.observedAt;
      if (marketAge < 0 || marketAge > DCA_MARKET_EVIDENCE_MAX_AGE_MS) {
        results.push(rejected(schedule.scheduleId, runKey, "Market evidence is older than the 3-second freshness limit."));
        continue;
      }
      if (market.sessionMismatch) {
        results.push(rejected(schedule.scheduleId, runKey, "Market session mismatch vetoed the DCA run."));
        continue;
      }
      if (Math.abs(market.referenceGapPercent) > config.maxPriceDeviationPercent) {
        results.push(rejected(schedule.scheduleId, runKey, "Market reference deviation exceeds the configured bound."));
        continue;
      }

      const buildQuote = dependencies.buildQuote ?? (await import("../lib/binance.ts")).buildQuoteAndSwapTransaction;
      const quote = await buildQuote(
        "56",
        usdtAmountToWei(config.amount),
        BSC_USDT_ADDRESS,
        config.tokenAddress,
        ownerAddress,
        "LiquidMesh",
      );
      if (quote.executionMode !== "SWAP") {
        if (schedule.executionMode === "AUTONOMOUS") {
          assertAutonomousRfqUnavailable();
        }
        results.push(rejected(schedule.scheduleId, runKey, "The quote requires RFQ execution; the DCA swap path is blocked."));
        continue;
      }
      const quoteFetchedAt = (dependencies.now ?? Date.now)();
      const simulate = dependencies.simulate ?? (await import("../lib/binance.ts")).simulateBscTransaction;
      const simulation = await simulate(
        quote.tx.from,
        quote.tx.to,
        quote.tx.data,
        quote.tx.value,
      );
      const simulationData = isRecord(simulation) && isRecord(simulation.data) ? simulation.data : null;
      if (typeof simulationData?.status !== "string" ||
        simulationData.status.toUpperCase() !== "SUCCESS") {
        results.push(rejected(schedule.scheduleId, runKey, "Fresh transaction simulation did not succeed."));
        continue;
      }

      const issuedAt = quoteFetchedAt;
      const checkedAtAfterSimulation = (dependencies.now ?? Date.now)();
      if (checkedAtAfterSimulation - quoteFetchedAt > DCA_MARKET_EVIDENCE_MAX_AGE_MS) {
        results.push(rejected(schedule.scheduleId, runKey, "The Flash quote expired before simulation completed."));
        continue;
      }
      const finalMarketAge = checkedAtAfterSimulation - market.observedAt;
      if (finalMarketAge < 0 || finalMarketAge > DCA_MARKET_EVIDENCE_MAX_AGE_MS) {
        results.push(rejected(schedule.scheduleId, runKey, "Market evidence expired while the transaction was being built."));
        continue;
      }
      results.push({
        scheduleId: schedule.scheduleId,
        runKey,
        status: "READY",
        candidate: Object.freeze({
          ownerAddress,
          scheduleId: schedule.scheduleId,
          scheduleName: schedule.name,
          policyHash: schedule.policyHash,
          runKey,
          mode: schedule.executionMode,
          config,
          transaction: quote.tx,
          expectedOutputs: quote.expectedOutputs,
          observedAt: market.observedAt,
          issuedAt,
          expiresAt: Math.min(
            issuedAt + DCA_MARKET_EVIDENCE_MAX_AGE_MS,
            market.observedAt + DCA_MARKET_EVIDENCE_MAX_AGE_MS,
          ),
          referenceGapPercent: market.referenceGapPercent,
          rollingExposureAfterRun: formatUsdtUnits(rollingUnits + amountUnits),
        }),
      });
    } catch (error) {
      if (error instanceof RfqOrderServiceError && error.code === "AUTONOMOUS_RFQ_UNAVAILABLE") {
        throw error;
      }
      results.push(rejected(
        schedule.scheduleId,
        runKey,
        `DCA evaluation failed closed: ${errorMessage(error)}`,
      ));
    }
  }
  return results;
}

async function loadMarketEvidence(
  ticker: string,
  tokenAddress: string,
  ownerAddress: string,
): Promise<DcaMarketEvidence> {
  const requestedAt = Date.now();
  const [
    { getAggregatorQuote, getRWATokenList },
    { isSpotEligibleAsset },
    { isRwaAssetListResponse, parseRwaAssetRecords },
    { validateQuote },
  ] = await Promise.all([
    import("../lib/binance.ts"),
    import("../lib/compliance.ts"),
    import("../lib/rwaAssetResponse.ts"),
    import("../lib/quoteValidation.ts"),
  ]);
  const [registryResponse, quoteResponse]: [unknown, unknown] = await Promise.all([
    getRWATokenList(),
    getAggregatorQuote(tokenAddress, "100000000000000000000", ownerAddress),
  ]);
  if (!isRwaAssetListResponse(registryResponse)) {
    throw new Error("The verified RWA registry is unavailable or malformed.");
  }
  const eligibleAssets = parseRwaAssetRecords(registryResponse).filter(isSpotEligibleAsset);
  const asset = eligibleAssets.find((entry) =>
    entry.tokenContractAddress.toLowerCase() === tokenAddress.toLowerCase() &&
    entry.underlyingTicker.toUpperCase() === ticker,
  );
  if (!asset) throw new Error("The configured token is not a verified spot-eligible RWA asset.");

  const referencePrice = positiveNumber(asset.referencePrice);
  const shareRatio = positiveNumber(asset.tokenToShareRatio);
  if (referencePrice === null || shareRatio === null || !isRecord(quoteResponse) ||
    !Array.isArray(quoteResponse.data)) {
    throw new Error("Verified RWA reference-price or quote data is unavailable.");
  }

  const expectedFromAmount = "100000000000000000000";
  const routes = quoteResponse.data.filter((route) =>
    isRecord(route) && route.binanceChainId === "56" &&
    route.fromTokenAmount === expectedFromAmount &&
    isRecord(route.fromToken) && isRecord(route.toToken) &&
    typeof route.fromToken.tokenContractAddress === "string" &&
    route.fromToken.tokenContractAddress.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase() &&
    typeof route.toToken.tokenContractAddress === "string" &&
    route.toToken.tokenContractAddress.toLowerCase() === tokenAddress.toLowerCase(),
  );
  const validatedRoutes = routes.flatMap((route) => {
    if (!isRecord(route) || !isRecord(route.fromToken) || !isRecord(route.toToken)) return [];
    const validation = validateQuote({
      fromTokenAmount: route.fromTokenAmount,
      toTokenAmount: route.toTokenAmount,
      fromTokenDecimals: route.fromToken.decimal,
      toTokenDecimals: route.toToken.decimal,
      tokenUnitPrice: route.fromToken.tokenUnitPrice,
      expectedFromTokenAmount: expectedFromAmount,
    });
    return validation.ok && typeof route.toTokenAmount === "string" &&
      /^\d{1,78}$/.test(route.toTokenAmount)
      ? [{ validation, outputAmount: BigInt(route.toTokenAmount) }]
      : [];
  });
  const bestRoute = validatedRoutes.sort((a, b) =>
    a.outputAmount > b.outputAmount ? -1 : a.outputAmount < b.outputAmount ? 1 : 0,
  )[0];
  if (!bestRoute) throw new Error("Binance did not return a valid quote for the configured RWA token.");

  const referencePerShare = referencePrice / shareRatio;
  const executablePerShare = bestRoute.validation.usd / shareRatio;
  const referenceGapPercent = (executablePerShare / referencePerShare - 1) * 100;
  if (!Number.isFinite(referenceGapPercent)) {
    throw new Error("The live quote could not be compared with the verified reference price.");
  }
  const statuses = Array.from(new Set(eligibleAssets
    .filter((entry) => entry.underlyingTicker.toUpperCase() === ticker)
    .map(venueStatus)
    .filter((status): status is string => status !== null)));
  return {
    ticker,
    tokenAddress,
    sessionMismatch: statuses.length > 1,
    referenceGapPercent,
    observedAt: requestedAt,
  };
}

function venueStatus(asset: {
  statusInfo?: { marketStatus?: string | null; openState?: boolean } | null;
}): string | null {
  const status = asset.statusInfo?.marketStatus?.trim().toLowerCase();
  if (status) return status;
  if (asset.statusInfo?.openState === true) return "open";
  if (asset.statusInfo?.openState === false) return "closed";
  return null;
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isDueDcaSchedule(value: Record<string, unknown>): boolean {
  return value.enabled === true && value.strategyType === "DCA" &&
    (value.executionMode === "MANUAL" || value.executionMode === "AUTONOMOUS") &&
    typeof value.nextRunAt === "number" && Number.isSafeInteger(value.nextRunAt) &&
    typeof value.scheduleId === "string" && isUuid(value.scheduleId);
}

function normalizeSchedule(value: Record<string, unknown>): DcaSchedule {
  if (typeof value.name !== "string" || typeof value.policyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.policyHash) || !isRecord(value.strategyConfig) ||
    (value.executionMode !== "MANUAL" && value.executionMode !== "AUTONOMOUS")) {
    throw new TypeError("Stored DCA schedule is malformed.");
  }
  return {
    scheduleId: String(value.scheduleId),
    name: value.name,
    enabled: true,
    intervalSeconds: Number(value.intervalSeconds),
    policyHash: value.policyHash,
    strategyType: "DCA",
    executionMode: value.executionMode,
    strategyConfig: value.strategyConfig,
    nextRunAt: Number(value.nextRunAt),
  };
}

function rejected(scheduleId: string, runKey: string, reason: string): DcaEvaluation {
  return { scheduleId, runKey, status: "REJECTED", reason };
}

function isUsdtAmount(value: string): boolean {
  try {
    return usdtAmountToWei(value) !== "0";
  } catch {
    return false;
  }
}

function isUsdtAmountOrZero(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value);
}

function usdtAmountUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * (BigInt(10) ** BigInt(18)) + BigInt(fraction.padEnd(18, "0"));
}

function formatUsdtUnits(units: bigint): string {
  const scale = BigInt(10) ** BigInt(18);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown validation error.";
}
