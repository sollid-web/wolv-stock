import assert from "node:assert/strict";
import test from "node:test";
import {
  createAsyncRedemptionRequest,
  evaluateWeekendDefiPlan,
  isMainnetAutonomousDefiBlocked,
  isWeekendDefiAmountWithinCaps,
  parseWeekendDefiConfig,
} from "../services/weekendDefiRebalancer.ts";

const NOW = Date.parse("2026-03-09T14:00:00.000Z");
const CONFIG = {
  protocolId: "provider.protocol",
  investmentId: "a".repeat(64),
  allocationAmount: "50",
  maxPerDeposit: "50",
  maxAssetAllocation: "100",
  maxTotalAllocation: "200",
  riskCapBps: 2_500,
  investmentRiskBps: 1_000,
  guardTicker: "SPY",
};

function calendar(date, session, overrides = {}) {
  return {
    date,
    session,
    sessionStartUtcMinutes: session === "CLOSED" ? undefined : 13 * 60 + 30,
    sessionEndUtcMinutes: session === "CLOSED" ? undefined : 20 * 60,
    providerTimestamp: new Date(NOW).toISOString(),
    ...overrides,
  };
}

test("Weekend DeFi config enforces amount ordering, risk bounds, and exact fields", () => {
  assert.equal(parseWeekendDefiConfig(CONFIG).allocationAmount, "50");
  assert.equal(isWeekendDefiAmountWithinCaps(parseWeekendDefiConfig(CONFIG), "50"), true);
  assert.equal(isWeekendDefiAmountWithinCaps(parseWeekendDefiConfig(CONFIG), "50.01"), false);
  assert.throws(() => parseWeekendDefiConfig({ ...CONFIG, investmentRiskBps: 2_501 }));
  assert.throws(() => parseWeekendDefiConfig({ ...CONFIG, maxAssetAllocation: "25" }));
  assert.throws(() => parseWeekendDefiConfig({ ...CONFIG, unreviewed: true }));
});

test("deposit readiness requires fresh, verified closed market evidence", () => {
  const config = parseWeekendDefiConfig(CONFIG);
  const closed = evaluateWeekendDefiPlan({
    config,
    action: "DEPOSIT",
    currentCalendar: calendar("2026-03-08", "CLOSED"),
    now: NOW,
    sessionMismatch: true,
  });
  assert.equal(closed.allowed, true);
  assert.equal(closed.marketClosedAtEvaluation, true);
  assert.equal(closed.transactionSubmitted, false);
  assert.ok(closed.warnings.some((warning) => warning.includes("session mismatch")));

  const open = evaluateWeekendDefiPlan({
    config,
    action: "DEPOSIT",
    currentCalendar: calendar("2026-03-09", "OPEN", { sessionEndUtcMinutes: 20 * 60 }),
    now: NOW,
  });
  assert.equal(open.allowed, false);
  assert.match(open.blockers.join(" "), /market-closed/);

  const stale = evaluateWeekendDefiPlan({
    config,
    action: "DEPOSIT",
    currentCalendar: calendar("2026-03-08", "CLOSED", {
      providerTimestamp: new Date(NOW - 7 * 60 * 60_000).toISOString(),
    }),
    now: NOW,
  });
  assert.equal(stale.allowed, false);
});

test("redemption readiness requires a fresh closed-to-open calendar transition", () => {
  const config = parseWeekendDefiConfig(CONFIG);
  const ready = evaluateWeekendDefiPlan({
    config,
    action: "REDEEM",
    currentCalendar: calendar("2026-03-09", "OPEN"),
    previousCalendar: calendar("2026-03-08", "CLOSED"),
    now: NOW,
  });
  assert.equal(ready.allowed, true);
  assert.equal(ready.transactionSubmitted, false);

  const noTransition = evaluateWeekendDefiPlan({
    config,
    action: "REDEEM",
    currentCalendar: calendar("2026-03-10", "OPEN"),
    previousCalendar: calendar("2026-03-09", "OPEN"),
    now: NOW,
  });
  assert.equal(noTransition.allowed, false);
});

test("redeem delay is surfaced as asynchronous and never promises market-open liquidity", () => {
  const request = createAsyncRedemptionRequest({
    requestedAt: NOW,
    redeemDelayDays: ["2", "5"],
    providerWarnings: [{ code: "DELAY", level: "WARNING", message: "Provider settlement delay applies." }],
  });
  assert.equal(request.status, "ASYNC_REQUEST_PREPARED");
  assert.equal(request.earliestExpectedAt, NOW + 2 * 24 * 60 * 60_000);
  assert.equal(request.latestExpectedAt, NOW + 5 * 24 * 60 * 60_000);
  assert.equal(request.guaranteedLiquidByMarketOpen, false);
  assert.ok(request.warnings.some((warning) => warning.includes("not guaranteed")));
  assert.throws(() => createAsyncRedemptionRequest({
    requestedAt: NOW,
    redeemDelayDays: ["5", "2"],
    providerWarnings: [],
  }));
  assert.equal(isMainnetAutonomousDefiBlocked({ chainId: 56, delegatedPolicyChainId: 97 }), true);
});
