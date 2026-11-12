import { getTransactionDetailByTxHash } from "../../lib/binance";
import type { ChainSettlementVerifier } from "./execution-contracts";

type Row = Record<string, unknown>;
function record(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}
function decimal(value: unknown): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) return null;
  return value;
}

export function parseBinanceBscSettlement(input: {
  response: unknown; expectedTxHash: string; walletAddress: string;
  inputTokenAddress: string; outputTokenAddress: string;
  expectedAmountIn: string; expectedAmountOut: string; now?: number;
}) {
  const now = input.now ?? Date.now();
  const unknown = (reason: string) => ({ status: "UNKNOWN" as const, reason });
  if (!record(input.response) || input.response.code !== 0 || input.response.success !== true ||
      !Array.isArray(input.response.data)) return unknown("Transaction detail response is malformed");
  const responseTime = Number(input.response.timestamp);
  if (!Number.isSafeInteger(responseTime) || responseTime <= 0 || responseTime > now + 5_000 || now - responseTime > 30_000) {
    return unknown("Transaction detail response timestamp is invalid or stale");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.expectedTxHash) ||
      !/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress) ||
      !/^0x[0-9a-fA-F]{40}$/.test(input.inputTokenAddress) ||
      !/^0x[0-9a-fA-F]{40}$/.test(input.outputTokenAddress) ||
      !/^[1-9][0-9]*$/.test(input.expectedAmountIn) ||
      !/^[1-9][0-9]*$/.test(input.expectedAmountOut)) return unknown("Settlement verification request is invalid");

  const tx = input.response.data.find((candidate: unknown) =>
    record(candidate) && typeof candidate.txhash === "string" &&
    candidate.txhash.toLowerCase() === input.expectedTxHash.toLowerCase(),
  );
  if (!record(tx)) return { status: "PENDING" as const };
  if (tx.txStatus === "pending" || tx.txStatus === "confirming") return { status: "PENDING" as const };
  if (tx.txStatus !== "success") {
    if (tx.txStatus === "failed" || tx.txStatus === "fail") return { status: "FAILED" as const, reasonCode: "BSC_TRANSACTION_FAILED" };
    return unknown("Unrecognized transaction status: " + String(tx.txStatus));
  }
  if (!Array.isArray(tx.tokenTransferDetails)) return unknown("Successful transaction has no token transfer evidence");
  const wallet = input.walletAddress.toLowerCase();
  const inputToken = input.inputTokenAddress.toLowerCase();
  const outputToken = input.outputTokenAddress.toLowerCase();
  let actualIn = BigInt(0);
  let actualOut = BigInt(0);
  for (const transfer of tx.tokenTransferDetails) {
    if (!record(transfer) || typeof transfer.from !== "string" || typeof transfer.to !== "string" ||
        typeof transfer.tokenContractAddress !== "string") continue;
    const amount = integer(transfer.amount);
    if (amount === null) continue;
    const token = transfer.tokenContractAddress.toLowerCase();
    if (token === inputToken && transfer.from.toLowerCase() === wallet) actualIn += amount;
    if (token === outputToken && transfer.to.toLowerCase() === wallet) actualOut += amount;
  }
  if (actualIn.toString() !== input.expectedAmountIn || actualOut.toString() !== input.expectedAmountOut) {
    return unknown("On-chain token transfer amounts do not match the RFQ provider settlement amounts");
  }
  const feeAmount = decimal(tx.txFee);
  if (feeAmount === null) return unknown("Successful transaction is missing a valid network fee amount");
  return {
    status: "SETTLED" as const,
    amountIn: actualIn.toString(), amountOut: actualOut.toString(),
    feeAmount, blockNumber: String(tx.height ?? ""),
  };
}

export const binanceBscSettlementVerifier: ChainSettlementVerifier = {
  async verify(input) {
    try {
      const response = await getTransactionDetailByTxHash(input.chainId, input.transactionHash);
      const result = parseBinanceBscSettlement({
        response, expectedTxHash: input.transactionHash, walletAddress: input.walletAddress,
        inputTokenAddress: input.inputTokenAddress, outputTokenAddress: input.outputTokenAddress,
        // These expected amounts must be supplied by the persisted submitted order evidence.
        expectedAmountIn: "0", expectedAmountOut: "0",
      });
      if (result.status === "SETTLED") {
        return { ...result, blockNumber: result.blockNumber || "0" };
      }
      return result;
    } catch (error) {
      return { status: "UNKNOWN", reason: error instanceof Error ? error.message.slice(0, 200) : "Transaction verification failed" };
    }
  },
};
