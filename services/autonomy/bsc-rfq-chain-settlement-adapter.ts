import type { ChainSettlementVerifier } from "./execution-contracts";
import { createBscRfqSettlementVerifier } from "./bsc-rfq-settlement-verifier";
import { createBscRpcClient } from "./bsc-rpc";

export interface TrustedRfqTransactionPolicy {
  allowedTransactionSenders: string[];
  allowedTransactionTargets: string[];
  minConfirmations: number;
}

function parseAddressList(raw: string | undefined, name: string): string[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(name + " must be a JSON array of EVM addresses");
  }
  if (!Array.isArray(parsed) || parsed.some((value) =>
    typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)
  )) {
    throw new Error(name + " must be a JSON array of EVM addresses");
  }
  return [...new Set(parsed.map((value: string) => value.toLowerCase()))];
}

export function loadTrustedRfqTransactionPolicy(
  env: Record<string, string | undefined> = process.env,
): TrustedRfqTransactionPolicy | null {
  const allowedTransactionSenders = parseAddressList(
    env.WOLV_AUTONOMY_BSC_TRUSTED_RFQ_SENDERS,
    "WOLV_AUTONOMY_BSC_TRUSTED_RFQ_SENDERS",
  );
  const allowedTransactionTargets = parseAddressList(
    env.WOLV_AUTONOMY_BSC_TRUSTED_RFQ_TARGETS,
    "WOLV_AUTONOMY_BSC_TRUSTED_RFQ_TARGETS",
  );
  if (!allowedTransactionSenders.length || !allowedTransactionTargets.length) return null;

  const minConfirmations = Number(env.WOLV_AUTONOMY_BSC_SETTLEMENT_CONFIRMATIONS ?? 12);
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 12 || minConfirmations > 256) {
    throw new Error("WOLV_AUTONOMY_BSC_SETTLEMENT_CONFIRMATIONS must be an integer from 12 to 256");
  }
  return { allowedTransactionSenders, allowedTransactionTargets, minConfirmations };
}

/**
 * ChainSettlementVerifier implementation for Binance RFQ fills. It uses a
 * separately configured BSC RPC endpoint, not Binance's transaction-detail
 * API, and fails closed until verified vendor relayers/routers are allowlisted.
 */
export function createBscRfqChainSettlementVerifier(input: {
  client?: Parameters<typeof createBscRfqSettlementVerifier>[0];
  loadPolicy?: (ownerId: string) => Promise<TrustedRfqTransactionPolicy | null>;
} = {}): ChainSettlementVerifier {
  const verifier = createBscRfqSettlementVerifier(input.client ?? createBscRpcClient({}));
  const loadPolicy = input.loadPolicy ?? (async () => loadTrustedRfqTransactionPolicy());

  return {
    async verify(request) {
      try {
        if (request.chainId !== "56") return { status: "FAILED", reasonCode: "UNSUPPORTED_CHAIN" };
        const trust = await loadPolicy(request.ownerId);
        if (!trust || !trust.allowedTransactionSenders.length || !trust.allowedTransactionTargets.length) {
          return { status: "UNKNOWN", reason: "TRUSTED_RFQ_CONTRACTS_NOT_CONFIGURED" };
        }
        const result = await verifier.verify({
          chainId: request.chainId,
          transactionHash: request.transactionHash,
          walletAddress: request.walletAddress,
          inputTokenAddress: request.inputTokenAddress,
          outputTokenAddress: request.outputTokenAddress,
          expectedAmountIn: request.expectedAmountIn,
          expectedAmountOut: request.expectedAmountOut,
          allowedTransactionSenders: trust.allowedTransactionSenders,
          allowedTransactionTargets: trust.allowedTransactionTargets,
          minConfirmations: trust.minConfirmations,
        });
        if (result.status === "PENDING") return { status: "PENDING" };
        if (result.status === "FAILED") return { status: "FAILED", reasonCode: result.reasonCode };
        return {
          status: "SETTLED",
          amountIn: result.amountIn,
          amountOut: result.amountOut,
          feeAmount: result.feeWei,
          blockNumber: result.blockNumber,
        };
      } catch (error) {
        return {
          status: "UNKNOWN",
          reason: error instanceof Error ? error.message.slice(0, 200) : "Independent BSC RFQ settlement verification failed",
        };
      }
    },
  };
}

export const bscRfqChainSettlementVerifier = createBscRfqChainSettlementVerifier();
