import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPrivyEip712SignerFromEnv,
  canonicalizePrivyAuthorizationRequest,
} from "../services/autonomy/privy-runtime.ts";

const wallet = privateKeyToAccount(`0x${"33".repeat(32)}`);
const authPair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "der" },
  publicKeyEncoding: { type: "spki", format: "der" },
});
const authorizationKey = authPair.privateKey.toString("base64");
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

function response(signature) {
  return new Response(JSON.stringify({
    method: "eth_signTypedData_v4",
    data: { encoding: "hex", signature },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("sends a signed Privy request and recovers the EIP-712 wallet signature", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    const signature = await wallet.signTypedData({
      domain: captured.body.params.typed_data.domain,
      types: captured.body.params.typed_data.types,
      primaryType: captured.body.params.typed_data.primary_type,
      message: captured.body.params.typed_data.message,
    });
    return response(signature);
  };

  const signer = createPrivyEip712SignerFromEnv(env, fetchImpl);
  const signature = await signer.sign({
    walletId: "wallet-test",
    walletAddress: wallet.address,
    signerOperationId: "wolv-signer-operation-0001",
    typedData,
    policy,
  });

  assert.match(signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(captured.url, "https://api.privy.io/v1/wallets/wallet-test/rpc");
  assert.equal(captured.body.method, "eth_signTypedData_v4");
  assert.equal(captured.body.chain_type, "ethereum");
  assert.equal(captured.body.caip2, "eip155:56");
  assert.equal(captured.body.params.typed_data.primary_type, "RFQOrder");
  assert.equal(captured.init.headers["privy-app-id"], "app-test");
  assert.equal(captured.init.headers["privy-idempotency-key"], "wolv-signer-operation-0001");
  assert.match(captured.init.headers["privy-request-expiry"], /^[0-9]+$/);
  assert.equal(
    captured.init.headers.Authorization,
    "Basic " + Buffer.from("app-test:app-secret-test").toString("base64"),
  );

  const authPayload = canonicalizePrivyAuthorizationRequest({
    version: 1,
    method: "POST",
    url: captured.url,
    body: captured.body,
    headers: {
      "privy-app-id": captured.init.headers["privy-app-id"],
      "privy-idempotency-key": captured.init.headers["privy-idempotency-key"],
      "privy-request-expiry": captured.init.headers["privy-request-expiry"],
    },
  });
  const authKey = createPrivateKey({ key: Buffer.from(authorizationKey, "base64"), format: "der", type: "pkcs8" });
  const authPublicKey = createPublicKey(authKey);
  assert.equal(
    verify("sha256", Buffer.from(authPayload), authPublicKey, Buffer.from(captured.init.headers["privy-authorization-signature"], "base64")),
    true,
  );
});

test("refuses a wallet ID or address that differs from deployment custody configuration", async () => {
  let calls = 0;
  const signer = createPrivyEip712SignerFromEnv(env, async () => {
    calls += 1;
    return response("0x" + "aa".repeat(65));
  });
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
  assert.equal(calls, 0);
});

test("fails closed when server-side Privy credentials or HTTP responses are invalid", async () => {
  assert.throws(() => createPrivyEip712SignerFromEnv({}, async () => response("0x" + "aa".repeat(65))), /PRIVY_APP_ID is required/);
  assert.throws(() => createPrivyEip712SignerFromEnv({
    ...env,
    PRIVY_AUTHORIZATION_PRIVATE_KEY: "not-a-pkcs8-key",
  }, async () => response("0x" + "aa".repeat(65))), /PKCS8 P-256/);

  const signer = createPrivyEip712SignerFromEnv(env, async () =>
    new Response("upstream failure", { status: 500 }),
  );
  await assert.rejects(() => signer.sign({
    walletId: "wallet-test",
    walletAddress: wallet.address,
    signerOperationId: "wolv-signer-operation-0004",
    typedData,
    policy,
  }), /HTTP 500/);
});
