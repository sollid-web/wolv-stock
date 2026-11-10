import test from "node:test";
import assert from "node:assert/strict";
import { calculateReferenceEdge } from "../services/autonomy/reference-edge.ts";

const base = {
  inputAmount: "100000000",
  inputDecimals: 6,
  inputTokenUsdPrice: "1",
  inputTokenTaxRate: "0",
  outputAmount: "1000000000000000000",
  outputDecimals: 18,
  referencePriceUsd: "110",
  outputTokenTaxRate: "0",
  tradeFeeUsd: "0.5",
  gasCostUsd: "0.5",
};

test("calculates target-price edge after input, output, trade and gas costs", () => {
  const result = calculateReferenceEdge(base);
  assert.equal(result.expectedEdgeBps, 891);
  assert.equal(result.inputCostUsd, "100");
  assert.equal(result.grossOutputValueUsd, "110");
  assert.equal(result.netOutputValueUsd, "110");
  assert.equal(result.totalFeesUsd, "1");
});

test("applies token taxes conservatively and floors positive edge", () => {
  const result = calculateReferenceEdge({
    ...base, inputTokenTaxRate: "0.01", outputTokenTaxRate: "0.02",
  });
  assert.equal(result.expectedEdgeBps, 568);
  assert.equal(result.inputCostUsd, "101");
  assert.equal(result.netOutputValueUsd, "107.8");
});

test("negative edge is floored rather than rounded toward zero", () => {
  const result = calculateReferenceEdge({ ...base, referencePriceUsd: "90" });
  assert.equal(result.expectedEdgeBps, -1090);
});

test("requires explicit gas cost and rejects malformed amounts, prices and taxes", () => {
  const { gasCostUsd: _gas, ...withoutGas } = base;
  assert.throws(() => calculateReferenceEdge(withoutGas), /gasCostUsd/);
  assert.throws(() => calculateReferenceEdge({ ...base, inputAmount: "1.5" }), /inputAmount/);
  assert.throws(() => calculateReferenceEdge({ ...base, referencePriceUsd: "0" }), /positive/);
  assert.throws(() => calculateReferenceEdge({ ...base, outputTokenTaxRate: "1.01" }), /between 0 and 1/);
  assert.throws(() => calculateReferenceEdge({ ...base, tradeFeeUsd: "NaN" }), /tradeFeeUsd/);
});
