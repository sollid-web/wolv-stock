import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildSignedHeaders, parseEnvelope, runReadOnlyProbe, summarizePayloadShape } from "./binance-provider-probe.mjs";

test("signs the exact GET path including query parameters", () => {
  const now = new Date("2026-11-08T12:34:56.789Z");
  const path = "/api/v1/dex/market/rwa/tokens?platformId=bstock";
  const headers = buildSignedHeaders("GET", path, "public-key", "secret", now);
  const expected = crypto.createHmac("sha256", "secret")
    .update(now.toISOString() + "GET" + "/build" + path, "utf8").digest("base64");
  assert.equal(headers["X-OC-SIGN"], expected);
  assert.equal(headers["X-OC-TIMESTAMP"], now.toISOString());
  assert.equal(headers["X-OC-RECV-WINDOW"], "60000");
});

test("rejects non-GET methods so the probe cannot submit transactions", () => {
  assert.throws(() => buildSignedHeaders("POST", "/api/v1/dex/aggregator/order/submit", "k", "s"), /GET requests only/);
});

test("rejects non-API paths", () => {
  assert.throws(() => buildSignedHeaders("GET", "/build/api/v1/foo", "k", "s"), /Invalid Binance API path/);
});

test("validates Binance response envelopes", () => {
  assert.deepEqual(parseEnvelope({ code: 0, success: true, data: [1] }, "fixture"), [1]);
  assert.throws(() => parseEnvelope({ code: 40102, success: false, msg: "bad signature" }, "fixture"), /40102/);
  assert.throws(() => parseEnvelope([], "fixture"), /invalid response envelope/);
});

test("live probe skips safely when credentials are absent", async () => {
  const result = await runReadOnlyProbe({}, async () => { throw new Error("fetch must not be called"); });
  assert.equal(result.skipped, true);
});

test("live probe performs GET requests only and parses a RWA token fixture", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    const path = new URL(String(url)).pathname;
    let data = [{
      binanceChainId: "56",
      tokenContractAddress: "0x1234567890123456789012345678901234567890",
      underlyingTicker: "TEST",
    }];
    if (path.endsWith("/price")) data = [{ tokenContractAddress: "0x1234567890123456789012345678901234567890", price: "1" }];
    if (path.endsWith("/underlying-market")) data = { marketData: { referencePrice: "1" } };
    return new Response(JSON.stringify({ code: 0, success: true, data }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const result = await runReadOnlyProbe({ BINANCE_API_KEY: "k", BINANCE_SECRET_KEY: "s" }, fakeFetch);
  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 3);
  assert.ok(calls.length === 3);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("summarizes provider quote schema without exposing field values", () => {
  const shape = summarizePayloadShape({
    quoteId: "secret-quote-id",
    amountOut: "123456",
    route: [{ tokenAddress: "0xsecret", amount: "999" }],
    fees: { gas: "123", token: "0xfee" },
  });
  const serialized = JSON.stringify(shape);
  assert.match(serialized, /quoteId/);
  assert.match(serialized, /amountOut/);
  assert.match(serialized, /route/);
  assert.doesNotMatch(serialized, /secret-quote-id|0xsecret|123456|999/);
});
