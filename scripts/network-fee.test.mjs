import test from "node:test";
import assert from "node:assert/strict";
import { applyNetworkFeeBuffer } from "../services/autonomy/network-fee.ts";

test("applies a conservative default 2x network-fee buffer", () => {
  assert.equal(applyNetworkFeeBuffer("0.12"), "0.24");
  assert.equal(applyNetworkFeeBuffer("0"), "0");
});

test("supports explicit buffer policy and rounds upward", () => {
  assert.equal(applyNetworkFeeBuffer("0.12", 5000), "0.18");
  assert.equal(applyNetworkFeeBuffer("0.000000000000000001", 1), "0.000000000000000002");
});

test("rejects malformed estimates and invalid buffer bounds", () => {
  assert.throws(() => applyNetworkFeeBuffer("NaN"), /Invalid/);
  assert.throws(() => applyNetworkFeeBuffer("-1"), /Invalid/);
  assert.throws(() => applyNetworkFeeBuffer("0.1", -1), /Invalid/);
  assert.throws(() => applyNetworkFeeBuffer("0.1", 100001), /Invalid/);
});
