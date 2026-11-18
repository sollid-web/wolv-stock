import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandles } from "../lib/candles.ts";

test("normalizes Binance Market API candle arrays using close index 3 and timestamp index 5", () => {
  const response = {
    data: [
      [770, 776, 768, 774, 76956, 1710000000000, 14],
      [774, 779, 772, 778, 70000, 1710003600000, 16],
    ],
  };

  const points = normalizeCandles(response, 776);
  assert.equal(points.length, 2);
  assert.equal(points[0].value, 774);
  assert.equal(points[0].timestamp, 1710000000000);
  assert.equal(points[1].value, 778);
});

test("sorts candles chronologically and rejects a volume-as-price series", () => {
  const response = {
    data: [
      [774, 779, 772, 778, 70000, 1710003600000, 16],
      [770, 776, 768, 774, 76956, 1710000000000, 14],
    ],
  };

  const points = normalizeCandles(response, 776);
  assert.deepEqual(points.map((point) => point.value), [774, 778]);

  const badResponse = {
    data: [
      [770, 776, 768, 76956, 774, 1710000000000, 14],
      [774, 779, 772, 70000, 778, 1710003600000, 16],
    ],
  };
  assert.deepEqual(normalizeCandles(badResponse, 776), []);
});

test("supports named close and timestamp fields", () => {
  const response = {
    data: [
      { open: "770", high: "776", low: "768", close: "774", timestamp: 1710000000000 },
      { open: "774", high: "779", low: "772", closePrice: "778", timestamp: 1710003600000 },
    ],
  };

  assert.deepEqual(normalizeCandles(response, 776).map((point) => point.value), [774, 778]);
});

test("returns no chart for too few or implausible points", () => {
  assert.deepEqual(normalizeCandles({ data: [[770, 776, 768, 774, 1, 1710000000000, 1]] }, 776), []);
  assert.deepEqual(normalizeCandles({ data: [[77000, 77001, 76999, 77000, 1, 1710000000000, 1], [78000, 78001, 77999, 78000, 1, 1710003600000, 1]] }, 776), []);
});

test("chart selection prefers fresh hourly candles, falls back to daily, and explains stale data", async () => {
  const { selectChartSeries } = await import("../lib/candles.ts");
  const now = Date.UTC(2026, 10, 18, 12);
  const hour = 60 * 60_000, day = 24 * hour;
  const series = (count, step, end, price) => ({ data: Array.from({ length: count }, (_, i) => [price, price, price, price, 1, end - (count - 1 - i) * step, 1]) });

  const fresh = selectChartSeries(series(10, hour, now - hour, 50), series(10, day, now - day, 50), 50, now);
  assert.equal(fresh.interval, "1h");
  assert.equal(fresh.points.length, 10);

  const daily = selectChartSeries(series(10, hour, now - 3 * day, 50), series(10, day, now - day, 50), 50, now);
  assert.equal(daily.interval, "1d");
  assert.equal(daily.unavailableReason, null);

  const stale = selectChartSeries(series(10, hour, Date.UTC(2026, 8, 28), 85), series(10, day, Date.UTC(2026, 8, 28), 85), 54, now);
  assert.equal(stale.points.length, 0);
  assert.match(stale.unavailableReason, /No recent on-chain trades .*28 Sept? 2026/);

  const mismatch = selectChartSeries(series(10, hour, now - hour, 85), null, 54, now);
  assert.equal(mismatch.points.length, 0);
  assert.match(mismatch.unavailableReason, /inconsistent with the listed price/);

  assert.match(selectChartSeries(null, null, 54, now).unavailableReason, /no on-chain candle data/);
});
