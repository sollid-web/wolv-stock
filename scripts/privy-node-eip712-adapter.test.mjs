import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  createPrivyNodeEip712SigningClient,
} from "../services/autonomy/privy-eip712-signer.ts";

const walletAddress = "0x1111111111111111111111111111111111111111";
const authorizationKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "der" },
  publicKeyEncoding: { type: "spki", format: "der" },
}).privateKey.toString("base64");
const signature = `0x${"a".repeat(130)}`;

function typedData() {
  return {
    domain: { name: "WOLV RFQ", version: "1", chainId: 56, verifyingContract: "0x2222222222222222222222222222222222222222" },
    types: { RFQOrder: [{ name: "maker", type: "address" }, { name: "amountIn", type: "uint256" }] },
    primaryType: "RFQOrder",
    message: { maker: walletAddress, amountIn: "1000" },
  };
}

test("maps validated WOLV EIP-712 data to Privy Node SDK ethereum().signTypedData", async () => {
  let captured;
  const client = {
    wallets() {
      return {
        ethereum() {
          return {
            async signTypedData(walletId, input) {
              captured = { walletId, input };
              return { encoding: "hex", signature };
            },
          };
        },
      };
    },
  };
  const adapter = createPrivyNodeEip712SigningClient({
    client,
    authorizationPrivateKey: authorizationKey,
  });
  const result = await adapter.signTypedData({
    walletId: "privy-wallet-1",
    walletAddress,
    typedData: typedData(),
    idempotencyKey: "wolv-live-attempt-0001",
  });

  assert.deepEqual(result, { signature });
  assert.equal(captured.walletId, "privy-wallet-1");
  assert.equal(captured.input.address, walletAddress);
  assert.equal(captured.input.caip2, "eip155:56");
  assert.equal(captured.input.params.typed_data.primary_type, "RFQOrder");
  assert.deepEqual(captured.input.params.typed_data.types, typedData().types);
  assert.equal(captured.input.params.typed_data.message.maker, walletAddress);
  assert.equal(captured.input.idempotency_key, "wolv-live-attempt-0001");
  assert.deepEqual(captured.input.authorization_context.authorization_private_keys, [authorizationKey]);
});

test("rejects malformed Privy authorization-key material before contacting Privy", () => {
  let calls = 0;
  const client = {
    wallets() {
      return { ethereum() { return { async signTypedData() { calls += 1; return { encoding: "hex", signature }; } }; } };
    },
  };
  assert.throws(() => createPrivyNodeEip712SigningClient({
    client,
    authorizationPrivateKey: "not-a-base64-pkcs8-key",
  }), /base64-encoded PKCS8/);
  assert.equal(calls, 0);
});

test("rejects malformed Privy signing responses", async () => {
  const client = {
    wallets() {
      return { ethereum() { return { async signTypedData() { return { encoding: "base64", signature: "bad" }; } }; } };
    },
  };
  const adapter = createPrivyNodeEip712SigningClient({
    client,
    authorizationPrivateKey: authorizationKey,
  });
  await assert.rejects(() => adapter.signTypedData({
    walletId: "privy-wallet-1",
    walletAddress,
    typedData: typedData(),
    idempotencyKey: "wolv-live-attempt-0002",
  }), /malformed EIP-712 signature response/);
});
