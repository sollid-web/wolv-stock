import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePrivyEip712PolicyTemplate,
  bindPrivyEip712PolicyToOrder,
} from "../services/autonomy/privy-eip712-policy.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const tokenIn = "0x2222222222222222222222222222222222222222";
const tokenOut = "0x3333333333333333333333333333333333333333";
const verifyingContract = "0x4444444444444444444444444444444444444444";

function template() {
  return {
    vendor: "rfq-vendor-a",
    chainId: 56,
    verifyingContracts: [verifyingContract],
    primaryType: "RFQOrder",
    expectedDomain: { name: "Binance RFQ", version: "1" },
    expectedTypes: {
      RFQOrder: [
        { name: "maker", type: "address" },
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "minimumOutput", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "quoteId", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    },
    requiredRoles: ["wallet", "tokenIn", "tokenOut", "amountIn", "minimumOutput", "expiry", "quoteId", "nonce"],
    fieldBindings: [
      { role: "wallet", path: "maker", kind: "address", source: "walletAddress" },
      { role: "tokenIn", path: "tokenIn", kind: "address", source: "inputTokenAddress" },
      { role: "tokenOut", path: "tokenOut", kind: "address", source: "outputTokenAddress" },
      { role: "amountIn", path: "amountIn", kind: "uint", source: "amountIn" },
      { role: "minimumOutput", path: "minimumOutput", kind: "uint", source: "minimumAmountOut" },
      { role: "expiry", path: "deadline", kind: "uint", source: "quoteExpiryUnixSeconds" },
      { role: "quoteId", path: "quoteId", kind: "bytes32", source: "quoteId" },
      { role: "nonce", path: "nonce", kind: "uint", source: "typedDataField", sourcePath: "nonce" },
    ],
  };
}

test("parses a vendor-specific BSC typed-data policy template", () => {
  const parsed = parsePrivyEip712PolicyTemplate(template());
  assert.equal(parsed.vendor, "rfq-vendor-a");
  assert.equal(parsed.chainId, 56);
  assert.deepEqual(parsed.verifyingContracts, [verifyingContract]);
  assert.equal(parsed.fieldBindings.length, 8);
});

test("binds policy fields to the current validated RFQ order and wallet", () => {
  const policyTemplate = parsePrivyEip712PolicyTemplate(template());
  const order = {
    provider: "binance-web3-aggregator",
    quoteId: "a".repeat(32),
    orderId: "rfq-order-001",
    vendor: "rfq-vendor-a",
    signingScheme: "EIP712",
    chainId: "56",
    walletAddress: wallet,
    inputTokenAddress: tokenIn,
    outputTokenAddress: tokenOut,
    amountIn: "1000",
    expectedAmountOut: "950",
    typedDataHash: "b".repeat(64),
    typedDataToSign: JSON.stringify({ domain: {}, types: {}, primaryType: "RFQOrder", message: { nonce: "42" } }),
    typedDataFormat: "JSON_TYPED_DATA",
    approvalTarget: null,
    routeFingerprint: "c".repeat(64),
    rawEvidenceRef: "d".repeat(64),
    approvalRequired: false,
    preparedAt: new Date().toISOString(),
    quoteExpiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  const policy = bindPrivyEip712PolicyToOrder({
    template: policyTemplate,
    order,
    walletAddress: wallet,
    minimumAmountOut: "940",
  });
  assert.equal(policy.vendor, "rfq-vendor-a");
  assert.deepEqual(policy.expectedFields.map((field) => field.value), [
    wallet, tokenIn, tokenOut, "1000", "940",
    String(Math.floor(Date.parse(order.quoteExpiresAt) / 1000)),
    "a".repeat(32), "42",
  ]);
});

test("rejects unsupported typed-data formats and vendor-policy mismatches", () => {
  const policyTemplate = parsePrivyEip712PolicyTemplate(template());
  const order = {
    provider: "binance-web3-aggregator",
    quoteId: "a".repeat(32), orderId: "rfq-order-001", vendor: "rfq-vendor-b",
    signingScheme: "EIP712", chainId: "56", walletAddress: wallet,
    inputTokenAddress: tokenIn, outputTokenAddress: tokenOut, amountIn: "1000",
    expectedAmountOut: "950", typedDataHash: "b".repeat(64), typedDataToSign: "0xdead",
    typedDataFormat: "HEX_EIP712_PAYLOAD", approvalTarget: null, routeFingerprint: "c".repeat(64),
    rawEvidenceRef: "d".repeat(64), approvalRequired: false, preparedAt: new Date().toISOString(),
    quoteExpiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  assert.throws(() => bindPrivyEip712PolicyToOrder({
    template: policyTemplate, order, walletAddress: wallet, minimumAmountOut: "940",
  }), /vendor/);
  const matchingVendor = { ...order, vendor: "rfq-vendor-a", typedDataFormat: "HEX_EIP712_PAYLOAD" };
  assert.throws(() => bindPrivyEip712PolicyToOrder({
    template: policyTemplate, order: matchingVendor, walletAddress: wallet, minimumAmountOut: "940",
  }), /Opaque RFQ/);
});
