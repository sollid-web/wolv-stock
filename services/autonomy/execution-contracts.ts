import type { ExecutionIntent, RiskPolicy } from "./execution-domain";

/**
 * Storage and provider boundaries for the autonomous worker.
 * Implementations must be durable and tenant-scoped. These are contracts only:
 * no adapter in this file can access credentials, sign, or broadcast.
 */

export type ExecutableQuote = {
  provider: string;
  quoteId: string;
  chainId: string;
  ownerWallet: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  minimumAmountOut: string;
  slippageBps: number;
  priceImpactBps: number;
  gasCost: string;
  observedAt: string;
  expiresAt: string;
  routeFingerprint: string;
  rawEvidenceRef: string;
};

export type SimulationResult = {
  success: boolean;
  simulatedAt: string;
  transactionFingerprint: string;
  failureCode?: string;
};

export type SubmissionResult =
  | { status: "SUBMITTED"; providerOrderId: string; transactionHash?: string; submittedAt: string }
  | { status: "REJECTED"; providerCode: string; rejectedAt: string }
  | { status: "UNKNOWN"; observedAt: string; reason: string };

export type ReconciliationResult =
  | { status: "PENDING"; checkedAt: string; providerOrderId?: string; transactionHash?: string }
  | { status: "SETTLED"; checkedAt: string; providerOrderId?: string; transactionHash: string; amountIn: string; amountOut: string; feeAmount: string }
  | { status: "FAILED"; checkedAt: string; providerOrderId?: string; transactionHash?: string; reasonCode: string }
  | { status: "UNKNOWN"; checkedAt: string; reason: string };

export interface ExecutionRepository {
  /** Atomically create once per owner + idempotency key; return existing intent on duplicates. */
  createIfAbsent(intent: ExecutionIntent): Promise<{ created: boolean; intent: ExecutionIntent }>;
  getById(intentId: string, ownerId: string): Promise<ExecutionIntent | null>;
  getByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<ExecutionIntent | null>;
  /** Compare-and-swap on version; stale worker writes must fail, not overwrite newer state. */
  compareAndSwap(next: ExecutionIntent, expectedVersion: number): Promise<boolean>;
  /** Reserve and release must be atomic with respect to the owner's available budget. */
  reserveBudget(input: { ownerId: string; intentId: string; amount: string; policyVersion: string }): Promise<{ reserved: boolean; reservationId?: string; reason?: string }>;
  releaseBudget(input: { ownerId: string; intentId: string; reservationId: string; reason: string }): Promise<void>;
  appendAuditEvent(input: { ownerId: string; intentId: string; event: ExecutionIntent["events"][number] }): Promise<void>;
}

export interface QuoteProvider {
  getQuote(input: {
    ownerId: string;
    walletAddress: string;
    chainId: string;
    inputTokenAddress: string;
    outputTokenAddress: string;
    amountIn: string;
  }): Promise<ExecutableQuote>;
}

export interface SimulationProvider {
  /** Simulate the exact transaction fingerprint that the execution provider will submit. */
  simulate(input: { ownerId: string; walletAddress: string; quote: ExecutableQuote }): Promise<SimulationResult>;
}

export interface ExecutionProvider {
  /** Provider implementation owns signing authority; callers never receive private keys. */
  submit(input: { ownerId: string; intentId: string; idempotencyKey: string; quote: ExecutableQuote }): Promise<SubmissionResult>;
  /** Must be safe to call repeatedly; UNKNOWN never authorizes a second submission. */
  reconcile(input: { ownerId: string; intentId: string; idempotencyKey: string; providerOrderId?: string; transactionHash?: string }): Promise<ReconciliationResult>;
}

export type AutonomousWorkerDependencies = {
  repository: ExecutionRepository;
  quoteProvider: QuoteProvider;
  simulationProvider: SimulationProvider;
  executionProvider: ExecutionProvider;
  loadPolicy(ownerId: string, policyVersion: string): Promise<RiskPolicy>;
};

/**
 * A production worker must acquire a distributed per-intent lease before
 * processing, persist each transition with compareAndSwap, and reserve budget
 * before submission. Never implement these guarantees with process-local state.
 */
export type WorkerLease = {
  acquire(input: { ownerId: string; intentId: string; leaseMs: number }): Promise<{ acquired: boolean; leaseToken?: string }>;
  heartbeat(input: { ownerId: string; intentId: string; leaseToken: string; leaseMs: number }): Promise<boolean>;
  release(input: { ownerId: string; intentId: string; leaseToken: string }): Promise<void>;
};
