import test from "node:test";
import assert from "node:assert/strict";
import { calculateNetEdge } from "../services/autonomy/reference-edge.ts";

const base = {
  inputAmount: "100000000",
  inputDecimals: 6,
  inputTokenUsdPrice: "1",
  inputTokenTaxRate: "0",
  outputAmount: "1000000000000000000",
  outputDecimals: 18,
  outputTokenUsdPrice: "110",
  outputTokenTaxRate: "0",
  tradeFeeUsd: "0.5",
  gasCostUsd: "0.5",
};

test("calculates target-price edge after input, output, trade and gas costs", () => {
  const result = calculateNetEdge(base);
  assert.equal(result.expectedEdgeBps, 891);
  assert.equal(result.inputCostUsd, "100");
  assert.equal(result.grossOutputValueUsd, "110");
  assert.equal(result.netOutputValueUsd, "110");
  assert.equal(result.totalFeesUsd, "1");
});

test("applies token taxes conservatively and floors positive edge", () => {
  const result = calculateNetEdge({
    ...base, inputTokenTaxRate: "0.01", outputTokenTaxRate: "0.02",
  });
  assert.equal(result.expectedEdgeBps, 568);
  assert.equal(result.inputCostUsd, "101");
  assert.equal(result.netOutputValueUsd, "107.8");
});

test("negative edge is floored rather than rounded toward zero", () => {
  const result = calculateNetEdge({ ...base, outputTokenUsdPrice: "90" });
  assert.equal(result.expectedEdgeBps, -1090);
});

test("requires explicit gas cost and rejects malformed amounts, prices and taxes", () => {
  const { gasCostUsd: _gas, ...withoutGas } = base;
  assert.throws(() => calculateNetEdge(withoutGas), /gasCostUsd/);
  assert.throws(() => calculateNetEdge({ ...base, inputAmount: "1.5" }), /inputAmount/);
  assert.throws(() => calculateNetEdge({ ...base, outputTokenUsdPrice: "0" }), /positive/);
  assert.throws(() => calculateNetEdge({ ...base, outputTokenTaxRate: "1.01" }), /between 0 and 1/);
  assert.throws(() => calculateNetEdge({ ...base, tradeFeeUsd: "NaN" }), /tradeFeeUsd/);
});
