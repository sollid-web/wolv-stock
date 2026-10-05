import assert from "node:assert/strict";
import test from "node:test";
import { selectBestRouterQuote } from "../lib/routerQuoteSelection.ts";

test("never selects a venue when every executable quote is unavailable or invalid", () => {
  assert.equal(selectBestRouterQuote([
    { platform: "ondo", effectiveUsd: null },
    { platform: "bstock", effectiveUsd: 0 },
    { platform: "venue-c", effectiveUsd: Number.NaN },
  ]), undefined);
});

test("ranks only positive executable quotes and never falls back to a failed row", () => {
  const best = selectBestRouterQuote([
    { platform: "failed", effectiveUsd: null },
    { platform: "more expensive", effectiveUsd: 12 },
    { platform: "best", effectiveUsd: 10 },
  ]);
  assert.deepEqual(best, { platform: "best", effectiveUsd: 10 });
});
