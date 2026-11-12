import test from "node:test";
import assert from "node:assert/strict";
import { createBscEvmTransactionSimulator } from "../services/autonomy/bsc-evm-simulator.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const tx = {
  kind: "EVM_TRANSACTION", provider: "1inch-classic", chainId: "56",
  walletAddress: wallet, inputTokenAddress: "0x2222222222222222222222222222222222222222",
  outputTokenAddress: "0x3333333333333333333333333333333333333333",
  amountIn: "1000", minimumAmountOut: "900",
  to: "0x4444444444444444444444444444444444444444",
  data: "0x12345678", value: "0", gasLimit: "50000", gasPrice: "1000000000",
  transactionFingerprint: "provider-fingerprint",
  preparedAt: new Date().toISOString(),
  quoteExpiresAt: new Date(Date.now() + 10_000).toISOString(),
};

test("BSC simulator checks chain and gas bound for exact prepared EVM payload", async () => {
  const calls = [];
  const client = {
    async simulateTransaction(input) {
      calls.push(input);
      return { success: true, chainId: "56", gasEstimate: "42000",
        simulatedAt: new Date().toISOString(), fingerprint: "rpc-fingerprint" };
    },
    async getNativeBalance() { return "100"; },
    async getGasPrice() { return { wei: "1000000000", observedAt: new Date().toISOString() }; },
  };
  const simulator = createBscEvmTransactionSimulator(client);
  const result = await simulator.simulate(tx);
  assert.equal(result.success, true);
  assert.equal(result.gasEstimate, "42000");
  assert.equal(result.transactionFingerprint, "rpc-fingerprint");
  assert.equal(calls[0].from, wallet);
  assert.equal(calls[0].data, tx.data);
});

test("BSC simulator rejects wrong chain, expired quote and gas-limit overrun", async () => {
  const client = {
    async simulateTransaction() {
      return { success: true, chainId: "56", gasEstimate: "60000",
        simulatedAt: new Date().toISOString(), fingerprint: "x" };
    },
    async getNativeBalance() { return "0"; },
    async getGasPrice() { return { wei: "1", observedAt: new Date().toISOString() }; },
  };
  const simulator = createBscEvmTransactionSimulator(client);
  await assert.rejects(simulator.simulate({ ...tx, chainId: "1" }), /chain 56/);
  await assert.rejects(simulator.simulate({ ...tx, quoteExpiresAt: new Date(Date.now() - 1).toISOString() }), /expired/);
  await assert.rejects(simulator.simulate(tx), /exceeds prepared transaction gas limit/);
});
