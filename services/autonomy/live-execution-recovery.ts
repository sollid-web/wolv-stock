import type { LiveExecutionAttempt, LiveExecutionStatus } from "./live-execution-domain";
import type { ReconciliationResult } from "./execution-contracts";

export type LiveSettlementVerification =
  | {
      status: "SETTLED";
      transactionHash: string;
      amountIn: string;
      amountOut: string;
      feeAmount: string;
      settlementBlock: string;
    }
  | { status: "PENDING"; reason?: string }
  | { status: "FAILED"; reasonCode: string }
  | { status: "UNKNOWN"; reason: string };

export interface LiveExecutionRecoveryRepository {
  listRecoverable(ownerId: string, limit?: number): Promise<LiveExecutionAttempt[]>;
  listSettled(ownerId: string, limit?: number): Promise<LiveExecutionAttempt[]>;
  transition(input: {
    ownerId: string;
    attemptId: string;
    expectedVersion: number;
    nextStatus: LiveExecutionStatus;
    eventType: string;
    actor: string;
    detail?: Record<string, unknown>;
    evidence?: Record<string, string>;
  }): Promise<LiveExecutionAttempt | null>;
  commitFill(ownerId: string, attemptId: string): Promise<boolean>;
  releaseBudget(ownerId: string, attemptId: string): Promise<boolean>;
}

export interface LiveRfqReconciler {
  reconcile(input: {
    ownerId: string;
    intentId: string;
    requestId: string;
    providerOrderId: string;
  }): Promise<ReconciliationResult>;
}

export interface LiveChainSettlementVerifier {
  verify(attempt: LiveExecutionAttempt): Promise<LiveSettlementVerification>;
}

export type LiveRecoveryReport = {
  scanned: number;
  reconciled: number;
  providerPending: number;
  settled: number;
  failed: number;
  held: number;
  unchanged: number;
  errors: number;
};

function result(): LiveRecoveryReport {
  return {
    scanned: 0,
    reconciled: 0,
    providerPending: 0,
    settled: 0,
    failed: 0,
    held: 0,
    unchanged: 0,
    errors: 0,
  };
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "UNKNOWN_RECOVERY_ERROR";
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96) || "UNKNOWN_RECOVERY_ERROR";
}

