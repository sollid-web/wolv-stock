import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceBscSettlement } from "../services/autonomy/binance-chain-settlement-verifier.ts";

const now = 1794400000000;
const wallet = "0x1111111111111111111111111111111111111111";
const inputToken = "0x2222222222222222222222222222222222222222";
const outputToken = "0x3333333333333333333333333333333333333333";
const txHash = "0x" + "a".repeat(64);
const response = (tx, timestamp = now) => ({ code: 0, success: true, timestamp, data: [tx] });
const transaction = {
  chainIndex: "56", txhash: txHash, txStatus: "success", height: "123456", txFee: "0.0002",
  tokenTransferDetails: [
    { from: wallet, to: "0x4444444444444444444444444444444444444444", tokenContractAddress: inputToken, amount: "1000" },
    { from: "0x4444444444444444444444444444444444444444", to: wallet, tokenContractAddress: outputToken, amount: "950" },
  ],
};
const input = {
  chainId: "56", expectedTxHash: txHash, walletAddress: wallet,
  inputTokenAddress: inputToken, outputTokenAddress: outputToken,
  expectedAmountIn: "1000", expectedAmountOut: "950", now,
};

test("verifies successful BSC receipt token transfers against provider settlement amounts", () => {
  const result = parseBinanceBscSettlement({ ...input, response: response(transaction) });
  assert.deepEqual(result, {
    status: "SETTLED", amountIn: "1000", amountOut: "950",
    feeAmount: "0.0002", blockNumber: "123456",
  });
});
test("missing transaction remains pending", () => {
  assert.deepEqual(parseBinanceBscSettlement({ ...input, response: response({ ...transaction, txhash: "0x" + "b".repeat(64) }) }),
    { status: "PENDING" });
});
test("failed transaction is terminal failure", () => {
  assert.deepEqual(parseBinanceBscSettlement({ ...input, response: response({ ...transaction, txStatus: "failed" }) }),
    { status: "FAILED", reasonCode: "BSC_TRANSACTION_FAILED" });
});
test("mismatched chain, amounts, wallet direction and stale evidence fail closed", () => {
  assert.equal(parseBinanceBscSettlement({ ...input, response: response({ ...transaction, chainIndex: "1" }) }).status, "UNKNOWN");
  assert.equal(parseBinanceBscSettlement({ ...input, response: response({ ...transaction, tokenTransferDetails: [] }) }).status, "UNKNOWN");
  assert.equal(parseBinanceBscSettlement({ ...input, expectedAmountOut: "951", response: response(transaction) }).status, "UNKNOWN");
  assert.equal(parseBinanceBscSettlement({ ...input, response: response(transaction, now - 60_000) }).status, "UNKNOWN");
});
test("missing fee or block evidence cannot be called settled", () => {
  assert.equal(parseBinanceBscSettlement({ ...input, response: response({ ...transaction, txFee: null }) }).status, "UNKNOWN");
  assert.equal(parseBinanceBscSettlement({ ...input, response: response({ ...transaction, height: "0" }) }).status, "UNKNOWN");
});
