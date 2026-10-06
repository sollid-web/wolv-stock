import assert from "node:assert/strict";
import test from "node:test";
import { buildRulesAnalysis, normalizeModelSummary, parseAnalysisRequest, readBoundedJson } from "../lib/marketAnalysis.ts";

function venue(overrides = {}) {
  return {
    platform: "ondo",
    status: "open",
    referencePerShare: 100,
    executablePerShare: 102,
    referenceGap: 2,
    quoteAgeSeconds: 5,
    stale: false,
    unreliable: false,
    quoteAvailable: true,
    ...overrides,
  };
}

function analysisInput(overrides = {}) {
  return {
    ticker: "NVDA",
    spread: 2,
    statusMismatch: false,
    statuses: ["open"],
    venues: [venue(), venue({ platform: "bstock" })],
    ...overrides,
  };
}

test("analysis accepts a ticker and ignores browser-supplied market facts", () => {
  assert.deepEqual(parseAnalysisRequest({
    ticker: " nvda ",
    spread: 900,
    statusMismatch: false,
    venues: [{ referencePerShare: 1, executablePerShare: 999999 }],
  }), { ticker: "NVDA" });
});

test("analysis rejects invalid or oversized ticker identifiers", () => {
  assert.equal(parseAnalysisRequest({ ticker: "" }), null);
  assert.equal(parseAnalysisRequest({ ticker: "NVDA; buy now" }), null);
  assert.equal(parseAnalysisRequest({ ticker: "A".repeat(17) }), null);
  assert.equal(parseAnalysisRequest(["NVDA"]), null);
  assert.equal(parseAnalysisRequest(null), null);
});

test("model output must be a bounded summary without explicit trade promises", () => {
  const authoritativeText = "A 2.000% spread across 2 fresh venue quotes is informational and is not a guaranteed profit.";
  assert.equal(normalizeModelSummary({ summary: "Freshness and venue timing should be checked before acting." }, authoritativeText), "Freshness and venue timing should be checked before acting.");
  assert.equal(normalizeModelSummary({ summary: "There are 2 fresh venues at a 2.000% difference." }, authoritativeText), "There are 2 fresh venues at a 2.000% difference.");
  assert.throws(() => normalizeModelSummary({ summary: "Guaranteed profit; buy now." }, authoritativeText), /prohibited trading language/);
  assert.throws(() => normalizeModelSummary({ summary: "The spread is 25%." }, authoritativeText), /unsupported number/);
  assert.throws(() => normalizeModelSummary({ headline: "No summary" }, authoritativeText), /invalid summary/);
  assert.throws(() => normalizeModelSummary({ summary: " " }, authoritativeText), /empty summary/);
  assert.equal(normalizeModelSummary({ summary: "x".repeat(700) }, authoritativeText).length, 500);
});

test("deterministic market warnings cannot be replaced by a positive spread", () => {
  const sessionMismatch = buildRulesAnalysis(analysisInput({ statusMismatch: true, spread: 12 }));
  assert.equal(sessionMismatch.tone, "caution");
  assert.match(sessionMismatch.headline, /Session mismatch/);
  assert.match(sessionMismatch.nextStep, /Refresh/);

  const staleQuote = buildRulesAnalysis(analysisInput({
    spread: 12,
    venues: [venue(), venue({ platform: "bstock", stale: true })],
  }));
  assert.equal(staleQuote.tone, "caution");
  assert.match(staleQuote.reasons[0], /not enough fresh/);

  const outlier = buildRulesAnalysis(analysisInput({
    spread: 12,
    venues: [venue(), venue({ platform: "bstock", unreliable: true })],
  }));
  assert.equal(outlier.tone, "caution");
  assert.match(outlier.reasons[0], /reliability cap/);
});

test("deterministic read only reports a comparable spread from two usable venues", () => {
  const result = buildRulesAnalysis(analysisInput({ spread: 0.45 }));
  assert.equal(result.tone, "neutral");
  assert.match(result.reasons[0], /2 fresh venue quotes/);
  assert.match(result.reasons[1], /\+0\.450%/);
});

test("analysis request body parsing enforces the byte limit", async () => {
  const oversized = new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "content-length": "2049" },
    body: JSON.stringify({ ticker: "NVDA" }),
  });
  assert.deepEqual(await readBoundedJson(oversized, 2048), { ok: false, status: 413 });

  const withinLimit = new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker: "NVDA" }),
  });
  assert.deepEqual(await readBoundedJson(withinLimit, 2048), {
    ok: true,
    value: { ticker: "NVDA" },
  });
});

test("analysis request body parser rejects malformed JSON", async () => {
  const malformed = new Request("http://localhost/api/analyze", {
    method: "POST",
    body: "{",
  });
  assert.deepEqual(await readBoundedJson(malformed, 2048), { ok: false, status: 400 });
});
