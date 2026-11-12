import { createBscRfqSettlementVerifier } from "./bsc-rfq-settlement-verifier";
import { createBscRpcClient } from "./bsc-rpc";
import type { LiveExecutionAttempt } from "./live-execution-domain";
import type { LiveChainSettlementVerifier } from "./live-execution-recovery";
import type { LiveExecutionPolicy } from "./supabase-live-portfolio-policy";

export function createLiveRfqSettlementAdapter(input: {
  client?: ReturnType<typeof createBscRpcClient>;
  loadPolicy(ownerId: string): Promise<LiveExecutionPolicy | null>;
  requiredConfirmations?: number;
}): LiveChainSettlementVerifier {
  const client = input.client ?? createBscRpcClient({});
  const requiredConfirmations = input.requiredConfirmations ?? 12;

  return {
    async verify(attempt: LiveExecutionAttempt) {
      if (!attempt.transaction_hash || !attempt.amount_in || !attempt.amount_out) {
        return { status: "UNKNOWN", reason: "Provider fill transaction or actual amount evidence is missing" };
      }
      const policy = await input.loadPolicy(attempt.owner_id);
      // Global stop and entry disable must not block reconciliation of a trade
      // that may already have been submitted. Settlement is risk-reducing recovery.
      if (!policy ||
          policy.walletAddress.toLowerCase() !== attempt.wallet_address.toLowerCase() ||
          policy.policyVersion !== attempt.policy_version) {
        return { status: "UNKNOWN", reason: "Live policy is disabled, stopped or no longer matches the attempt" };
      }
      if (!policy.allowedTransactionSenders.length || !policy.allowedTransactionTargets.length) {
        return { status: "UNKNOWN", reason: "Verified RFQ transaction sender and target allowlists are not configured" };
      }

      const verifier = createBscRfqSettlementVerifier(client);
      const result = await verifier.verify({
        chainId: attempt.chain_id,
        transactionHash: attempt.transaction_hash,
        walletAddress: attempt.wallet_address,
        inputTokenAddress: attempt.input_token_address,
        outputTokenAddress: attempt.token_address,
        expectedAmountIn: attempt.amount_in,
        expectedAmountOut: attempt.amount_out,
        allowedTransactionSenders: policy.allowedTransactionSenders,
        allowedTransactionTargets: policy.allowedTransactionTargets,
        minConfirmations: requiredConfirmations,
      });

      if (result.status === "SETTLED") {
        return {
          status: "SETTLED",
          transactionHash: result.transactionHash,
          amountIn: result.amountIn,
          amountOut: result.amountOut,
          feeAmount: result.feeWei,
          settlementBlock: result.blockNumber,
        };
      }
      if (result.status === "FAILED") {
        return { status: "FAILED", reasonCode: result.reasonCode };
      }
      return { status: "PENDING" };
    },
  };
}
