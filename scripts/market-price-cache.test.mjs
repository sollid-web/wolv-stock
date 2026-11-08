import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceRwaPrices } from "../services/marketPriceCache.ts";

const address = "0x1111111111111111111111111111111111111111";

test("parses only requested token prices and preserves provider time", () => {
  const rows = parseBinanceRwaPrices({
    data: [
      { tokenContractAddress: address, tokenPrice: "123.45", referencePrice: "120", timestamp: 1794100000 },
      { tokenContractAddress: "0x2222222222222222222222222222222222222222", tokenPrice: "10" },
      { tokenContractAddress: address, tokenPrice: "-1" },
    ],
  }, [{ tokenAddress: address, ticker: "TEST" }], "2026-11-08T00:00:00.000Z");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceUsd, "123.45");
  assert.equal(rows[0].referencePriceUsd, "120");
  assert.equal(rows[0].providerTimestamp, new Date(1794100000 * 1000).toISOString());
});

test("rejects malformed envelopes", () => {
  assert.throws(() => parseBinanceRwaPrices({ data: {} }, []), /expected data-array/);
});

test("does not store unknown tokens, malformed addresses or non-positive prices", () => {
  const rows = parseBinanceRwaPrices({ data: [
    { tokenContractAddress: "bad", price: "10" },
    { tokenContractAddress: address, price: "0" },
    { tokenContractAddress: address, price: "NaN" },
    { tokenContractAddress: "0x2222222222222222222222222222222222222222", price: "5" },
  ] }, [{ tokenAddress: address, ticker: "TEST" }]);
  assert.equal(rows.length, 0);
});
