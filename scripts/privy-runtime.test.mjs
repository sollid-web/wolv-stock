import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createPrivyEip712SignerFromEnv } from "../services/autonomy/privy-runtime.ts";

const wallet = privateKeyToAccount(`0x${"33".repeat(32)}`);
const authorizationKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "der" },
  publicKeyEncoding: { type: "spki", format: "der" },
}).privateKey.toString("base64");
const typedData = {
  domain: { name: "WOLV RFQ", version: "1", chainId: 56, verifyingContract: `0x${"aa".repeat(20)}` },
  types: {
    RFQOrder: [
      { name: "maker", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minimumOutput", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "RFQOrder",
  message: {
    maker: wallet.address,
    tokenIn: `0x${"bb".repeat(20)}`,
    tokenOut: `0x${"cc".repeat(20)}`,
    amountIn: "1000",
    minimumOutput: "900",
    deadline: "1900000000",
  },
};
const policy = {
  chainId: 56,
  verifyingContracts: [typedData.domain.verifyingContract],
  primaryType: "RFQOrder",
  expectedTypes: structuredClone(typedData.types),
  expectedDomain: { name: "WOLV RFQ", version: "1" },
  requiredRoles: ["wallet", "tokenIn", "tokenOut", "amountIn", "minimumOutput", "expiry"],
  expectedFields: [
    { role: "wallet", path: "maker", kind: "address", value: wallet.address },
    { role: "tokenIn", path: "tokenIn", kind: "address", value: typedData.message.tokenIn },
    { role: "tokenOut", path: "tokenOut", kind: "address", value: typedData.message.tokenOut },
    { role: "amountIn", path: "amountIn", kind: "uint", value: "1000" },
    { role: "minimumOutput", path: "minimumOutput", kind: "uint", value: "900" },
    { role: "expiry", path: "deadline", kind: "uint", value: "1900000000" },
  ],
};
const env = {
  PRIVY_APP_ID: "app-test",
  PRIVY_APP_SECRET: "app-secret-test",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: authorizationKey,
  PRIVY_WALLET_ID: "wallet-test",
  PRIVY_WALLET_ADDRESS: wallet.address,
};

test("constructs the official Privy Node client and signs only its deployment-bound BSC wallet", async () => {
  let clientOptions;
  let signingRequest;
  class FakePrivyClient {
    constructor(options) { clientOptions = options; }
    wallets() {
      return {
        ethereum: () => ({
          async signTypedData(walletId, input) {
            signingRequest = { walletId, input };
            const typed = input.params.typed_data;
            const signature = await wallet.signTypedData({
              domain: typed.domain,
              types: typed.types,
              primaryType: typed.primary_type,
              message: typed.message,
            });
            return { encoding: "hex", signature };
          },
        }),
      };
    }
  }
  const signer = createPrivyEip712SignerFromEnv(env, () => ({ PrivyClient: FakePrivyClient }));
  const signature = await signer.sign({
    walletId: "wallet-test",
    walletAddress: wallet.address,
    signerOperationId: "wolv-signer-operation-0001",
    typedData,
    policy,
  });

  assert.match(signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(clientOptions.appId, "app-test");
  assert.equal(clientOptions.appSecret, "app-secret-test");
  assert.deepEqual(clientOptions.requestExpiry, { defaultMs: 60_000 });
  assert.equal(signingRequest.walletId, "wallet-test");
  assert.equal(signingRequest.input.caip2, "eip155:56");
  assert.equal(signingRequest.input.idempotency_key, "wolv-signer-operation-0001");
  assert.deepEqual(signingRequest.input.authorization_context.authorization_private_keys, [authorizationKey]);
});

test("refuses a wallet ID or address that differs from deployment custody configuration", async () => {
  class FakePrivyClient {
    wallets() {
      return { ethereum: () => ({ async signTypedData() { throw new Error("must not call signer"); } }) };
    }
  }
  const signer = createPrivyEip712SignerFromEnv(env, () => ({ PrivyClient: FakePrivyClient }));
  await assert.rejects(() => signer.sign({
    walletId: "different-wallet",
    walletAddress: wallet.address,
    signerOperationId: "wolv-signer-operation-0002",
    typedData,
    policy,
  }), /wallet ID does not match/);
  await assert.rejects(() => signer.sign({
    walletId: "wallet-test",
    walletAddress: `0x${"44".repeat(20)}`,
    signerOperationId: "wolv-signer-operation-0003",
    typedData,
    policy,
  }), /address does not match/);
});

test("fails closed when server-side Privy credentials or SDK are missing", () => {
  assert.throws(() => createPrivyEip712SignerFromEnv({}, () => {
    throw new Error("must not load sdk");
  }), /PRIVY_APP_ID is required/);
  assert.throws(() => createPrivyEip712SignerFromEnv(env, () => {
    throw new Error("sdk missing");
  }), /sdk missing/);
});
