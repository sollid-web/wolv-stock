import { createBscRpcClient } from "./bsc-rpc";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface RfqSettlementRpcClient {
  getReceipt(hash: string): Promise<{
    transactionHash: string;
    status: "SUCCESS" | "FAILED";
    blockNumber: string;
    gasUsed: string;
    effectiveGasPrice: string;
    logs: Array<{ address: string; topics: string[]; data: string }>;
  } | null>;
  getTransaction(hash: string): Promise<{
    hash: string;
    from: string;
    to: string;
    chainId: string;
    data: string;
    value: string;
  } | null>;
  getBlockNumber(): Promise<string>;
}

function address(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new Error("Invalid " + field + " address");
  return value.toLowerCase();
}

function positiveUnits(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid " + field);
  return BigInt(value);
}

function topicAddress(value: string): string {
  if (!HASH.test(value)) throw new Error("Malformed ERC-20 Transfer address topic");
  return ("0x" + value.slice(-40)).toLowerCase();
}

function parseLogAmount(value: string): bigint {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("Malformed ERC-20 Transfer amount");
  return BigInt(value);
}

/**
 * Independently verifies a Binance RFQ fill from BSC transaction/receipt data.
 * Unlike a Classic swap, RFQ orders can be submitted by a vendor relayer, so
 * the transaction sender and target are constrained by explicit vendor
 * allowlists while the user's actual token balance deltas are verified.
 */
export function createBscRfqSettlementVerifier(
  client: RfqSettlementRpcClient = createBscRpcClient({}),
) {
  return {
    async verify(input: {
      chainId: string;
      transactionHash: string;
      walletAddress: string;
      inputTokenAddress: string;
      outputTokenAddress: string;
      expectedAmountIn: string;
      expectedAmountOut: string;
      allowedTransactionSenders: string[];
      allowedTransactionTargets: string[];
      minConfirmations?: number;
    }): Promise<
      | { status: "PENDING"; reason: string; confirmations?: number }
      | { status: "FAILED"; reasonCode: string }
      | {
          status: "SETTLED";
          transactionHash: string;
          chainId: "56";
          walletAddress: string;
          amountIn: string;
          amountOut: string;
          feeWei: string;
          blockNumber: string;
          confirmations: number;
        }
    > {
      if (input.chainId !== "56") throw new Error("RFQ settlement verifier supports BSC chain 56 only");
      if (!HASH.test(input.transactionHash)) throw new Error("Invalid RFQ settlement transaction hash");

      const wallet = address(input.walletAddress, "wallet");
      const tokenIn = address(input.inputTokenAddress, "input token");
      const tokenOut = address(input.outputTokenAddress, "output token");
      if (tokenIn === tokenOut) throw new Error("RFQ settlement input and output tokens must differ");

      const expectedIn = positiveUnits(input.expectedAmountIn, "expected input amount");
      const expectedOut = positiveUnits(input.expectedAmountOut, "expected output amount");

      if (!input.allowedTransactionSenders.length || !input.allowedTransactionTargets.length) {
        throw new Error("RFQ settlement sender and target allowlists must both be configured");
      }
      const senders = input.allowedTransactionSenders.map((value) => address(value, "approved transaction sender"));
      const targets = input.allowedTransactionTargets.map((value) => address(value, "approved transaction target"));
      const requiredConfirmations = input.minConfirmations ?? 12;
      if (!Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 1 || requiredConfirmations > 256) {
        throw new Error("Invalid RFQ settlement confirmation threshold");
      }

      const receipt = await client.getReceipt(input.transactionHash);
      if (!receipt) return { status: "PENDING", reason: "TRANSACTION_NOT_MINED" };
      if (receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
        throw new Error("BSC receipt hash does not match the requested RFQ transaction");
      }
      if (receipt.status === "FAILED") return { status: "FAILED", reasonCode: "BSC_TRANSACTION_REVERTED" };

      const transaction = await client.getTransaction(input.transactionHash);
      if (!transaction) return { status: "PENDING", reason: "TRANSACTION_LOOKUP_PENDING" };
      if (transaction.hash.toLowerCase() !== input.transactionHash.toLowerCase() ||
          transaction.chainId !== "56" ||
          !senders.includes(address(transaction.from, "transaction sender")) ||
          !targets.includes(address(transaction.to, "transaction target"))) {
        return { status: "FAILED", reasonCode: "RFQ_TRANSACTION_OUTSIDE_VERIFIED_VENDOR_ALLOWLIST" };
      }

      const block = BigInt(receipt.blockNumber);
      const head = BigInt(await client.getBlockNumber());
      if (head < block) return { status: "PENDING", reason: "RPC_HEAD_BEHIND_RECEIPT" };
      const confirmationsBig = head - block + 1n;
      if (confirmationsBig < BigInt(requiredConfirmations)) {
        return {
          status: "PENDING",
          reason: "WAITING_FOR_CONFIRMATIONS",
          confirmations: Number(confirmationsBig),
        };
      }

      let inputOut = 0n;
      let inputIn = 0n;
      let outputIn = 0n;
      let outputOut = 0n;
      let inputTransferSeen = false;
      let outputTransferSeen = false;

      for (const log of receipt.logs) {
        const token = address(log.address, "transfer-log token");
        if (token !== tokenIn && token !== tokenOut) continue;
        if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
        if (log.topics.length !== 3) throw new Error("Malformed ERC-20 Transfer topic count");

        const from = topicAddress(log.topics[1]);
        const to = topicAddress(log.topics[2]);
        const amount = parseLogAmount(log.data);
        if (amount === 0n) continue;

        if (token === tokenIn) {
          inputTransferSeen = true;
          if (from === wallet) inputOut += amount;
          if (to === wallet) inputIn += amount;
        } else {
          outputTransferSeen = true;
          if (to === wallet) outputIn += amount;
          if (from === wallet) outputOut += amount;
        }
      }

      const actualInputDebit = inputOut - inputIn;
      const actualOutputCredit = outputIn - outputOut;
      if (!inputTransferSeen || !outputTransferSeen ||
          actualInputDebit !== expectedIn || actualOutputCredit !== expectedOut) {
        return { status: "FAILED", reasonCode: "RFQ_TOKEN_DELTAS_DO_NOT_MATCH_EXECUTION_INTENT" };
      }

      const feeWei = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString();
      return {
        status: "SETTLED",
        transactionHash: input.transactionHash.toLowerCase(),
        chainId: "56",
        walletAddress: wallet,
        amountIn: actualInputDebit.toString(),
        amountOut: actualOutputCredit.toString(),
        feeWei,
        blockNumber: block.toString(),
        confirmations: Number(confirmationsBig),
      };
    },
  };
}
