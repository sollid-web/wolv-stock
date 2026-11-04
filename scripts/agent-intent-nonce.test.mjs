import assert from "node:assert/strict";
import { test } from "node:test";
import { createIntentNonceAllocator } from "../services/agentIntentNonceTracker.ts";

const ACCOUNT = "0x0000000000000000000000000000000000000789";
const MIXED_CASE_ACCOUNT = "0xabcdef0000000000000000000000000000000789";

test("allocates a distinct padded bytes32 nonce atomically per normalized account", async () => {
  const values = new Map();
  const keys = [];
  const allocate = createIntentNonceAllocator(async key => {
    keys.push(key);
    const next = (values.get(key) ?? 0) + 1;
    values.set(key, next);
    await new Promise(resolve => setImmediate(resolve));
    return next;
  });

  const [first, second, third] = await Promise.all([
    allocate(MIXED_CASE_ACCOUNT),
    allocate(MIXED_CASE_ACCOUNT.toUpperCase().replace("0X", "0x")),
    allocate("0x0000000000000000000000000000000000000788"),
  ]);
  assert.equal(first, `0x${"0".repeat(63)}1`);
  assert.equal(second, `0x${"0".repeat(63)}2`);
  assert.equal(third, `0x${"0".repeat(63)}1`);
  assert.equal(new Set(keys).size, 2);
  assert.equal(keys[0], `wolv:agent:intent-nonce:${MIXED_CASE_ACCOUNT}`);
  assert.equal(keys[2], "wolv:agent:intent-nonce:0x0000000000000000000000000000000000000788");
});

test("fails closed on invalid addresses, failed Redis increments, and unsafe counters", async () => {
  const rejected = [
    createIntentNonceAllocator(async () => { throw new Error("offline"); })(ACCOUNT),
    createIntentNonceAllocator(async () => Number.MAX_SAFE_INTEGER + 1)(ACCOUNT),
    createIntentNonceAllocator(async () => 0)(ACCOUNT),
    createIntentNonceAllocator(async () => 1)("not-an-address"),
  ];
  for (const result of rejected) {
    await assert.rejects(result, /nonce|address|Redis|counter/i);
  }
});
