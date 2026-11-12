import { createBscRfqSettlementVerifier } from "./bsc-rfq-settlement-verifier";
import { createBscRpcClient } from "./bsc-rpc";
import type { LiveExecutionAttempt } from "./live-execution-domain";
import type { LiveChainSettlementVerifier } from "./live-execution-recovery";

export function createLiveRfqSettlementAdapter(input: {
  client?: ReturnType<typeof createBscRpcClient>;
  requiredConfirmations?: number;
}): LiveChainSettlementVerifier {
  const client = input.client ?? createBscRpcClient({});
  const requiredConfirmations = input.requiredConfirmations ?? 12;

  return {
    async verify(attempt: LiveExecutionAttempt) {
      if (!attempt.transaction_hash || !attempt.amount_in || !attempt.amount_out) {
        return { status: "UNKNOWN", reason: "Provider fill transaction or actual amount evidence is missing" };
      }
      // These allowlists were snapshotted from the owner policy at attempt creation.
      // They remain available for settlement even if the operator later engages
      // the global stop or disables new entries.
      if (!attempt.settlement_allowed_senders.length || !attempt.settlement_allowed_targets.length) {
        return { status: "UNKNOWN", reason: "The attempt has no verified RFQ transaction sender/target allowlist snapshot" };
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
        allowedTransactionSenders: attempt.settlement_allowed_senders,
        allowedTransactionTargets: attempt.settlement_allowed_targets,
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
