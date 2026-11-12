import test from "node:test";
import assert from "node:assert/strict";
import { loadPrivyServerConfig } from "../services/autonomy/privy-node-runtime.ts";

test("loads only server-side Privy wallet and authorization settings", () => {
  const config = loadPrivyServerConfig({
    PRIVY_APP_ID: "privy-app",
    PRIVY_APP_SECRET: "server-app-secret",
    PRIVY_WALLET_ID: "wallet-id",
    PRIVY_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
    PRIVY_AUTHORIZATION_PRIVATE_KEY: "base64-pkcs8-key",
  });
  assert.equal(config.appId, "privy-app");
  assert.equal(config.walletId, "wallet-id");
  assert.equal(config.walletAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(config.appSecret, "server-app-secret");
});

test("fails closed when a required Privy authorization value is absent", () => {
  assert.throws(() => loadPrivyServerConfig({
    PRIVY_APP_ID: "privy-app",
    PRIVY_APP_SECRET: "server-app-secret",
    PRIVY_WALLET_ID: "wallet-id",
    PRIVY_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
  }), /PRIVY_AUTHORIZATION_PRIVATE_KEY is required/);
});

test("rejects malformed Privy execution wallet addresses", () => {
  assert.throws(() => loadPrivyServerConfig({
    PRIVY_APP_ID: "privy-app",
    PRIVY_APP_SECRET: "server-app-secret",
    PRIVY_WALLET_ID: "wallet-id",
    PRIVY_WALLET_ADDRESS: "0xdead",
    PRIVY_AUTHORIZATION_PRIVATE_KEY: "base64-pkcs8-key",
  }), /must be an EVM address/);
});
