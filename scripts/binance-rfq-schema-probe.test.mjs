import test from "node:test";
import assert from "node:assert/strict";
import { schemaSummary } from "./binance-rfq-schema-probe.mjs";

test("schema probe reports JSON EIP-712 field names without exposing message values", () => {
  const secretLikeValue = "DO_NOT_PRINT_THIS_VALUE";
  const summary = schemaSummary({
    typedDataFormat: "JSON_TYPED_DATA",
    typedDataHash: "hash",
    typedDataToSign: JSON.stringify({
      domain: { name: "RFQ", version: "1", chainId: 56, verifyingContract: "0x1111111111111111111111111111111111111111" },
      primaryType: "Order",
      types: {
        EIP712Domain: [{ name: "chainId", type: "uint256" }],
        Order: [{ name: "maker", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "data", type: "bytes" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "data", type: "bytes" }],
      },
      message: { maker: secretLikeValue, amount: "123456789", nonce: "99", deadline: "1900000000", data: "0xdeadbeef" },
    }),
  });
  assert.equal(summary.primaryType, "Order");
  assert.deepEqual(summary.messageFieldNames, ["amount", "data", "deadline", "maker", "nonce"]);
  assert.deepEqual(summary.transactionLikeFields, ["data", "deadline", "nonce"]);
  assert.equal(summary.hasCalldataField, true);
  assert.equal(summary.hasNonceField, true);
  assert.equal(summary.hasExpiryField, true);
  assert.deepEqual(summary.typeDefinitions.Order, [
    { name: "maker", type: "address" }, { name: "amount", type: "uint256" },
  ]);
  assert.equal(JSON.stringify(summary).includes(secretLikeValue), false);
  assert.equal(JSON.stringify(summary).includes("123456789"), false);
  assert.equal(summary.signingAllowedByCurrentWolvPolicy, false);
});

test("schema probe identifies opaque hex payloads without exposing bytes", () => {
  const summary = schemaSummary({
    typedDataFormat: "HEX_EIP712_PAYLOAD",
    typedDataHash: "hash",
    typedDataToSign: "0x12345678aabbccdd",
  });
  assert.equal(summary.opaqueHex, true);
  assert.equal(summary.byteLength, 8);
  assert.equal(summary.signingAllowedByCurrentWolvPolicy, false);
  assert.equal(JSON.stringify(summary).includes("12345678"), false);
});
