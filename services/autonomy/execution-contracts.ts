import type { ExecutionIntent, RiskPolicy } from "./execution-domain";
import type { ValidatedBinanceQuote } from "./binance-quote";
import type { ValidatedBinanceRfqOrder } from "./binance-rfq-order";

/**
 * Provider boundaries for WOLV's BSC RWA RFQ execution path.
 * Contracts do not hold credentials or private keys. Implementations must be
 * server-side, tenant-scoped, durable, and independently policy constrained.
 */

export type ExecutableQuote = ValidatedBinanceQuote;
export type PreparedRfqOrder = ValidatedBinanceRfqOrder;

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
  | { status: "PROVIDER_FILLED"; checkedAt: string; providerOrderId: string; transactionHash: string; amountIn: string; amountOut: string }
  | { status: "SETTLED"; checkedAt: string; providerOrderId?: string; transactionHash: string; amountIn: string; amountOut: string; feeAmount: string }
  | { status: "FAILED"; checkedAt: string; providerOrderId?: string; transactionHash?: string; reasonCode: string }
  | { status: "UNKNOWN"; checkedAt: string; reason: string };

export interface ExecutionRepository {
  createIfAbsent(intent: ExecutionIntent): Promise<{ created: boolean; intent: ExecutionIntent }>;
  getById(intentId: string, ownerId: string): Promise<ExecutionIntent | null>;
  getByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<ExecutionIntent | null>;
  compareAndSwap(next: ExecutionIntent, expectedVersion: number): Promise<boolean>;
  reserveBudget(input: {
    ownerId: string; intentId: string; chainId: string; tokenAddress: string;
    inputTokenAddress: string; amountIn: string; expectedAmountOut: string; policyVersion: string;
  }): Promise<boolean>;
  releaseBudget(input: { ownerId: string; intentId: string }): Promise<boolean>;
  commitPaperFill(input: {
    ownerId: string; intentId: string; quoteId: string;
    amountOut: string; quoteObservedAt: string;
  }): Promise<boolean>;
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
    slippageBps: number;
  }): Promise<ExecutableQuote>;
}

export interface RfqOrderBuilder {
  /** Builds and validates unsigned EIP-712 data; it must not sign or submit. */
  build(input: {
    ownerId: string;
    walletAddress: string;
    quote: ExecutableQuote;
    slippageBps: number;
    maxPriceImpactBps: number;
  }): Promise<PreparedRfqOrder>;
}

export interface TypedDataSigner {
  /** Signing authority is isolated behind a provider; private keys never leave it. */
  signEip712(input: {
    ownerId: string;
    walletAddress: string;
    chainId: string;
    typedDataToSign: string;
    typedDataFormat: PreparedRfqOrder["typedDataFormat"];
  }): Promise<{ signerAddress: string; signature: string }>;
}

export interface ChainSettlementVerifier {
  /** Independently verifies a successful BSC receipt and wallet token balance deltas. */
  verify(input: { ownerId: string; walletAddress: string; chainId: string; transactionHash: string; inputTokenAddress: string; outputTokenAddress: string; expectedAmountIn: string; expectedAmountOut: string }): Promise<
    | { status: "SETTLED"; amountIn: string; amountOut: string; feeAmount: string; blockNumber: string }
    | { status: "PENDING" }
    | { status: "FAILED"; reasonCode: string }
    | { status: "UNKNOWN"; reason: string }
  >;
}

export interface RfqExecutionProvider {
  /** requestId must be a stable UUID v4 reused for retries of this same order. */
  submit(input: {
    ownerId: string;
    intentId: string;
    requestId: string;
    order: PreparedRfqOrder;
    signerAddress: string;
    signature: string;
  }): Promise<SubmissionResult>;
  /** Unknown outcomes are reconciled by requestId/provider order ID, never resubmitted blindly. */
  reconcile(input: {
    ownerId: string;
    intentId: string;
    requestId: string;
    providerOrderId?: string;
  }): Promise<ReconciliationResult>;
}

export type AutonomousWorkerDependencies = {
  repository: ExecutionRepository;
  quoteProvider: QuoteProvider;
  rfqOrderBuilder: RfqOrderBuilder;
  typedDataSigner: TypedDataSigner;
  rfqExecutionProvider: RfqExecutionProvider;
  /** Required only for execution modes that produce an EVM transaction. */
  simulationProvider?: SimulationProvider;
  loadPolicy(ownerId: string, policyVersion: string): Promise<RiskPolicy>;
};

export interface SimulationProvider {
  /** Simulate the exact EVM transaction payload that the execution provider will submit. */
  simulate(input: { ownerId: string; walletAddress: string; quote: ExecutableQuote }): Promise<SimulationResult>;
}

export type WorkerLease = {
  acquire(input: { ownerId: string; intentId: string; leaseMs: number }): Promise<{ acquired: boolean; leaseToken?: string }>;
  heartbeat(input: { ownerId: string; intentId: string; leaseToken: string; leaseMs: number }): Promise<boolean>;
  release(input: { ownerId: string; intentId: string; leaseToken: string }): Promise<void>;
};