export function createLiveExecutionRecovery(dependencies: {
  repository: LiveExecutionRecoveryRepository;
  provider: LiveRfqReconciler;
  settlement: LiveChainSettlementVerifier;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;

  async function transition(
    attempt: LiveExecutionAttempt,
    nextStatus: LiveExecutionStatus,
    eventType: string,
    detail: Record<string, unknown> = {},
    evidence: Record<string, string> = {},
  ): Promise<LiveExecutionAttempt | null> {
    return dependencies.repository.transition({
      ownerId: attempt.owner_id,
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      nextStatus,
      eventType,
      actor: "LIVE_RECOVERY_WORKER",
      detail,
      evidence,
    });
  }

  async function failAndRelease(
    attempt: LiveExecutionAttempt,
    reasonCode: string,
    report: LiveRecoveryReport,
  ): Promise<void> {
    const failed = await transition(attempt, "FAILED", "LIVE_EXECUTION_RECONCILIATION_FAILED", {
      reasonCode,
    }, { last_error_code: reasonCode });
    if (!failed) {
      report.unchanged += 1;
      return;
    }
    report.failed += 1;
    await dependencies.repository.releaseBudget(attempt.owner_id, attempt.id);
  }

  async function reconcileProvider(attempt: LiveExecutionAttempt, report: LiveRecoveryReport): Promise<void> {
    if (!attempt.provider_order_id) {
      report.held += 1;
      await transition(attempt, "SECURITY_HOLD", "LIVE_RECOVERY_MISSING_PROVIDER_ORDER_ID", {
        reason: "A stable provider order ID was not persisted before submission",
      }, { last_error_code: "MISSING_PROVIDER_ORDER_ID" });
      return;
    }

    let providerResult: ReconciliationResult;
    try {
      providerResult = await dependencies.provider.reconcile({
        ownerId: attempt.owner_id,
        intentId: attempt.intent_id,
        requestId: attempt.request_id,
        providerOrderId: attempt.provider_order_id,
      });
    } catch (error) {
      report.errors += 1;
      report.unchanged += 1;
      await transition(attempt, attempt.status, "LIVE_PROVIDER_RECONCILIATION_ERROR", {
        errorCode: errorCode(error),
      }, { last_error_code: errorCode(error) });
      return;
    }

    report.reconciled += 1;
    if (providerResult.status === "UNKNOWN") {
      report.unchanged += 1;
      await transition(attempt, attempt.status, "LIVE_PROVIDER_STATUS_UNKNOWN", {
        reason: providerResult.reason.slice(0, 180),
      }, { last_error_code: "PROVIDER_STATUS_UNKNOWN" });
      return;
    }

    if (providerResult.status === "FAILED") {
      await failAndRelease(attempt, providerResult.reasonCode, report);
      return;
    }

    if (providerResult.status === "PENDING") {
      const pending = await transition(attempt, "PROVIDER_PENDING", "LIVE_PROVIDER_ORDER_PENDING", {
        providerOrderId: providerResult.providerOrderId ?? attempt.provider_order_id,
      });
      if (pending) report.providerPending += 1;
      else report.unchanged += 1;
      return;
    }

    if (providerResult.status === "PROVIDER_FILLED") {
      const filled = await transition(attempt, "PROVIDER_FILLED", "LIVE_PROVIDER_ORDER_FILLED", {
        providerOrderId: providerResult.providerOrderId,
      }, {
        provider_order_id: providerResult.providerOrderId,
        transaction_hash: providerResult.transactionHash,
        amount_in: providerResult.amountIn,
        amount_out: providerResult.amountOut,
      });
      if (!filled) {
        report.unchanged += 1;
        return;
      }
      await verifySettlement(filled, report);
      return;
    }

    if (providerResult.status === "SETTLED") {
      // Provider-reported settlement is not independent chain settlement.
      // Treat it only as a pointer to the transaction; the chain verifier decides.
      const filled = await transition(attempt, "PROVIDER_FILLED", "LIVE_PROVIDER_ORDER_FILLED", {
        providerOrderId: providerResult.providerOrderId ?? attempt.provider_order_id,
        providerClaimedSettlement: true,
      }, {
        provider_order_id: providerResult.providerOrderId ?? attempt.provider_order_id,
        transaction_hash: providerResult.transactionHash,
        amount_in: providerResult.amountIn,
        amount_out: providerResult.amountOut,
      });
      if (!filled) {
        report.unchanged += 1;
        return;
      }
      await verifySettlement(filled, report);
    }
  }

  async function verifySettlement(attempt: LiveExecutionAttempt, report: LiveRecoveryReport): Promise<void> {
    let current = attempt;
    if (current.status === "PROVIDER_FILLED") {
      const pending = await transition(current, "SETTLEMENT_PENDING", "LIVE_CHAIN_SETTLEMENT_VERIFICATION_STARTED");
      if (!pending) {
        report.unchanged += 1;
        return;
      }
      current = pending;
    }

    let verified: LiveSettlementVerification;
    try {
      verified = await dependencies.settlement.verify(current);
    } catch (error) {
      report.errors += 1;
      report.unchanged += 1;
      await transition(current, "SETTLEMENT_PENDING", "LIVE_CHAIN_SETTLEMENT_VERIFICATION_ERROR", {
        errorCode: errorCode(error),
      }, { last_error_code: errorCode(error) });
      return;
    }

    if (verified.status === "UNKNOWN") {
      report.unchanged += 1;
      await transition(current, "SETTLEMENT_PENDING", "LIVE_CHAIN_SETTLEMENT_UNKNOWN", {
        reason: verified.reason.slice(0, 180),
      }, { last_error_code: "CHAIN_SETTLEMENT_UNKNOWN" });
      return;
    }
    if (verified.status === "PENDING") {
      report.providerPending += 1;
      await transition(current, "SETTLEMENT_PENDING", "LIVE_CHAIN_SETTLEMENT_PENDING", {
        reason: verified.reason ?? "WAITING_FOR_CHAIN_CONFIRMATIONS",
      });
      return;
    }
    if (verified.status === "FAILED") {
      await failAndRelease(current, verified.reasonCode, report);
      return;
    }

    const settled = await transition(current, "SETTLED", "LIVE_CHAIN_SETTLEMENT_VERIFIED", {
      settlementBlock: verified.settlementBlock,
      chainVerified: true,
    }, {
      transaction_hash: verified.transactionHash,
      amount_in: verified.amountIn,
      amount_out: verified.amountOut,
      fee_amount: verified.feeAmount,
      settlement_block: verified.settlementBlock,
    });
    if (!settled) {
      report.unchanged += 1;
      return;
    }

    const committed = await dependencies.repository.commitFill(settled.owner_id, settled.id);
    if (committed) report.settled += 1;
    else {
      // Leave SETTLED durable. A later cycle retries the idempotent ledger commit.
      report.errors += 1;
    }
  }

  async function recoverOne(attempt: LiveExecutionAttempt, report: LiveRecoveryReport): Promise<void> {
    if (attempt.status === "PREPARED") {
      const expiry = attempt.quote_expires_at ? Date.parse(attempt.quote_expires_at) : NaN;
      if (!Number.isFinite(expiry) || expiry <= now()) {
        const aborted = await transition(attempt, "ABORTED", "LIVE_PREPARED_ATTEMPT_EXPIRED", {
          reason: "Quote expired before signing began",
        }, { last_error_code: "QUOTE_EXPIRED_BEFORE_SIGNING" });
        if (aborted) {
          report.failed += 1;
          await dependencies.repository.releaseBudget(aborted.owner_id, aborted.id);
        } else report.unchanged += 1;
      } else {
        report.unchanged += 1;
      }
      return;
    }

    if (attempt.status === "SIGNING_REQUESTED" || attempt.status === "SIGNER_UNKNOWN" ||
        attempt.status === "SIGNED") {
      report.held += 1;
      await transition(attempt, "SECURITY_HOLD", "LIVE_RECOVERY_SIGNER_OUTCOME_REQUIRES_REVIEW", {
        reason: "Signer outcome cannot be reconstructed safely from persisted metadata alone",
      }, { last_error_code: "SIGNER_OUTCOME_REQUIRES_RECONCILIATION" });
      return;
    }

    if (attempt.status === "SUBMITTING") {
      const unknown = await transition(attempt, "SUBMISSION_UNKNOWN", "LIVE_RECOVERY_SUBMISSION_OUTCOME_UNKNOWN", {
        reason: "Worker restarted while provider submission was in progress; reconcile by persisted order ID",
      }, { last_error_code: "WORKER_RESTART_DURING_SUBMISSION" });
      if (!unknown) {
        report.unchanged += 1;
        return;
      }
      await reconcileProvider(unknown, report);
      return;
    }

    if (attempt.status === "SUBMISSION_UNKNOWN" ||
        attempt.status === "SUBMITTED" ||
        attempt.status === "PROVIDER_PENDING") {
      await reconcileProvider(attempt, report);
      return;
    }

    if (attempt.status === "PROVIDER_FILLED" || attempt.status === "SETTLEMENT_PENDING") {
      await verifySettlement(attempt, report);
      return;
    }

    report.unchanged += 1;
  }

  async function run(ownerId: string, limit = 50): Promise<LiveRecoveryReport> {
    const report = result();
    const attempts = await dependencies.repository.listRecoverable(ownerId, limit);
    report.scanned = attempts.length;

    for (const attempt of attempts) {
      try {
        await recoverOne(attempt, report);
      } catch {
        report.errors += 1;
      }
    }

    // A chain-settled attempt may have survived while its atomic portfolio
    // ledger commit failed. Retry that commit without re-querying the provider.
    const settled = await dependencies.repository.listSettled(ownerId, limit);
    for (const attempt of settled) {
      try {
        if (await dependencies.repository.commitFill(ownerId, attempt.id)) report.settled += 1;
        else report.errors += 1;
      } catch {
        report.errors += 1;
      }
    }

    return report;
  }

  return { run };
}
