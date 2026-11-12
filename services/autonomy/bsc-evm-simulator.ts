import { createBscRpcClient } from "./bsc-rpc";
import type { EvmTransactionSimulator, PreparedEvmTransaction } from "./provider-contracts";

/**
 * Executes read-only eth_call + eth_estimateGas against BSC for the exact
 * unsigned transaction returned by an execution adapter. It does not sign
 * or broadcast. The returned fingerprint identifies the exact RPC payload.
 */
export function createBscEvmTransactionSimulator(
  client = createBscRpcClient(),
): EvmTransactionSimulator {
  return {
    async simulate(input: PreparedEvmTransaction) {
      if (input.chainId !== "56") throw new Error("BSC simulator only accepts chain 56");
      const quoteExpiry = Date.parse(input.quoteExpiresAt);
      if (!Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now()) {
        throw new Error("Cannot simulate an expired execution quote");
      }
      const result = await client.simulateTransaction({
        from: input.walletAddress,
        to: input.to,
        data: input.data,
        value: input.value,
        gasPrice: input.gasPrice,
        gasLimit: input.gasLimit,
      });
      if (result.chainId !== input.chainId) throw new Error("Simulation RPC chain does not match prepared transaction");
      if (BigInt(result.gasEstimate) > BigInt(input.gasLimit)) {
        throw new Error("Independent gas estimate exceeds prepared transaction gas limit");
      }
      return {
        success: true as const,
        chainId: result.chainId,
        gasEstimate: result.gasEstimate,
        simulatedAt: result.simulatedAt,
        transactionFingerprint: result.fingerprint,
      };
    },
    getNativeBalance: (walletAddress) => client.getNativeBalance(walletAddress),
    getGasPrice: () => client.getGasPrice(),
  };
}
