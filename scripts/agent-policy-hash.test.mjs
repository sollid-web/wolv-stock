import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePacked, keccak256 } from "viem";
import { hashAgentPolicy } from "../lib/agentPolicyHash.ts";

const TOKEN = "0x0000000000000000000000000000000000000456";
const SIGNER = "0x0000000000000000000000000000000000000789";
const POLICY = {
  targetToken: TOKEN,
  maxTradeValue: 500_000_000_000_000_000n,
  expiresAt: 1_800_000_000n,
  intentSigner: SIGNER,
};

test("hashes policy fields using packed encoding in the documented order", () => {
  const expected = keccak256(encodePacked(
    ["address", "uint192", "uint64", "address"],
    [TOKEN, POLICY.maxTradeValue, POLICY.expiresAt, SIGNER],
  ));
  assert.equal(hashAgentPolicy(POLICY), expected);
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({
    ...POLICY,
    maxTradeValue: POLICY.maxTradeValue - 1n,
  }));
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({
    ...POLICY,
    intentSigner: TOKEN,
  }));
});

test("rejects zero policy addresses and values outside contract bounds", () => {
  assert.throws(
    () => hashAgentPolicy({ ...POLICY, targetToken: "0x0000000000000000000000000000000000000000" }),
    /must be nonzero/,
  );
  assert.throws(
    () => hashAgentPolicy({ ...POLICY, maxTradeValue: 500_000_000_000_000_001n }),
    /0.5 BNB/,
  );
  assert.throws(
    () => hashAgentPolicy({ ...POLICY, expiresAt: BigInt(1) << BigInt(64) }),
    /fit uint64/,
  );
});
