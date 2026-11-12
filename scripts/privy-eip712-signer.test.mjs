import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createPrivyEip712Signer, validatePrivyEip712Request } from "../services/autonomy/privy-eip712-signer.ts";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const verifyingContract = `0x${"aa".repeat(20)}`;
const tokenIn = `0x${"bb".repeat(20)}`;
const tokenOut = `0x${"cc".repeat(20)}`;
const quoteId = `0x${"dd".repeat(32)}`;

const types = {
  RFQOrder: [
    { name: "maker", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minimumOutput", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
  ],
};

function makeRequest(overrides = {}) {
  const typedData = {
    domain: { name: "WOLV RFQ", version: "1", chainId: 56, verifyingContract },
    types: structuredClone(types),
    primaryType: "RFQOrder",
    message: {
      maker: account.address,
      tokenIn,
      tokenOut,
      amountIn: 1000n,
      minimumOutput: 900n,
      deadline: 1900000000n,
      quoteId,
    },
  };
  const policy = {
    vendor: "vendor-test",
    chainId: 56,
    verifyingContracts: [verifyingContract],
    primaryType: "RFQOrder",
    expectedTypes: structuredClone(types),
    expectedDomain: { name: "WOLV RFQ", version: "1" },
    requiredRoles: ["wallet", "tokenIn", "tokenOut", "amountIn", "minimumOutput", "expiry", "quoteId"],
    expectedFields: [
      { role: "wallet", path: "maker", kind: "address", value: account.address },
      { role: "tokenIn", path: "tokenIn", kind: "address", value: tokenIn },
      { role: "tokenOut", path: "tokenOut", kind: "address", value: tokenOut },
      { role: "amountIn", path: "amountIn", kind: "uint", value: "1000" },
      { role: "minimumOutput", path: "minimumOutput", kind: "uint", value: "900" },
      { role: "expiry", path: "deadline", kind: "uint", value: "1900000000" },
      { role: "quoteId", path: "quoteId", kind: "bytes32", value: quoteId },
    ],
  };
  return {
    walletId: "privy-wallet-test",
    walletAddress: account.address,
    signerOperationId: "signer-operation-0001",
    providerVendor: "vendor-test",
    typedData,
    policy,
    ...overrides,
  };
}

test("validates and signs only the exact BSC RFQ typed-data intent", async () => {
  const request = makeRequest();
  assert.doesNotThrow(() => validatePrivyEip712Request(request));
  let calls = 0;
  const signer = createPrivyEip712Signer({
    async signTypedData(input) {
      calls += 1;
      assert.equal(input.walletId, request.walletId);
      assert.equal(input.walletAddress, request.walletAddress);
      assert.equal(input.idempotencyKey, request.signerOperationId);
      return {
        signature: await account.signTypedData({
          domain: input.typedData.domain,
          types: input.typedData.types,
          primaryType: input.typedData.primaryType,
          message: input.typedData.message,
        }),
      };
    },
  });
  const signature = await signer.sign(request);
  assert.match(signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(calls, 1);
});

test("rejects wrong chain, verifying contract, primary type and typed-data schema before signing", async () => {
  const signer = createPrivyEip712Signer({ async signTypedData() { throw new Error("must not call signer"); } });
  const wrongChain = makeRequest();
  wrongChain.typedData.domain.chainId = 1;
  await assert.rejects(() => signer.sign(wrongChain), /chain ID 56/);

  const wrongContract = makeRequest();
  wrongContract.typedData.domain.verifyingContract = `0x${"ee".repeat(20)}`;
  await assert.rejects(() => signer.sign(wrongContract), /not allowlisted/);

  const wrongPrimaryType = makeRequest();
  wrongPrimaryType.typedData.primaryType = "Permit";
  await assert.rejects(() => signer.sign(wrongPrimaryType), /primary type/);

  const wrongSchema = makeRequest();
  wrongSchema.typedData.types.RFQOrder.push({ name: "unreviewed", type: "uint256" });
  await assert.rejects(() => signer.sign(wrongSchema), /schema/);
});

test("rejects mismatched wallet, tokens, amounts, expiry and quote ID before signing", async () => {
  const signer = createPrivyEip712Signer({ async signTypedData() { throw new Error("must not call signer"); } });

  const wrongWallet = makeRequest();
  wrongWallet.typedData.message.maker = otherAccount.address;
  await assert.rejects(() => signer.sign(wrongWallet), /execution intent/);

  const wrongToken = makeRequest();
  wrongToken.typedData.message.tokenOut = `0x${"ef".repeat(20)}`;
  await assert.rejects(() => signer.sign(wrongToken), /execution intent/);

  const wrongAmount = makeRequest();
  wrongAmount.typedData.message.amountIn = 1001n;
  await assert.rejects(() => signer.sign(wrongAmount), /execution intent/);

  const wrongExpiry = makeRequest();
  wrongExpiry.typedData.message.deadline = 1900000001n;
  await assert.rejects(() => signer.sign(wrongExpiry), /execution intent/);

  const wrongQuote = makeRequest();
  wrongQuote.typedData.message.quoteId = `0x${"ff".repeat(32)}`;
  await assert.rejects(() => signer.sign(wrongQuote), /execution intent/);
});

test("rejects opaque hex payloads, extra message fields, and missing required policy roles", async () => {
  const signer = createPrivyEip712Signer({ async signTypedData() { throw new Error("must not call signer"); } });

  const opaque = makeRequest({ typedData: `0x${"ab".repeat(128)}` });
  await assert.rejects(() => signer.sign(opaque), /Opaque hex/);

  const extra = makeRequest();
  extra.typedData.message.unreviewedField = "not in RFQOrder";
  await assert.rejects(() => signer.sign(extra), /message fields differ/);

  const missingRole = makeRequest();
  missingRole.policy.requiredRoles = ["wallet", "tokenIn", "tokenOut", "amountIn", "expiry", "spender"];
  await assert.rejects(() => signer.sign(missingRole), /Required EIP-712 policy role is missing/);
});

test("rejects malformed signatures and signatures from another wallet", async () => {
  const request = makeRequest();
  const malformed = createPrivyEip712Signer({ async signTypedData() { return { signature: "0xdead" }; } });
  await assert.rejects(() => malformed.sign(request), /malformed EIP-712 signature/);

  const wrongSigner = createPrivyEip712Signer({
    async signTypedData(input) {
      return {
        signature: await otherAccount.signTypedData({
          domain: input.typedData.domain,
          types: input.typedData.types,
          primaryType: input.typedData.primaryType,
          message: input.typedData.message,
        }),
      };
    },
  });
  await assert.rejects(() => wrongSigner.sign(request), /different wallet/);
});
