import assert from "node:assert/strict";
import test from "node:test";
import { isRwaAssetListResponse } from "../lib/rwaAssetResponse.ts";

const validAsset = {
  tokenContractAddress: "0x0000000000000000000000000000000000000001",
  underlyingTicker: "WOLV",
  platformId: "ondo",
};

test("accepts valid asset lists and a legitimate empty filtered result", () => {
  assert.equal(isRwaAssetListResponse({ success: true, data: [validAsset] }), true);
  assert.equal(isRwaAssetListResponse({ success: true, data: [] }), false);
  assert.equal(isRwaAssetListResponse({ success: true, data: [] }, { allowEmpty: true }), true);
});

test("rejects a successful response with missing, non-array, or malformed data", () => {
  assert.equal(isRwaAssetListResponse({ success: true }), false);
  assert.equal(isRwaAssetListResponse({ success: true, data: null }), false);
  assert.equal(isRwaAssetListResponse({ success: true, data: {} }), false);
  assert.equal(isRwaAssetListResponse({ success: true, data: [null] }), false);
  assert.equal(isRwaAssetListResponse({ success: true, data: [{ ...validAsset, platformId: " " }] }), false);
  assert.equal(isRwaAssetListResponse({ success: true, data: [{ underlyingTicker: "WOLV" }] }), false);
});
