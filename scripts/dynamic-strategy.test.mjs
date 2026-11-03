import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDynamicStrategy,
  isUSRegularMarketSession,
  validateDynamicMarketMetrics,
} from "../lib/dynamicStrategy.ts";
import {
  collectLiveDynamicMetrics,
  DynamicStrategyProviderError,
} from "../services/dynamicStrategyProvider.ts";

const NOW = Date.parse("2026-11-03T15:00:00.000Z");

test("classifies verified US regular trading hours as peak defense", () => {
  assert.equal(isUSRegularMarketSession(NOW), true);
  const decision = evaluateDynamicStrategy({
    observedAt: NOW,
    pancakeLiquidityUsd: 1_000_000,
    baselineLiquidityUsd: 1_000_000,
    gasPriceGwei: 3,
    atrBps: 120,
  }, NOW);
  assert.equal(decision.mode, "PEAK_DEFENSE");
  assert.equal(decision.profile.maxSlippageBps, 30);
  assert.equal(decision.profile.maxOrderBnb, 0.5);
  assert.equal(decision.action, "PROPOSE");
  assert.equal(decision.executionEnabled, false);
});

test("classifies closed market with a verified liquidity drop as monitoring-only alpha mode", () => {
  const observedAt = Date.parse("2026-11-03T02:14:00.000Z");
  const decision = evaluateDynamicStrategy({
    observedAt,
    pancakeLiquidityUsd: 816_000,
    baselineLiquidityUsd: 1_000_000,
    gasPriceGwei: 3,
    atrBps: 180,
  }, observedAt);
  assert.equal(decision.mode, "OFF_HOURS_ALPHA");
  assert.equal(decision.marketSession, "US_CLOSED");
  assert.equal(decision.liquidityChangePercent, -18.4);
  assert.equal(decision.profile.maxSlippageBps, 100);
  assert.equal(decision.action, "MONITOR");
  assert.equal(decision.executionEnabled, false);
});

test("rejects stale, future, excessive gas, or invalid market metrics", () => {
  const base = {
    observedAt: NOW,
    pancakeLiquidityUsd: 1_000_000,
    baselineLiquidityUsd: 1_000_000,
    gasPriceGwei: 3,
    atrBps: 120,
  };
  assert.ok(validateDynamicMarketMetrics(base, NOW).length === 0);
  assert.ok(validateDynamicMarketMetrics({ ...base, observedAt: NOW - 61_000 }, NOW)[0].includes("stale"));
  assert.ok(validateDynamicMarketMetrics({ ...base, observedAt: NOW + 31_000 }, NOW)[0].includes("future"));
  assert.ok(validateDynamicMarketMetrics({ ...base, gasPriceGwei: 21 }, NOW)[0].includes("Gas"));
});

test("peak defense rejects high volatility and high-liquidity collapse", () => {
  const highVolatility = evaluateDynamicStrategy({
    observedAt: NOW,
    pancakeLiquidityUsd: 1_000_000,
    baselineLiquidityUsd: 1_000_000,
    gasPriceGwei: 3,
    atrBps: 301,
  }, NOW);
  assert.deepEqual(highVolatility.reasons, ["Volatility exceeds the peak-defense threshold."]);

  const liquidityCollapse = evaluateDynamicStrategy({
    observedAt: NOW,
    pancakeLiquidityUsd: 840_000,
    baselineLiquidityUsd: 1_000_000,
    gasPriceGwei: 3,
    atrBps: 100,
  }, NOW);
  assert.deepEqual(liquidityCollapse.reasons, ["Liquidity dropped sharply during the US regular session."]);
});

test("live provider rejects missing baseline and missing live configuration", async () => {
  await assert.rejects(
    collectLiveDynamicMetrics({ rpcUrl: "", pairAddress: "", assetAddress: "", baselineLiquidityUsd: 1_000_000 }),
    (error) => error instanceof DynamicStrategyProviderError && error.code === "PROVIDER_DISABLED",
  );
  await assert.rejects(
    collectLiveDynamicMetrics({
      rpcUrl: "https://bsc.example",
      pairAddress: "0x1234567890123456789012345678901234567890",
      assetAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    }),
    (error) => error instanceof DynamicStrategyProviderError && error.code === "INVALID_PROVENANCE",
  );
});

test("live provider combines mocked RPC gas, pair liquidity, and candle ATR", async () => {
  const candles = [
    ...Array.from({ length: 20 }, (_, index) => [
      100, 101, 99, 100.5, 10, NOW - (20 - index) * 60 * 60 * 1000, 4,
    ]),
    [100.5, 102, 99.5, 101, 10, NOW - 60 * 60 * 1000, 4],
  ];
  const source = await collectLiveDynamicMetrics({
    rpcUrl: "https://bsc.example",
    pairAddress: "0x1234567890123456789012345678901234567890",
    assetAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    baselineLiquidityUsd: 900_000,
    now: () => NOW,
    readGasPriceGwei: async () => 3,
    readPairLiquidityUsd: async () => ({ usd: 816_000, reserveTimestamp: NOW }),
    readCandles: async () => ({ data: { klineInfos: candles } }),
  });
  assert.equal(source.metrics.observedAt, NOW);
  assert.equal(source.metrics.pancakeLiquidityUsd, 816_000);
  assert.equal(source.metrics.baselineLiquidityUsd, 900_000);
  assert.equal(source.metrics.gasPriceGwei, 3);
  assert.ok(source.metrics.atrBps >= 0);
  assert.equal(source.provenance.chainId, 56);
});
