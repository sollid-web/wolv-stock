import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, keccak256 } from "viem";
import { hashAgentPolicy } from "../lib/agentPolicyHash.ts";

const ACCOUNT = "0x0000000000000000000000000000000000000789";
const TOKEN = "0x0000000000000000000000000000000000000456";
const SIGNER = "0x0000000000000000000000000000000000000789";
const POLICY = {
  strategyId: "aapl-entry",
  account: ACCOUNT,
  targetToken: TOKEN,
  maxTradeValue: 500_000_000_000_000_000n,
  expiresAt: 1_800_000_000n,
  intentSigner: SIGNER,
  amountBnb: 100_000_000_000_000_000n,
  entryPriceMicros: 100_000_000n,
  slippageBps: 100,
  maxPriceImpactBps: 300,
};

test("hashes the complete strategy policy using versioned ABI encoding", () => {
  const expected = keccak256(encodeAbiParameters(
    [
      { type: "string" }, { type: "string" }, { type: "address" }, { type: "address" },
      { type: "uint192" }, { type: "uint64" }, { type: "address" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "uint16" },
    ],
    [
      "WOLV_AGENT_POLICY_V3", POLICY.strategyId, ACCOUNT, TOKEN, POLICY.maxTradeValue,
      POLICY.expiresAt, SIGNER, POLICY.amountBnb, POLICY.entryPriceMicros,
      POLICY.slippageBps, POLICY.maxPriceImpactBps,
    ],
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
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({
    ...POLICY,
    strategyId: "unknown-strategy",
  }));
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({ ...POLICY, account: TOKEN }));
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({ ...POLICY, amountBnb: POLICY.amountBnb + 1n }));
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({ ...POLICY, entryPriceMicros: POLICY.entryPriceMicros + 1n }));
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({ ...POLICY, slippageBps: 101 }));
  assert.notEqual(hashAgentPolicy(POLICY), hashAgentPolicy({ ...POLICY, maxPriceImpactBps: 299 }));
});

test("rejects strategy limits outside the validator's hard bounds", () => {
  assert.throws(() => hashAgentPolicy({ ...POLICY, amountBnb: 0n }), /strategy amount/);
  assert.throws(() => hashAgentPolicy({ ...POLICY, amountBnb: POLICY.maxTradeValue + 1n }), /strategy amount/);
  assert.throws(() => hashAgentPolicy({ ...POLICY, entryPriceMicros: 0n }), /entry-price/);
  assert.throws(() => hashAgentPolicy({ ...POLICY, slippageBps: 501 }), /slippage/);
  assert.throws(() => hashAgentPolicy({ ...POLICY, maxPriceImpactBps: 301 }), /price impact/);
});

test("rejects unknown or malformed strategy labels", () => {
  assert.throws(() => hashAgentPolicy({ ...POLICY, strategyId: "" }), /strategy ID/);
  assert.throws(() => hashAgentPolicy({ ...POLICY, strategyId: "aapl entry" }), /strategy ID/);
  assert.throws(() => hashAgentPolicy({ ...POLICY, strategyId: "x".repeat(65) }), /strategy ID/);
});

test("rejects zero policy addresses and values outside contract bounds", () => {
  assert.throws(
    () => hashAgentPolicy({ ...POLICY, account: "0x0000000000000000000000000000000000000000" }),
    /must be nonzero/,
  );
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
