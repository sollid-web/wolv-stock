import test from "node:test";
import assert from "node:assert/strict";
import {
  createBscRfqChainSettlementVerifier,
  loadTrustedRfqTransactionPolicy,
} from "../services/autonomy/bsc-rfq-chain-settlement-adapter.ts";

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

function client(overrides = {}) {
  return {
    async getReceipt() {
      return {
        transactionHash: txHash, status: "SUCCESS", blockNumber: "100",
        gasUsed: "21000", effectiveGasPrice: "1000000000",
        logs: [transfer(tokenIn, wallet, router, "1000"), transfer(tokenOut, router, wallet, "950")],
        ...overrides.receipt,
      };
    },
    async getTransaction() {
      return { hash: txHash, from: relayer, to: router, chainId: "56", data: "0x1234", value: "0" };
    },
    async getBlockNumber() { return "120"; },
  };
}

const request = {
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  walletAddress: wallet,
  chainId: "56",
  transactionHash: txHash,
  inputTokenAddress: tokenIn,
  outputTokenAddress: tokenOut,
  expectedAmountIn: "1000",
  expectedAmountOut: "950",
};

test("maps independent BSC receipt and token deltas to the live settlement contract", async () => {
  const verifier = createBscRfqChainSettlementVerifier({
    client: client(),
    loadPolicy: async (ownerId) => {
      assert.equal(ownerId, request.ownerId);
      return {
        allowedTransactionSenders: [relayer],
        allowedTransactionTargets: [router],
        minConfirmations: 12,
      };
    },
  });
  assert.deepEqual(await verifier.verify(request), {
    status: "SETTLED",
    amountIn: "1000",
    amountOut: "950",
    feeAmount: "21000000000000",
    blockNumber: "100",
  });
});

test("fails closed when no trusted RFQ vendor contract allowlist is configured", async () => {
  const verifier = createBscRfqChainSettlementVerifier({
    client: client(),
    loadPolicy: async () => null,
  });
  assert.deepEqual(await verifier.verify(request), {
    status: "UNKNOWN",
    reason: "TRUSTED_RFQ_CONTRACTS_NOT_CONFIGURED",
  });
});

test("returns pending and failed states without marking them settled", async () => {
  const pending = createBscRfqChainSettlementVerifier({
    client: { ...client(), async getReceipt() { return null; } },
    loadPolicy: async () => ({ allowedTransactionSenders: [relayer], allowedTransactionTargets: [router], minConfirmations: 12 }),
  });
  assert.deepEqual(await pending.verify(request), { status: "PENDING" });

  const failed = createBscRfqChainSettlementVerifier({
    client: { ...client(), async getReceipt() { return { ...await client().getReceipt(), status: "FAILED" }; } },
    loadPolicy: async () => ({ allowedTransactionSenders: [relayer], allowedTransactionTargets: [router], minConfirmations: 12 }),
  });
  assert.deepEqual(await failed.verify(request), { status: "FAILED", reasonCode: "BSC_TRANSACTION_REVERTED" });
});

test("parses and validates trusted RFQ sender and target configuration", () => {
  assert.equal(loadTrustedRfqTransactionPolicy({}), null);
  assert.deepEqual(loadTrustedRfqTransactionPolicy({
    WOLV_AUTONOMY_BSC_TRUSTED_RFQ_SENDERS: JSON.stringify([relayer, relayer.toUpperCase()]),
    WOLV_AUTONOMY_BSC_TRUSTED_RFQ_TARGETS: JSON.stringify([router]),
    WOLV_AUTONOMY_BSC_SETTLEMENT_CONFIRMATIONS: "18",
  }), {
    allowedTransactionSenders: [relayer],
    allowedTransactionTargets: [router],
    minConfirmations: 18,
  });
  assert.throws(() => loadTrustedRfqTransactionPolicy({
    WOLV_AUTONOMY_BSC_TRUSTED_RFQ_SENDERS: "not-json",
    WOLV_AUTONOMY_BSC_TRUSTED_RFQ_TARGETS: JSON.stringify([router]),
  }), /JSON array/);
});
