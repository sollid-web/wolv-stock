export const LIVE_EXECUTION_STATUSES = [
  "PREPARED",
  "SIGNING_REQUESTED",
  "SIGNER_UNKNOWN",
  "SIGNED",
  "SUBMITTING",
  "SUBMISSION_UNKNOWN",
  "SUBMITTED",
  "PROVIDER_PENDING",
  "PROVIDER_FILLED",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "FAILED",
  "REJECTED",
  "ABORTED",
  "SECURITY_HOLD",
] as const;

export type LiveExecutionStatus = typeof LIVE_EXECUTION_STATUSES[number];

export interface LiveExecutionAttempt {
  id: string;
  owner_id: string;
  intent_id: string;
  attempt_number: number;
  request_id: string;
  provider: string;
  chain_id: "56";
  wallet_address: string;
  status: LiveExecutionStatus;
  version: number;
  provider_idempotency_window_seconds: number;
  submission_started_at: string | null;
  retry_not_after: string | null;
  provider_quote_id: string | null;
  provider_order_id: string | null;
  prepared_payload_hash: string | null;
  signer_operation_id: string | null;
  signer_address: string | null;
  transaction_hash: string | null;
  amount_in: string | null;
  amount_out: string | null;
  fee_amount: string | null;
  settlement_block: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export type LiveExecutionEvidence = Partial<Pick<
  LiveExecutionAttempt,
  | "provider_quote_id"
  | "provider_order_id"
  | "prepared_payload_hash"
  | "signer_operation_id"
  | "signer_address"
  | "transaction_hash"
  | "amount_in"
  | "amount_out"
  | "fee_amount"
  | "settlement_block"
  | "last_error_code"
>>;

const TRANSITIONS: Record<LiveExecutionStatus, readonly LiveExecutionStatus[]> = {
  PREPARED: ["SIGNING_REQUESTED", "ABORTED", "SECURITY_HOLD"],
  SIGNING_REQUESTED: ["SIGNED", "SIGNER_UNKNOWN", "REJECTED", "SECURITY_HOLD"],
  SIGNER_UNKNOWN: ["SIGNED", "REJECTED", "SECURITY_HOLD"],
  SIGNED: ["SUBMITTING", "ABORTED", "SECURITY_HOLD"],
  SUBMITTING: ["SUBMITTED", "SUBMISSION_UNKNOWN", "REJECTED", "SECURITY_HOLD"],
  SUBMISSION_UNKNOWN: ["SUBMITTING", "SUBMITTED", "PROVIDER_PENDING", "PROVIDER_FILLED", "FAILED", "SECURITY_HOLD"],
  SUBMITTED: ["PROVIDER_PENDING", "PROVIDER_FILLED", "FAILED", "SECURITY_HOLD"],
  PROVIDER_PENDING: ["PROVIDER_PENDING", "PROVIDER_FILLED", "FAILED", "SECURITY_HOLD"],
  PROVIDER_FILLED: ["SETTLEMENT_PENDING", "SETTLED", "SECURITY_HOLD"],
  SETTLEMENT_PENDING: ["SETTLEMENT_PENDING", "SETTLED", "FAILED", "SECURITY_HOLD"],
  SETTLED: [],
  FAILED: [],
  REJECTED: [],
  ABORTED: [],
  SECURITY_HOLD: [],
};

export function isAllowedLiveExecutionTransition(
  from: LiveExecutionStatus,
  to: LiveExecutionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isRecoverableLiveExecutionStatus(status: LiveExecutionStatus): boolean {
  return !["SETTLED", "FAILED", "REJECTED", "ABORTED", "SECURITY_HOLD"].includes(status);
}

export function assertSafeLiveExecutionDetail(detail: Record<string, unknown>): void {
  const forbidden = /^(signature|signatureData|typedData|typed_data|privateKey|private_key|secret|rawTransaction|raw_transaction|rawTx|calldata)$/i;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (forbidden.test(key)) throw new Error("Sensitive signing or transaction payloads cannot be written to live execution audit events.");
      visit(nested);
    }
  };
  visit(detail);
}

export function assertLiveExecutionSettlementEvidence(evidence: LiveExecutionEvidence): void {
  if (!evidence.transaction_hash || !/^0x[0-9a-f]{64}$/i.test(evidence.transaction_hash)) {
    throw new Error("Independent settlement requires a valid transaction hash.");
  }
  for (const [label, value] of [
    ["input amount", evidence.amount_in],
    ["output amount", evidence.amount_out],
    ["fee amount", evidence.fee_amount],
    ["settlement block", evidence.settlement_block],
  ] as const) {
    if (value === undefined || value === null || !/^(0|[1-9][0-9]*)$/.test(value) || value === "0") {
      throw new Error(`Independent settlement requires a valid positive ${label}.`);
    }
  }
}

export function canRetryUnknownSubmission(
  status: LiveExecutionStatus,
  retryNotAfter: string | null,
  nowMs = Date.now(),
): boolean {
  if (status !== "SUBMISSION_UNKNOWN" || !retryNotAfter) return false;
  const deadline = Date.parse(retryNotAfter);
  return Number.isFinite(deadline) && deadline > nowMs;
}
