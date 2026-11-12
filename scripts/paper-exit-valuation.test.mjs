import test from "node:test";
import assert from "node:assert/strict";
import { conservativeExitProceeds, usdFeeToTokenUnits, calculateExitReturnBps } from "../services/autonomy/paper-exit-valuation.ts";

test("exit proceeds apply slippage and token tax conservatively", () => {
  assert.equal(conservativeExitProceeds({ expectedAmountOut: "1000000", slippageBps: 100, outputTaxRate: "0.01" }), "980100");
});
test("USD fees convert to output-token base units rounded upward", () => {
  assert.equal(usdFeeToTokenUnits({ feeUsd: "0.01", tokenUsdPrice: "1", tokenDecimals: 6 }), "10000");
  assert.equal(usdFeeToTokenUnits({ feeUsd: "0.0000001", tokenUsdPrice: "1", tokenDecimals: 6 }), "1");
});
test("exit return is exact integer basis-point arithmetic", () => {
  assert.equal(calculateExitReturnBps("1000000", "1050000"), 500);
  assert.equal(calculateExitReturnBps("1000000", "970000"), -300);
});
test("invalid and unsafe valuation inputs fail closed", () => {
  assert.throws(() => conservativeExitProceeds({ expectedAmountOut: "0", slippageBps: 50, outputTaxRate: "0" }));
  assert.throws(() => usdFeeToTokenUnits({ feeUsd: "1", tokenUsdPrice: "0", tokenDecimals: 6 }));
  assert.throws(() => calculateExitReturnBps("0", "1"));
});
