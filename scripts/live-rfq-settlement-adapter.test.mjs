import test from "node:test";
import assert from "node:assert/strict";
import { createLiveRfqSettlementAdapter } from "../services/autonomy/live-rfq-settlement-adapter.ts";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const wallet = "0x1111111111111111111111111111111111111111";
const relayer = "0x2222222222222222222222222222222222222222";
const router = "0x3333333333333333333333333333333333333333";
const tokenIn = "0x4444444444444444444444444444444444444444";
const tokenOut = "0x5555555555555555555555555555555555555555";
const txHash = `0x${"a".repeat(64)}`;
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const transfer = (token, from, to, amount) => ({
  address: token,
  topics: [transferTopic, topic(from), topic(to)],
  data: `0x${BigInt(amount).toString(16).padStart(64, "0")}`,
});

const attempt = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  owner_id: ownerId,
  intent_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  attempt_number: 1,
  request_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  provider: "binance-web3-aggregator",
  chain_id: "56",
  wallet_address: wallet,
  token_address: tokenOut,
  input_token_address: tokenIn,
  expected_amount_in: "1000",
  minimum_amount_out: "940",
  settlement_allowed_senders: [relayer],
  settlement_allowed_targets: [router],
  status: "SETTLEMENT_PENDING",
  version: 5,
  execution_side: "BUY",
  policy_version: "live-policy-1",
  quote_expires_at: new Date().toISOString(),
  simulation_fingerprint: "e".repeat(64),
  simulated_at: new Date().toISOString(),
  native_gas_balance_wei: "1000000000000000000",
  native_gas_preflight_at: new Date().toISOString(),
  provider_idempotency_window_seconds: 0,
  submission_started_at: new Date().toISOString(),
  retry_not_after: null,
  provider_quote_id: "a".repeat(32),
  provider_order_id: "rfq-order-1",
  prepared_payload_hash: "f".repeat(64),
  signer_operation_id: "signer-operation-123",
  signer_address: wallet,
  transaction_hash: txHash,
  amount_in: "1000",
  amount_out: "950",
  fee_amount: null,
  settlement_block: null,
  last_error_code: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

test("continues settlement recovery with new-entry kill switch engaged", async () => {
  const client = {
    async getReceipt() {
      return {
        transactionHash: txHash, status: "SUCCESS", blockNumber: "100",
        gasUsed: "21000", effectiveGasPrice: "1000000000",
        logs: [transfer(tokenIn, wallet, router, "1000"), transfer(tokenOut, router, wallet, "950")],
      };
    },
    async getTransaction() {
      return { hash: txHash, from: relayer, to: router, chainId: "56", data: "0x12345678", value: "0" };
    },
    async getBlockNumber() { return "120"; },
  };
  const adapter = createLiveRfqSettlementAdapter({ client });
  const result = await adapter.verify(attempt);
  assert.equal(result.status, "SETTLED");
  if (result.status === "SETTLED") {
    assert.equal(result.amountIn, "1000");
    assert.equal(result.amountOut, "950");
    assert.equal(result.feeAmount, "21000000000000");
  }
});

test("fails closed when an attempt has no snapshotted vendor allowlists", async () => {
  const client = {
    async getReceipt() { throw new Error("should not query chain"); },
    async getTransaction() { throw new Error("should not query chain"); },
    async getBlockNumber() { throw new Error("should not query chain"); },
  };
  const adapter = createLiveRfqSettlementAdapter({ client });
  const result = await adapter.verify({
    ...attempt,
    settlement_allowed_senders: [],
    settlement_allowed_targets: [],
  });
  assert.equal(result.status, "UNKNOWN");
});
