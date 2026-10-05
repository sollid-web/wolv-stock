import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityRow, buildVenueResult, getCrossListedPairs, marketLabel, normalizePerSharePrice, positiveNumberValue } from "../lib/opportunityMath.ts";

const now = 100_000;

function asset(overrides = {}) {
  return {
    tokenContractAddress: "0x0000000000000000000000000000000000000001",
    underlyingTicker: "WOLV",
    platformId: "ondo",
    tokenToShareRatio: 2,
    referencePrice: 200,
    volume24H: 100,
    statusInfo: { marketStatus: "open" },
    ...overrides,
  };
}

function quote(usd, ts = now) {
  return { ok: true, usd, mode: "SWAP", vendor: "test", impact: 0.1, ts };
}

test("normalizes executable and reference values to per-share prices", () => {
  const result = buildVenueResult(asset(), quote(220), now);
  assert.equal(result.multiplier, 2);
  assert.equal(result.referencePerShare, 100);
  assert.equal(result.executablePerShare, 110);
  assert.ok(Math.abs(result.referenceGap - 10) < 1e-9);
  assert.equal(result.stale, false);
  assert.equal(result.unreliable, false);
});

test("excludes stale, over-cap, and reference-missing quotes from reliable spread", () => {
  const good = buildVenueResult(asset({ platformId: "ondo" }), quote(200), now);
  const stale = buildVenueResult(asset({ platformId: "bstock" }), quote(202, now - 30_001), now);
  const outlier = buildVenueResult(asset({ platformId: "venue-c" }), quote(250), now);
  const noReference = buildVenueResult(asset({ platformId: "venue-d", referencePrice: null }), quote(201), now);

  assert.equal(outlier.unreliable, true);
  assert.equal(noReference.referenceGap, null);
  assert.equal(buildOpportunityRow("WOLV", [good, stale]).crossVenueSpread, null);
  assert.equal(buildOpportunityRow("WOLV", [good, outlier]).crossVenueSpread, null);
  assert.equal(buildOpportunityRow("WOLV", [good, noReference]).crossVenueSpread, null);
});

test("computes spread only across at least two fresh, reliable, reference-backed venues", () => {
  const low = buildVenueResult(asset({ platformId: "ondo" }), quote(200), now);
  const high = buildVenueResult(asset({ platformId: "bstock" }), quote(210), now);
  const row = buildOpportunityRow("WOLV", [low, high]);
  assert.ok(Math.abs(row.crossVenueSpread - 5) < 1e-9);
});

test("reports market-status mismatch without suppressing the caution", () => {
  const open = buildVenueResult(asset({ statusInfo: { marketStatus: "open" } }), quote(200), now);
  const closed = buildVenueResult(asset({ platformId: "bstock", statusInfo: { marketStatus: "closed" } }), quote(201), now);
  const row = buildOpportunityRow("WOLV", [open, closed]);
  assert.equal(row.statusMismatch, true);
  assert.deepEqual(row.statuses, ["open", "closed"]);
});

test("groups distinct venues and ranks pairs by their highest venue volume", () => {
  const pairs = getCrossListedPairs([
    asset({ underlyingTicker: "LOW", platformId: "ondo", volume24H: 20 }),
    asset({ underlyingTicker: "LOW", platformId: "bstock", volume24H: 30 }),
    asset({ underlyingTicker: "HIGH", platformId: "ondo", volume24H: 90 }),
    asset({ underlyingTicker: "HIGH", platformId: "bstock", volume24H: 80 }),
    asset({ underlyingTicker: "SINGLE", platformId: "ondo", volume24H: 999 }),
  ]);
  assert.deepEqual(pairs.map((pair) => pair.ticker), ["HIGH", "LOW"]);
});

test("missing or non-positive share ratios and prices stay unavailable and cannot enter a spread", () => {
  const good = buildVenueResult(asset({ platformId: "ondo" }), quote(200), now);
  for (const ratio of [undefined, null, 0, "0", ""]) {
    const incomplete = buildVenueResult(asset({ platformId: `missing-${String(ratio)}`, tokenToShareRatio: ratio }), quote(201), now);
    assert.equal(incomplete.multiplier, null);
    assert.equal(incomplete.referencePerShare, null);
    assert.equal(incomplete.executablePerShare, null);
    assert.equal(incomplete.referenceGap, null);
    assert.equal(buildOpportunityRow("WOLV", [good, incomplete]).crossVenueSpread, null);
  }
  assert.equal(normalizePerSharePrice(200, undefined), null);
  assert.equal(normalizePerSharePrice(200, 0), null);
  assert.equal(normalizePerSharePrice(undefined, 2), null);
  assert.equal(normalizePerSharePrice(0, 2), null);
  assert.equal(positiveNumberValue(""), null);
  assert.equal(normalizePerSharePrice(Number.MAX_VALUE, Number.MIN_VALUE), null);
});

test("unknown market status remains unavailable rather than defaulting to closed", () => {
  assert.equal(marketLabel(asset({ statusInfo: undefined })), "status unavailable");
  assert.equal(marketLabel(asset({ statusInfo: { openState: undefined, marketStatus: null } })), "status unavailable");
  assert.equal(marketLabel(asset({ statusInfo: { openState: false } })), "closed");
  for (const marketStatus of ["UNKNOWN", "n/a", "unavailable", "unspecified", "pending", "—"]) {
    assert.equal(marketLabel(asset({ statusInfo: { openState: undefined, marketStatus } })), "status unavailable");
  }
});
