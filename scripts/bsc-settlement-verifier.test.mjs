import test from "node:test";
import assert from "node:assert/strict";
import { createBscSettlementVerifier } from "../services/autonomy/bsc-settlement-verifier.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const router = "0x4444444444444444444444444444444444444444";
const inputToken = "0x2222222222222222222222222222222222222222";
const outputToken = "0x3333333333333333333333333333333333333333";
const txHash = "0x" + "a".repeat(64);
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (address) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");
const log = (address, from, to, amount) => ({
  address, topics: [transferTopic, topic(from), topic(to)],
  data: "0x" + BigInt(amount).toString(16).padStart(64, "0"),
});

function fakeClient(overrides = {}) {
  return {
    async getReceipt() {
      return {
        transactionHash: txHash, status: "SUCCESS", blockNumber: "100",
        gasUsed: "21000", effectiveGasPrice: "1000000000",
        logs: [log(inputToken, wallet, router, "1000"), log(outputToken, router, wallet, "950")],
        ...overrides.receipt,
      };
    },
    async getTransaction() {
      return { hash: txHash, from: wallet, to: router, chainId: "56", ...overrides.transaction };
    },
    async getBlockNumber() { return overrides.head ?? "120"; },
  };
}
const request = {
  chainId: "56", walletAddress: wallet, expectedTarget: router,
  transactionHash: txHash, inputTokenAddress: inputToken, outputTokenAddress: outputToken,
  expectedAmountIn: "1000", minimumAmountOut: "940", minConfirmations: 12,
};

test("settles only after transaction identity, token deltas and confirmation checks pass", async () => {
  const verifier = createBscSettlementVerifier(fakeClient());
  const result = await verifier.verify(request);
  assert.deepEqual(result, {
    status: "SETTLED", amountIn: "1000", amountOut: "950",
    feeWei: "21000000000000", blockNumber: "100", confirmations: 21,
  });
});

test("waits for mining, transaction lookup and required confirmations", async () => {
  const notMined = createBscSettlementVerifier({ ...fakeClient(), async getReceipt() { return null; } });
  assert.deepEqual(await notMined.verify(request), { status: "PENDING", reason: "TRANSACTION_NOT_MINED" });
  const waiting = createBscSettlementVerifier(fakeClient({ head: "105" }));
  assert.deepEqual(await waiting.verify(request), { status: "PENDING", reason: "WAITING_FOR_CONFIRMATIONS" });
  const missingTx = createBscSettlementVerifier({ ...fakeClient(), async getTransaction() { return null; } });
  assert.deepEqual(await missingTx.verify(request), { status: "PENDING", reason: "TRANSACTION_LOOKUP_PENDING" });
});

test("rejects sender, router and chain mismatches", async () => {
  const verifier = createBscSettlementVerifier(fakeClient({ transaction: { from: router } }));
  assert.deepEqual(await verifier.verify(request), {
    status: "FAILED", reasonCode: "TRANSACTION_SENDER_TARGET_OR_CHAIN_MISMATCH",
  });
  const wrongTarget = createBscSettlementVerifier(fakeClient({ transaction: { to: wallet } }));
  assert.equal((await wrongTarget.verify(request)).status, "FAILED");
});

test("rejects reverted swaps and mismatched token balance deltas", async () => {
  const reverted = createBscSettlementVerifier(fakeClient({ receipt: { status: "FAILED" } }));
  assert.deepEqual(await reverted.verify(request), { status: "FAILED", reasonCode: "TRANSACTION_REVERTED" });
  const shortOutput = createBscSettlementVerifier(fakeClient({
    receipt: { logs: [log(inputToken, wallet, router, "1000"), log(outputToken, router, wallet, "900")] },
  }));
  assert.deepEqual(await shortOutput.verify(request), {
    status: "FAILED", reasonCode: "TOKEN_TRANSFER_DELTAS_DO_NOT_MATCH_ORDER",
  });
  const wrongInput = createBscSettlementVerifier(fakeClient({
    receipt: { logs: [log(inputToken, wallet, router, "999"), log(outputToken, router, wallet, "950")] },
  }));
  assert.equal((await wrongInput.verify(request)).status, "FAILED");
});

test("rejects malformed chain, amounts and confirmation policy", async () => {
  const verifier = createBscSettlementVerifier(fakeClient());
  await assert.rejects(verifier.verify({ ...request, chainId: "1" }), /chain 56/);
  await assert.rejects(verifier.verify({ ...request, expectedAmountIn: "0" }), /expected input amount/);
  await assert.rejects(verifier.verify({ ...request, minConfirmations: 0 }), /confirmation threshold/);
});
