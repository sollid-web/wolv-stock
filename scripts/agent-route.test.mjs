import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/agent/execute/route.ts";

async function post(body, headers = { "content-type": "application/json" }) {
  return POST(new Request("http://localhost/api/agent/execute", {
    method: "POST",
    headers,
    body,
  }));
}

async function assertError(response, status, messagePattern) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, status);
  assert.match(body.error, messagePattern);
  assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
}

test("malformed JSON returns a structured 400 response", async () => {
  await assertError(await post("{"), 400, /valid UTF-8 JSON/);
});

test("oversized declared or streamed bodies return a structured 413 response", async (t) => {
  await t.test("declared Content-Length", async () => {
    await assertError(
      await post("{}", { "content-type": "application/json", "content-length": "8193" }),
      413,
      /8 KB limit/
    );
  });

  await t.test("chunked body", async () => {
    await assertError(
      await post(JSON.stringify({ naturalLanguage: "x".repeat(9_000) })),
      413,
      /8 KB limit/
    );
  });
});

test("unsupported strategy actions and invalid tickers return 422", async (t) => {
  await t.test("unknown action", async () => {
    await assertError(
      await post(JSON.stringify({ action: "execute", strategy: "Auto-swap 0.1 BNB into AAPL when price drops 2%" })),
      422,
      /Action must be preview or simulate/
    );
  });

  await t.test("invalid ticker syntax", async () => {
    await assertError(
      await post(JSON.stringify({
        ticker: "AAPL;DROP",
        side: "buy",
        amountBnb: "0.1",
        triggerPercent: 2,
        maxSlippagePercent: 0.5,
      })),
      422,
      /Ticker/
    );
  });

  await t.test("malformed natural-language strategy", async () => {
    await assertError(await post(JSON.stringify({ strategy: "buy me a stock" })), 422, /Use a supported buy rule/);
  });
});

test("zero, negative, non-finite, and excessive numeric inputs return 422", async (t) => {
  const invalidAmounts = ["0", "-0.1", "1e309", "10.1"];
  for (const amountBnb of invalidAmounts) {
    await t.test(`amount ${amountBnb}`, async () => {
      await assertError(
        await post(JSON.stringify({
          ticker: "AAPL",
          side: "buy",
          amountBnb,
          triggerPercent: 2,
          maxSlippagePercent: 0.5,
        })),
        422,
        /Amount/
      );
    });
  }
});

test("invalid mock prices return a structured 422 response", async () => {
  await assertError(
    await post(JSON.stringify({
      action: "simulate",
      strategy: "Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%",
      referencePrice: "-1",
      currentPrice: "98",
    })),
    422,
    /positive finite numbers/
  );
});
