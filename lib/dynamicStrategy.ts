export type DynamicStrategyMode = "PEAK_DEFENSE" | "OFF_HOURS_ALPHA";
export type DynamicStrategyAction = "MONITOR" | "PROPOSE";

export type DynamicMarketMetrics = {
  observedAt: number;
  pancakeLiquidityUsd: number;
  baselineLiquidityUsd: number;
  gasPriceGwei: number;
  atrBps: number;
};

export type DynamicStrategyProfile = {
  mode: DynamicStrategyMode;
  maxSlippageBps: number;
  maxOrderBnb: number;
  cooldownSeconds: number;
  action: DynamicStrategyAction;
};

export type DynamicStrategyDecision = {
  mode: DynamicStrategyMode;
  liquidityChangePercent: number;
  marketSession: "US_REGULAR" | "US_CLOSED";
  profile: DynamicStrategyProfile;
  action: DynamicStrategyAction;
  accepted: boolean;
  reasons: string[];
  warnings: string[];
  executionEnabled: false;
};

const MAX_METRIC_AGE_MS = 60_000;
const PEAK_MAX_SLIPPAGE_BPS = 30;
const ALPHA_MAX_SLIPPAGE_BPS = 100;
const HARD_MAX_SLIPPAGE_BPS = 100;

export function validateDynamicMarketMetrics(
  metrics: DynamicMarketMetrics,
  now: number = Date.now(),
): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(metrics.observedAt) || metrics.observedAt <= 0 || now - metrics.observedAt > MAX_METRIC_AGE_MS) {
    errors.push("Market metrics timestamp is missing, invalid, or stale.");
  }
  if (metrics.observedAt > now + 30_000) errors.push("Market metrics timestamp is in the future.");
  if (!Number.isFinite(metrics.pancakeLiquidityUsd) || metrics.pancakeLiquidityUsd <= 0) {
    errors.push("PancakeSwap liquidity is missing or invalid.");
  }
  if (!Number.isFinite(metrics.baselineLiquidityUsd) || metrics.baselineLiquidityUsd <= 0) {
    errors.push("Liquidity baseline is missing or invalid.");
  }
  if (!Number.isFinite(metrics.gasPriceGwei) || metrics.gasPriceGwei <= 0) {
    errors.push("Gas price is missing or invalid.");
  } else if (metrics.gasPriceGwei > 20) {
    errors.push("Gas price exceeds the conservative execution threshold.");
  }
  if (!Number.isFinite(metrics.atrBps) || metrics.atrBps < 0 || metrics.atrBps > 10_000) {
    errors.push("ATR volatility is missing or invalid.");
  }
  return errors;
}

export function isUSRegularMarketSession(observedAt: number): boolean {
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime())) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return minutes >= 14 * 60 + 30 && minutes < 21 * 60;
}

export function evaluateDynamicStrategy(
  metrics: DynamicMarketMetrics,
  now: number = Date.now(),
): DynamicStrategyDecision {
  const reasons = validateDynamicMarketMetrics(metrics, now);
  const warnings: string[] = [];
  const marketSession = isUSRegularMarketSession(metrics.observedAt) ? "US_REGULAR" : "US_CLOSED";
  const liquidityChangePercent =
    metrics.baselineLiquidityUsd > 0
      ? ((metrics.pancakeLiquidityUsd - metrics.baselineLiquidityUsd) / metrics.baselineLiquidityUsd) * 100
      : 0;

  if (reasons.length === 0 && marketSession === "US_REGULAR") {
    if (metrics.atrBps > 300) reasons.push("Volatility exceeds the peak-defense threshold.");
    if (liquidityChangePercent < -15) reasons.push("Liquidity dropped sharply during the US regular session.");
  }

  const mode: DynamicStrategyMode =
    marketSession === "US_REGULAR" ? "PEAK_DEFENSE" : "OFF_HOURS_ALPHA";
  warnings.push("US exchange holidays and half-days are approximated by weekday UTC time only; no independent verified holiday calendar is currently connected.");
  const profile: DynamicStrategyProfile =
    mode === "PEAK_DEFENSE"
      ? {
        mode,
        maxSlippageBps: PEAK_MAX_SLIPPAGE_BPS,
        maxOrderBnb: 0.5,
        cooldownSeconds: 300,
        action: "PROPOSE",
      }
      : {
        mode,
        maxSlippageBps: ALPHA_MAX_SLIPPAGE_BPS,
        maxOrderBnb: 0.5,
        cooldownSeconds: 60,
        action: "MONITOR",
      };

  if (profile.maxSlippageBps > HARD_MAX_SLIPPAGE_BPS) {
    reasons.push("Profile slippage exceeds the hard policy cap.");
  }
  if (mode === "OFF_HOURS_ALPHA") {
    warnings.push("Off-hours mode starts in monitoring-only mode; cross-DEX sweep execution remains disabled.");
    if (liquidityChangePercent < -15) {
      warnings.push("Liquidity is more than 15 percent below baseline.");
    } else {
      reasons.push("Off-hours mode requires verified liquidity degradation before accumulation scanning.");
    }
  }

  return {
    mode,
    liquidityChangePercent: Number(liquidityChangePercent.toFixed(4)),
    marketSession,
    profile,
    action: reasons.length === 0 ? profile.action : "MONITOR",
    accepted: reasons.length === 0,
    reasons,
    warnings,
    executionEnabled: false,
  };
}
