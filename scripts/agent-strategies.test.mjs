import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMockTrigger, parseAgentStrategy } from "../lib/agentStrategies.ts";

test("parses the documented natural-language buy request", () => {
  const result = parseAgentStrategy("Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%");
  assert.equal(result.ok, true);
  assert.deepEqual(result.strategy, {
    ticker: "AAPL",
    side: "buy",
    amount: "0.1",
    amountUnit: "BNB",
    triggerPercent: 2,
    triggerDirection: "drop",
    maxSlippagePercent: 0.5,
  });
});

test("accepts structured sell rules and derives a rise trigger", () => {
  const result = parseAgentStrategy({
    targetTicker: "TSLA",
    side: "sell",
    amountToken: "0.25",
    triggerPercent: 3,
    maxSlippagePercent: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.strategy.triggerDirection, "rise");
  assert.equal(result.strategy.amountUnit, "token");
});

test("rejects amounts, trigger percentages, and slippage outside the supported bounds", async (t) => {
  const base = { ticker: "AAPL", side: "buy", amountBnb: "0.1", triggerPercent: 2, maxSlippagePercent: 0.5 };
  const invalidCases = [
    ["zero amount", { ...base, amountBnb: "0" }],
    ["negative amount", { ...base, amountBnb: "-0.1" }],
    ["amount above cap", { ...base, amountBnb: "10.1" }],
    ["non-finite amount", { ...base, amountBnb: "1e309" }],
    ["zero trigger", { ...base, triggerPercent: 0 }],
    ["slippage above cap", { ...base, maxSlippagePercent: 5.1 }],
    ["invalid ticker", { ...base, ticker: "AAPL;DROP" }],
    ["unsupported ticker syntax", { ...base, ticker: "TOOLONGTICKER" }],
  ];

  for (const [label, input] of invalidCases) {
    await t.test(label, () => assert.equal(parseAgentStrategy(input).ok, false));
  }
});

test("mock triggers fire at the exact drop/rise boundary only", () => {
  const buy = parseAgentStrategy("Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%").strategy;
  assert.deepEqual(evaluateMockTrigger(buy, "100", "98"), {
    ok: true,
    triggered: true,
    changePercent: -2,
  });
  assert.equal(evaluateMockTrigger(buy, "100", "98.01").triggered, false);

  const sell = parseAgentStrategy({
    ticker: "TSLA",
    side: "sell",
    amountToken: "0.25",
    triggerPercent: 3,
    maxSlippagePercent: 1,
  }).strategy;
  assert.equal(evaluateMockTrigger(sell, "100", "103").triggered, true);
  assert.equal(evaluateMockTrigger(sell, "100", "102.99").triggered, false);
});

test("mock trigger prices must be valid positive decimals", () => {
  const strategy = parseAgentStrategy("Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%").strategy;
  assert.equal(evaluateMockTrigger(strategy, "0", "98").ok, false);
  assert.equal(evaluateMockTrigger(strategy, "100", "NaN").ok, false);
});
