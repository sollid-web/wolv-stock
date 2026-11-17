import assert from "node:assert/strict";
import { test } from "node:test";
import { getNextIntentNonce } from "../services/agentIntentNonceTracker.ts";

const ACCOUNT = "0x0000000000000000000000000000000000000789";

test("generates unique cryptographically random bytes32 nonces without Redis", async () => {
  const values = await Promise.all(
    Array.from({ length: 128 }, () => getNextIntentNonce(ACCOUNT)),
  );
  assert.ok(values.every(value => /^0x[0-9a-f]{64}$/.test(value)));
  assert.ok(values.every(value => BigInt(value) !== 0n));
  assert.equal(new Set(values).size, values.length);
});

test("rejects invalid smart-account addresses", async () => {
  await assert.rejects(getNextIntentNonce("not-an-address"), /nonce|address/i);
});
