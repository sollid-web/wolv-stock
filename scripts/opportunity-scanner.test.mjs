import test from "node:test";
import assert from "node:assert/strict";
import { scanMarketDislocations } from "../services/autonomy/opportunity-scanner.ts";

const address = "0x1111111111111111111111111111111111111111";
const base = {
  chainId: 56, tokenAddress: address, ticker: "NVDA", priceUsd: "90",
  referencePriceUsd: "100", providerTimestamp: "2026-11-10T10:00:00.000Z", stale: false,
};

test("detects a discount beyond threshold", () => {
  const [signal] = scanMarketDislocations([base], { now: "2026-11-10T10:00:10.000Z" });
  assert.equal(signal.direction, "DISCOUNT");
  assert.equal(signal.deviationBps, 1000);
  assert.equal(signal.status, "ACTIVE");
});

test("detects premiums and clears deviations below threshold", () => {
  const [premium] = scanMarketDislocations([{ ...base, priceUsd: "105" }], { now: "2026-11-10T10:00:10.000Z" });
  assert.equal(premium.direction, "PREMIUM");
  const [cleared] = scanMarketDislocations([{ ...base, priceUsd: "99.5" }], { now: "2026-11-10T10:00:10.000Z" });
  assert.equal(cleared.status, "CLEARED");
});

test("ignores stale, missing-reference, malformed and future-dated prices", () => {
  const result = scanMarketDislocations([
    { ...base, stale: true },
    { ...base, referencePriceUsd: null },
    { ...base, tokenAddress: "bad" },
    { ...base, providerTimestamp: "2026-11-10T11:00:00.000Z" },
  ], { now: "2026-11-10T10:00:10.000Z" });
  assert.deepEqual(result, []);
});

test("rejects invalid thresholds", () => {
  assert.throws(() => scanMarketDislocations([], { minDeviationBps: 0 }));
});
