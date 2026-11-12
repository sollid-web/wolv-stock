import test from "node:test";
import assert from "node:assert/strict";
import { createBscRfqSettlementVerifier } from "../services/autonomy/bsc-rfq-settlement-verifier.ts";

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

function fakeClient(overrides = {}) {
  return {
    async getReceipt() {
      return {
        transactionHash: txHash,
        status: "SUCCESS",
        blockNumber: "100",
        gasUsed: "21000",
        effectiveGasPrice: "1000000000",
        logs: [
          transfer(tokenIn, wallet, router, "1000"),
          transfer(tokenOut, router, wallet, "950"),
        ],
        ...overrides.receipt,
      };
    },
    async getTransaction() {
      return {
        hash: txHash, from: relayer, to: router, chainId: "56",
        data: "0x12345678", value: "0",
        ...overrides.transaction,
      };
    },
    async getBlockNumber() { return overrides.head ?? "120"; },
  };
}

const request = {
  chainId: "56",
  transactionHash: txHash,
  walletAddress: wallet,
  inputTokenAddress: tokenIn,
  outputTokenAddress: tokenOut,
  expectedAmountIn: "1000",
  expectedAmountOut: "940",
  allowedTransactionSenders: [relayer],
  allowedTransactionTargets: [router],
  minConfirmations: 12,
};

test("independently settles an RFQ using vendor transaction allowlists and wallet token deltas", async () => {
  const verifier = createBscRfqSettlementVerifier(fakeClient());
  const result = await verifier.verify(request);
  assert.deepEqual(result, {
    status: "SETTLED",
    transactionHash: txHash,
    chainId: "56",
    walletAddress: wallet,
    amountIn: "1000",
    amountOut: "950",
    feeWei: "21000000000000",
    blockNumber: "100",
    confirmations: 21,
  });
});

test("does not settle while receipt, transaction lookup or confirmations are pending", async () => {
  const noReceipt = createBscRfqSettlementVerifier({
    ...fakeClient(),
    async getReceipt() { return null; },
  });
  assert.deepEqual(await noReceipt.verify(request), { status: "PENDING", reason: "TRANSACTION_NOT_MINED" });

  const noTransaction = createBscRfqSettlementVerifier({
    ...fakeClient(),
    async getTransaction() { return null; },
  });
  assert.deepEqual(await noTransaction.verify(request), { status: "PENDING", reason: "TRANSACTION_LOOKUP_PENDING" });

  const waiting = createBscRfqSettlementVerifier(fakeClient({ head: "105" }));
  assert.deepEqual(await waiting.verify(request), {
    status: "PENDING", reason: "WAITING_FOR_CONFIRMATIONS", confirmations: 6,
  });
});

test("rejects unapproved relayers/routers and reverted transactions", async () => {
  const wrongRelayer = createBscRfqSettlementVerifier(fakeClient({
    transaction: { from: "0x6666666666666666666666666666666666666666" },
  }));
  assert.deepEqual(await wrongRelayer.verify(request), {
    status: "FAILED", reasonCode: "RFQ_TRANSACTION_OUTSIDE_VERIFIED_VENDOR_ALLOWLIST",
  });

  const wrongRouter = createBscRfqSettlementVerifier(fakeClient({
    transaction: { to: "0x7777777777777777777777777777777777777777" },
  }));
  assert.equal((await wrongRouter.verify(request)).status, "FAILED");

  const reverted = createBscRfqSettlementVerifier(fakeClient({ receipt: { status: "FAILED" } }));
  assert.deepEqual(await reverted.verify(request), {
    status: "FAILED", reasonCode: "BSC_TRANSACTION_REVERTED",
  });
});

test("rejects wrong actual debit, insufficient output, and missing transfer logs", async () => {
  const wrongDebit = createBscRfqSettlementVerifier(fakeClient({
    receipt: { logs: [transfer(tokenIn, wallet, router, "999"), transfer(tokenOut, router, wallet, "950")] },
  }));
  assert.deepEqual(await wrongDebit.verify(request), {
    status: "FAILED", reasonCode: "RFQ_TOKEN_DELTAS_DO_NOT_MATCH_EXECUTION_INTENT",
  });

  const insufficientOut = createBscRfqSettlementVerifier(fakeClient({
    receipt: { logs: [transfer(tokenIn, wallet, router, "1000"), transfer(tokenOut, router, wallet, "900")] },
  }));
  assert.equal((await insufficientOut.verify(request)).status, "FAILED");

  const noOutput = createBscRfqSettlementVerifier(fakeClient({
    receipt: { logs: [transfer(tokenIn, wallet, router, "1000")] },
  }));
  assert.equal((await noOutput.verify(request)).status, "FAILED");
});

test("requires non-empty transaction allowlists and valid confirmation settings", async () => {
  const verifier = createBscRfqSettlementVerifier(fakeClient());
  await assert.rejects(() => verifier.verify({ ...request, allowedTransactionSenders: [] }), /allowlists must both be configured/);
  await assert.rejects(() => verifier.verify({ ...request, minConfirmations: 0 }), /confirmation threshold/);
  await assert.rejects(() => verifier.verify({ ...request, expectedAmountIn: "0" }), /expected input amount/);
});
