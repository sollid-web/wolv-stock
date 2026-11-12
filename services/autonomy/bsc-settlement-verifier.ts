import { createBscRpcClient } from "./bsc-rpc";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function normalizedAddress(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new Error("Invalid " + field + " address");
  return value.toLowerCase();
}
function positiveUnits(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid " + field);
  return BigInt(value);
}
function topicAddress(value: string): string {
  if (!HASH.test(value)) throw new Error("Malformed ERC-20 Transfer address topic");
  return "0x" + value.slice(-40).toLowerCase();
}

/**
 * Independently verifies a Classic EVM swap from transaction, receipt and
 * ERC-20 Transfer logs. Provider success alone is never considered settlement.
 */
export function createBscSettlementVerifier(
  client = createBscRpcClient(),
) {
  return {
    async verify(input: {
      chainId: string;
      walletAddress: string;
      expectedTarget: string;
      transactionHash: string;
      inputTokenAddress: string;
      outputTokenAddress: string;
      expectedAmountIn: string;
      minimumAmountOut: string;
      minConfirmations?: number;
    }): Promise<
      | { status: "PENDING"; reason: string }
      | { status: "FAILED"; reasonCode: string }
      | { status: "SETTLED"; amountIn: string; amountOut: string; feeWei: string; blockNumber: string; confirmations: number }
    > {
      if (input.chainId !== "56") throw new Error("BSC settlement verifier supports chain 56 only");
      if (!HASH.test(input.transactionHash)) throw new Error("Invalid transaction hash");
      const wallet = normalizedAddress(input.walletAddress, "wallet");
      const target = normalizedAddress(input.expectedTarget, "expected transaction target");
      const inputToken = normalizedAddress(input.inputTokenAddress, "input token");
      const outputToken = normalizedAddress(input.outputTokenAddress, "output token");
      if (inputToken === outputToken) throw new Error("Settlement token addresses must differ");
      const expectedIn = positiveUnits(input.expectedAmountIn, "expected input amount");
      const minimumOut = positiveUnits(input.minimumAmountOut, "minimum output amount");
      const minConfirmations = input.minConfirmations ?? 12;
      if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 256) {
        throw new Error("Invalid BSC confirmation threshold");
      }

      const receipt = await client.getReceipt(input.transactionHash);
      if (!receipt) return { status: "PENDING", reason: "TRANSACTION_NOT_MINED" };
      if (receipt.status === "FAILED") return { status: "FAILED", reasonCode: "TRANSACTION_REVERTED" };
      const transaction = await client.getTransaction(input.transactionHash);
      if (!transaction) return { status: "PENDING", reason: "TRANSACTION_LOOKUP_PENDING" };
      if (transaction.chainId !== "56" || transaction.from !== wallet || transaction.to !== target) {
        return { status: "FAILED", reasonCode: "TRANSACTION_SENDER_TARGET_OR_CHAIN_MISMATCH" };
      }

      const blockNumber = BigInt(receipt.blockNumber);
      const head = BigInt(await client.getBlockNumber());
      if (head < blockNumber) return { status: "PENDING", reason: "RPC_HEAD_BEHIND_RECEIPT" };
      const confirmationsBig = head - blockNumber + BigInt(1);
      if (confirmationsBig < BigInt(minConfirmations)) {
        return { status: "PENDING", reason: "WAITING_FOR_CONFIRMATIONS" };
      }

      let inputOutgoing = BigInt(0);
      let inputIncoming = BigInt(0);
      let outputIncoming = BigInt(0);
      let outputOutgoing = BigInt(0);
      let sawInputTransfer = false;
      let sawOutputTransfer = false;

      for (const log of receipt.logs) {
        const token = log.address.toLowerCase();
        if (token !== inputToken && token !== outputToken) continue;
        if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
        const fromTopic = log.topics[1];
        const toTopic = log.topics[2];
        if (log.topics.length < 3 || !fromTopic || !toTopic || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
          throw new Error("Malformed ERC-20 Transfer log in settlement receipt");
        }
        const from = topicAddress(fromTopic);
        const to = topicAddress(toTopic);
        const amount = BigInt(log.data);
        if (amount <= BigInt(0)) continue;
        if (token === inputToken) {
          sawInputTransfer = true;
          if (from === wallet) inputOutgoing += amount;
          if (to === wallet) inputIncoming += amount;
        } else {
          sawOutputTransfer = true;
          if (from === wallet) outputOutgoing += amount;
          if (to === wallet) outputIncoming += amount;
        }
      }

      const actualInputDebit = inputOutgoing - inputIncoming;
      const actualOutputCredit = outputIncoming - outputOutgoing;
      if (!sawInputTransfer || !sawOutputTransfer || actualInputDebit !== expectedIn || actualOutputCredit < minimumOut) {
        return { status: "FAILED", reasonCode: "TOKEN_TRANSFER_DELTAS_DO_NOT_MATCH_ORDER" };
      }
      const feeWei = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString();
      return {
        status: "SETTLED",
        amountIn: actualInputDebit.toString(),
        amountOut: actualOutputCredit.toString(),
        feeWei,
        blockNumber: receipt.blockNumber,
        confirmations: Number(confirmationsBig),
      };
    },
  };
}
