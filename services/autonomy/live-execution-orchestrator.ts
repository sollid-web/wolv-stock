import { randomUUID } from "node:crypto";
import type { ValidatedBinanceQuote } from "./binance-quote";
import type { ValidatedBinanceRfqOrder } from "./binance-rfq-order";
import type { ValidatedRoundTripQuote } from "./binance-roundtrip";
import type { SubmissionResult } from "./execution-contracts";
import type { LiveExecutionAttempt, LiveExecutionStatus } from "./live-execution-domain";
import type { LiveExecutionPolicy } from "./supabase-live-portfolio-policy";
import {
  bindPrivyEip712PolicyToOrder,
  type PrivyEip712PolicyTemplate,
} from "./privy-eip712-policy";
import type { PrivyEip712SignRequest } from "./privy-eip712-signer";

export type LiveExecutionOutcome =
  | { status: "SUBMITTED"; attempt: LiveExecutionAttempt }
  | { status: "SUBMISSION_UNKNOWN"; attempt: LiveExecutionAttempt; reason: string }
  | { status: "REJECTED"; attempt: LiveExecutionAttempt; reason: string }
  | { status: "RECOVERY_REQUIRED"; attempt: LiveExecutionAttempt; reason: string };

export interface LiveExecutionAttemptRepository {
  create(input: {
    ownerId: string;
    intentId: string;
    provider: string;
    chainId: "56";
    walletAddress: string;
    providerIdempotencyWindowSeconds: number;
    policyVersion: string;
    quoteExpiresAt: string;
    providerQuoteId: string;
    providerOrderId: string;
    tokenAddress: string;
    inputTokenAddress: string;
    expectedAmountIn: string;
    minimumAmountOut: string;
    settlementAllowedSenders: string[];
    settlementAllowedTargets: string[];
    preparedPayloadHash: string;
  }): Promise<LiveExecutionAttempt>;
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
  reserve(input: {
    ownerId: string;
    intentId: string;
    walletAddress: string;
    chainId: "56";
    tokenAddress: string;
    inputTokenAddress: string;
    amountIn: string;
    policyVersion: string;
    quoteObservedAt: string;
    quoteExpiresAt: string;
    slippageBps: number;
    priceImpactBps: number;
    gasCostUsd: string;
    expectedEdgeBps: number;
    nativeGasBalanceWei: string;
  }): Promise<boolean>;
  recordGasPreflight(input: { ownerId: string; attemptId: string; nativeBalanceWei: string }): Promise<boolean>;
  recordSimulation(input: {
    ownerId: string;
    attemptId: string;
    orderHash: string;
    simulationFingerprint: string;
    simulatedAt: string;
  }): Promise<boolean>;
  releaseBudget(ownerId: string, attemptId: string): Promise<boolean>;
  releaseUnboundReservation(ownerId: string, intentId: string): Promise<boolean>;
}

export interface LiveRfqExecutionProvider {
  getRoundTripQuote(input: {
    chainId: "56";
    walletAddress: string;
    inputTokenAddress: string;
    outputTokenAddress: string;
    amountIn: string;
    slippageBps: number;
    networkFeeBufferBps: number;
  }): Promise<ValidatedRoundTripQuote>;
  buildOrder(input: {
    quote: ValidatedBinanceQuote;
    slippageBps: number;
    maxPriceImpactBps: number;
  }): Promise<ValidatedBinanceRfqOrder>;
  submit(input: {
    requestId: string;
    order: ValidatedBinanceRfqOrder;
    signerAddress: string;
    signature: string;
  }): Promise<SubmissionResult>;
}

export interface LiveRfqSigner {
  sign(input: PrivyEip712SignRequest): Promise<string>;
}

export interface LiveRfqSimulator {
  /**
   * Must simulate the exact signed RFQ order without broadcasting it.
   * A generic quote fingerprint or eth_call on an unrelated transaction is not sufficient.
   */
  simulate(input: {
    attempt: LiveExecutionAttempt;
    order: ValidatedBinanceRfqOrder;
    signature: string;
  }): Promise<{ fingerprint: string; simulatedAt: string }>;
}

function decimalToScaled18(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) {
    throw new Error("Invalid decimal USD amount in live quote evidence");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

function minTimestamp(values: string[]): string {
  const times = values.map(Date.parse);
  if (times.some((value) => !Number.isFinite(value))) throw new Error("Round-trip quote contains an invalid timestamp");
  return new Date(Math.min(...times)).toISOString();
}

function ensureQuoteWithinPolicy(input: {
  policy: LiveExecutionPolicy;
  roundTrip: ValidatedRoundTripQuote;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  slippageBps: number;
  now: number;
}): { quoteObservedAt: string; quoteExpiresAt: string; priceImpactBps: number } {
  const { policy, roundTrip } = input;
  if (!policy.enabled || policy.emergencyStop || policy.globalKillSwitch) {
    throw new Error("Live portfolio is disabled or stopped");
  }
  if (policy.chainId !== "56" || !policy.allowedChainIds.includes("56")) {
    throw new Error("Live portfolio does not allow BNB Smart Chain");
  }
  if (!policy.privyWalletId) throw new Error("A dedicated Privy execution wallet is not configured");
  if (policy.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new Error("Live quote wallet does not match the configured portfolio wallet");
  }
  if (policy.inputTokenAddress.toLowerCase() !== input.inputTokenAddress.toLowerCase() ||
      !policy.allowedInputTokenAddresses.includes(input.inputTokenAddress.toLowerCase()) ||
      !policy.allowedTokenAddresses.includes(input.outputTokenAddress.toLowerCase())) {
    throw new Error("Live quote token pair is not allowlisted by the portfolio");
  }
  if (roundTrip.provider !== "binance-web3-aggregator" ||
      roundTrip.buy.provider !== roundTrip.provider ||
      roundTrip.sell.provider !== roundTrip.provider) {
    throw new Error("Live RFQ legs must come from one verified provider");
  }
  if (roundTrip.buy.chainId !== "56" || roundTrip.sell.chainId !== "56" ||
      roundTrip.buy.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() ||
      roundTrip.sell.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() ||
      roundTrip.buy.inputTokenAddress.toLowerCase() !== input.inputTokenAddress.toLowerCase() ||
      roundTrip.buy.outputTokenAddress.toLowerCase() !== input.outputTokenAddress.toLowerCase() ||
      roundTrip.buy.amountIn !== input.amountIn) {
    throw new Error("Live round-trip quote does not match the requested wallet, chain, token pair or amount");
  }
  if (BigInt(input.amountIn) > BigInt(policy.maxOrderAmount)) {
    throw new Error("Live order amount exceeds the portfolio maximum");
  }
  if (input.slippageBps > policy.maxSlippageBps) {
    throw new Error("Requested slippage exceeds the live portfolio maximum");
  }
  if (roundTrip.indicativeRoundTripEdgeBps < policy.minExpectedEdgeBps) {
    throw new Error("Round-trip edge is below the live portfolio minimum");
  }
  const priceImpactBps = Math.max(roundTrip.buy.priceImpactBps, roundTrip.sell.priceImpactBps);
  if (priceImpactBps > policy.maxPriceImpactBps) {
    throw new Error("Round-trip price impact exceeds the live portfolio maximum");
  }
  if (decimalToScaled18(roundTrip.bufferedNetworkFeesUsd) > decimalToScaled18(policy.maxGasCostUsd)) {
    throw new Error("Buffered network fees exceed the live portfolio gas-cost maximum");
  }

  const quoteObservedAt = minTimestamp([roundTrip.buy.observedAt, roundTrip.sell.observedAt]);
  const quoteExpiresAt = roundTrip.expiresAt;
  const observedMs = Date.parse(quoteObservedAt);
  const expiryMs = Date.parse(quoteExpiresAt);
  if (input.now - observedMs > policy.maxQuoteAgeMs || observedMs > input.now + 5_000 ||
      !Number.isFinite(expiryMs) || expiryMs <= input.now) {
    throw new Error("Live round-trip quote is stale, future-dated or expired");
  }
  if (!policy.allowedTransactionSenders.length || !policy.allowedTransactionTargets.length) {
    throw new Error("Live portfolio must have verified RFQ settlement sender and router allowlists");
  }
  return { quoteObservedAt, quoteExpiresAt, priceImpactBps };
}

export function createLiveExecutionOrchestrator(dependencies: {
  loadPolicy(ownerId: string): Promise<LiveExecutionPolicy | null>;
  loadPolicyTemplate(): Promise<PrivyEip712PolicyTemplate>;
  provider: LiveRfqExecutionProvider;
  signer: LiveRfqSigner;
  simulator: LiveRfqSimulator;
  repository: LiveExecutionAttemptRepository;
  getNativeBalanceWei(walletAddress: string): Promise<string>;
  now?: () => number;
  providerIdempotencyWindowSeconds?: number;
}) {
  const now = dependencies.now ?? Date.now;
  const idempotencyWindow = dependencies.providerIdempotencyWindowSeconds ?? 0;

  async function preflight(attempt: LiveExecutionAttempt): Promise<string> {
    const balance = await dependencies.getNativeBalanceWei(attempt.wallet_address);
    if (!/^(0|[1-9][0-9]*)$/.test(balance) ||
        BigInt(balance) < BigInt((await dependencies.loadPolicy(attempt.owner_id))?.minNativeGasBalanceWei ?? "0")) {
      throw new Error("Native BNB balance is below the live portfolio gas reserve");
    }
    const saved = await dependencies.repository.recordGasPreflight({
      ownerId: attempt.owner_id,
      attemptId: attempt.id,
      nativeBalanceWei: balance,
    });
    if (!saved) throw new Error("Database rejected the live native-gas reserve preflight");
    return balance;
  }

  async function move(
    attempt: LiveExecutionAttempt,
    nextStatus: LiveExecutionStatus,
    eventType: string,
    detail: Record<string, unknown> = {},
    evidence: Record<string, string> = {},
  ): Promise<LiveExecutionAttempt> {
    const updated = await dependencies.repository.transition({
      ownerId: attempt.owner_id,
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      nextStatus,
      eventType,
      actor: "LIVE_ENTRY_WORKER",
      detail,
      evidence,
    });
    if (!updated) throw new Error("Live attempt version changed concurrently; reload before continuing");
    return updated;
  }

  async function abortAndRelease(attempt: LiveExecutionAttempt, code: string): Promise<LiveExecutionOutcome> {
    const nextStatus: LiveExecutionStatus =
      attempt.status === "PREPARED" || attempt.status === "SIGNED" ? "ABORTED" : "REJECTED";
    const updated = await move(attempt, nextStatus, "LIVE_ENTRY_ABORTED", { reasonCode: code }, { last_error_code: code });
    await dependencies.repository.releaseBudget(updated.owner_id, updated.id);
    return { status: "REJECTED", attempt: updated, reason: code };
  }

  return {
    async execute(input: {
      ownerId: string;
      intentId: string;
      outputTokenAddress: string;
      amountIn: string;
      slippageBps: number;
    }): Promise<LiveExecutionOutcome> {
      let reservationCreated = false;
      let attempt: LiveExecutionAttempt | null = null;
      let signerCallStarted = false;
      try {
        const policy = await dependencies.loadPolicy(input.ownerId);
        if (!policy) throw new Error("Live portfolio is not configured");
        if (!/^[1-9][0-9]*$/.test(input.amountIn) ||
            !Number.isInteger(input.slippageBps) || input.slippageBps < 0) {
          throw new Error("Invalid live order amount or slippage");
        }
        const roundTrip = await dependencies.provider.getRoundTripQuote({
          chainId: "56",
          walletAddress: policy.walletAddress,
          inputTokenAddress: policy.inputTokenAddress,
          outputTokenAddress: input.outputTokenAddress,
          amountIn: input.amountIn,
          slippageBps: input.slippageBps,
          networkFeeBufferBps: policy.networkFeeBufferBps,
        });
        const checked = ensureQuoteWithinPolicy({
          policy,
          roundTrip,
          walletAddress: policy.walletAddress,
          inputTokenAddress: policy.inputTokenAddress,
          outputTokenAddress: input.outputTokenAddress,
          amountIn: input.amountIn,
          slippageBps: input.slippageBps,
          now: now(),
        });

        const order = await dependencies.provider.buildOrder({
          quote: roundTrip.buy,
          slippageBps: input.slippageBps,
          maxPriceImpactBps: policy.maxPriceImpactBps,
        });
        if (order.provider !== "binance-web3-aggregator" ||
            order.quoteId !== roundTrip.buy.quoteId ||
            order.orderId.trim().length < 2 ||
            order.walletAddress.toLowerCase() !== policy.walletAddress.toLowerCase() ||
            order.chainId !== "56" ||
            order.inputTokenAddress.toLowerCase() !== policy.inputTokenAddress.toLowerCase() ||
            order.outputTokenAddress.toLowerCase() !== input.outputTokenAddress.toLowerCase() ||
            order.amountIn !== input.amountIn ||
            order.approvalRequired || order.approvalTarget !== null ||
            order.typedDataFormat !== "JSON_TYPED_DATA" ||
            !Number.isFinite(Date.parse(order.quoteExpiresAt)) ||
            Date.parse(order.quoteExpiresAt) <= now() ||
            Date.parse(order.quoteExpiresAt) > Date.parse(checked.quoteExpiresAt)) {
          throw new Error("Unsigned RFQ order does not match the validated live quote or approved signing format");
        }

        const nativeBalanceWei = await dependencies.getNativeBalanceWei(policy.walletAddress);
        if (!/^(0|[1-9][0-9]*)$/.test(nativeBalanceWei) ||
            BigInt(nativeBalanceWei) < BigInt(policy.minNativeGasBalanceWei)) {
          throw new Error("Native BNB balance is below the live portfolio gas reserve");
        }

        const reserved = await dependencies.repository.reserve({
          ownerId: input.ownerId,
          intentId: input.intentId,
          walletAddress: policy.walletAddress,
          chainId: "56",
          tokenAddress: input.outputTokenAddress,
          inputTokenAddress: policy.inputTokenAddress,
          amountIn: input.amountIn,
          policyVersion: policy.policyVersion,
          quoteObservedAt: checked.quoteObservedAt,
          quoteExpiresAt: checked.quoteExpiresAt,
          slippageBps: input.slippageBps,
          priceImpactBps: checked.priceImpactBps,
          gasCostUsd: roundTrip.bufferedNetworkFeesUsd,
          expectedEdgeBps: roundTrip.indicativeRoundTripEdgeBps,
          nativeGasBalanceWei,
        });
        if (!reserved) throw new Error("Live portfolio rejected the atomic budget/risk reservation");
        reservationCreated = true;

        try {
          attempt = await dependencies.repository.create({
            ownerId: input.ownerId,
            intentId: input.intentId,
            provider: order.provider,
            chainId: "56",
            walletAddress: policy.walletAddress,
            providerIdempotencyWindowSeconds: idempotencyWindow,
            policyVersion: policy.policyVersion,
            quoteExpiresAt: order.quoteExpiresAt,
            providerQuoteId: order.quoteId,
            providerOrderId: order.orderId,
            tokenAddress: order.outputTokenAddress,
            inputTokenAddress: order.inputTokenAddress,
            expectedAmountIn: order.amountIn,
            minimumAmountOut: roundTrip.buyMinimumAmountOut,
            settlementAllowedSenders: policy.allowedTransactionSenders,
            settlementAllowedTargets: policy.allowedTransactionTargets,
            preparedPayloadHash: order.typedDataHash,
          });
        } catch (error) {
          await dependencies.repository.releaseUnboundReservation(input.ownerId, input.intentId);
          reservationCreated = false;
          throw error;
        }

        if (!["PREPARED", "SIGNING_REQUESTED", "SIGNER_UNKNOWN", "SIGNED"].includes(attempt.status)) {
          reservationCreated = false;
          return {
            status: "RECOVERY_REQUIRED",
            attempt,
            reason: "An existing live attempt is already in a post-signing state; the recovery worker owns it",
          };
        }

        const signerOperationId = attempt.signer_operation_id ?? "wolv-" + randomUUID();
        const signerPolicy = bindPrivyEip712PolicyToOrder({
          template: await dependencies.loadPolicyTemplate(),
          order,
          walletAddress: policy.walletAddress,
          minimumAmountOut: roundTrip.buyMinimumAmountOut,
        });

        if (attempt.status === "PREPARED") {
          await preflight(attempt);
          attempt = await move(attempt, "SIGNING_REQUESTED", "LIVE_EIP712_SIGNING_REQUESTED", {}, {
            signer_operation_id: signerOperationId,
            signer_address: policy.walletAddress,
            prepared_payload_hash: order.typedDataHash,
          });
        } else if (attempt.signer_operation_id !== signerOperationId ||
                   attempt.signer_address?.toLowerCase() !== policy.walletAddress.toLowerCase() ||
                   attempt.prepared_payload_hash !== order.typedDataHash) {
          reservationCreated = false;
          return {
            status: "RECOVERY_REQUIRED",
            attempt,
            reason: "Persisted signer operation or payload binding does not match the current RFQ order",
          };
        }

        let signature: string;
        try {
          signature = await dependencies.signer.sign({
            walletId: policy.privyWalletId,
            walletAddress: policy.walletAddress,
            signerOperationId,
            providerVendor: order.vendor,
            typedData: order.typedDataToSign,
            policy: signerPolicy,
            beforeSign: async () => {
              await preflight(attempt!);
              signerCallStarted = true;
            },
          });
          signerCallStarted = true;
        } catch (error) {
          if (!signerCallStarted && attempt.status === "SIGNED") {
            return await abortAndRelease(attempt, "LIVE_SIGNER_RETRY_PRECHECK_FAILED");
          }
          if (!signerCallStarted) {
            attempt = await move(attempt, "REJECTED", "LIVE_SIGNER_PRECHECK_REJECTED", {
              errorCode: error instanceof Error ? error.message.slice(0, 120) : "SIGNER_PRECHECK_ERROR",
            }, { last_error_code: "SIGNER_PRECHECK_REJECTED" });
            await dependencies.repository.releaseBudget(attempt.owner_id, attempt.id);
            reservationCreated = false;
            return { status: "REJECTED", attempt, reason: "Signer preflight failed before a signing request was sent" };
          }
          if (attempt.status === "SIGNING_REQUESTED") {
            attempt = await move(attempt, "SIGNER_UNKNOWN", "LIVE_SIGNER_OUTCOME_UNKNOWN", {
              errorCode: error instanceof Error ? error.message.slice(0, 120) : "SIGNER_ERROR",
            }, { last_error_code: "SIGNER_OUTCOME_UNKNOWN" });
          }
          reservationCreated = false;
          return { status: "RECOVERY_REQUIRED", attempt, reason: "Signer outcome is unknown; retry only with the same signer operation ID" };
        }

        if (attempt.status !== "SIGNED") {
          await preflight(attempt);
          attempt = await move(attempt, "SIGNED", "LIVE_EIP712_SIGNATURE_CREATED", {
            signerOperationId,
            signaturePersisted: false,
          });
        }

        let simulation: { fingerprint: string; simulatedAt: string };
        const existingSimulationAt = attempt.simulated_at ? Date.parse(attempt.simulated_at) : NaN;
        const existingSimulationFresh = !!attempt.simulation_fingerprint &&
          /^[a-f0-9]{64}$/i.test(attempt.simulation_fingerprint) &&
          Number.isFinite(existingSimulationAt) && existingSimulationAt <= now() + 5_000 &&
          now() - existingSimulationAt <= 15_000;
        try {
          simulation = existingSimulationFresh
            ? { fingerprint: attempt.simulation_fingerprint!, simulatedAt: attempt.simulated_at! }
            : await dependencies.simulator.simulate({ attempt, order, signature });
        } catch (error) {
          return await abortAndRelease(attempt, error instanceof Error ? error.message.slice(0, 120) : "RFQ_SIMULATION_FAILED");
        }
        if (!/^[a-f0-9]{64}$/i.test(simulation.fingerprint) ||
            Date.parse(simulation.simulatedAt) > now() + 5_000 ||
            now() - Date.parse(simulation.simulatedAt) > 15_000) {
          return await abortAndRelease(attempt, "RFQ_SIMULATION_EVIDENCE_INVALID_OR_STALE");
        }
        if (!existingSimulationFresh) {
          const simulationRecorded = await dependencies.repository.recordSimulation({
            ownerId: attempt.owner_id,
            attemptId: attempt.id,
            orderHash: order.typedDataHash,
            simulationFingerprint: simulation.fingerprint,
            simulatedAt: simulation.simulatedAt,
          });
          if (!simulationRecorded) {
            return await abortAndRelease(attempt, "RFQ_SIMULATION_EVIDENCE_REJECTED_BY_DATABASE");
          }
        }

        await preflight(attempt);
        attempt = await move(attempt, "SUBMITTING", "LIVE_RFQ_SUBMISSION_STARTED", {
          requestId: attempt.request_id,
          providerOrderId: attempt.provider_order_id,
        });

        let submitted: SubmissionResult;
        try {
          submitted = await dependencies.provider.submit({
            requestId: attempt.request_id,
            order,
            signerAddress: policy.walletAddress,
            signature,
          });
        } catch (error) {
          attempt = await move(attempt, "SUBMISSION_UNKNOWN", "LIVE_RFQ_SUBMISSION_OUTCOME_UNKNOWN", {
            errorCode: error instanceof Error ? error.message.slice(0, 120) : "SUBMISSION_ERROR",
          }, { last_error_code: "SUBMISSION_OUTCOME_UNKNOWN" });
          reservationCreated = false;
          return { status: "SUBMISSION_UNKNOWN", attempt, reason: "Submission outcome is unknown; recovery must reconcile the same provider order" };
        }

        if (submitted.status === "REJECTED") {
          attempt = await move(attempt, "REJECTED", "LIVE_RFQ_SUBMISSION_REJECTED", {
            providerCode: submitted.providerCode,
          }, { last_error_code: submitted.providerCode });
          await dependencies.repository.releaseBudget(attempt.owner_id, attempt.id);
          reservationCreated = false;
          return { status: "REJECTED", attempt, reason: submitted.providerCode };
        }
        if (submitted.status === "UNKNOWN") {
          attempt = await move(attempt, "SUBMISSION_UNKNOWN", "LIVE_RFQ_SUBMISSION_OUTCOME_UNKNOWN", {
            reason: submitted.reason.slice(0, 160),
          }, { last_error_code: "SUBMISSION_OUTCOME_UNKNOWN" });
          reservationCreated = false;
          return { status: "SUBMISSION_UNKNOWN", attempt, reason: submitted.reason };
        }
        if (submitted.providerOrderId !== order.orderId) {
          attempt = await move(attempt, "SECURITY_HOLD", "LIVE_RFQ_ORDER_ID_MISMATCH", {
            expectedOrderId: order.orderId,
            returnedOrderId: submitted.providerOrderId,
          }, { last_error_code: "PROVIDER_ORDER_ID_MISMATCH" });
          reservationCreated = false;
          return { status: "SUBMISSION_UNKNOWN", attempt, reason: "Provider acknowledgement order ID mismatch" };
        }

        attempt = await move(attempt, "SUBMITTED", "LIVE_RFQ_ORDER_SUBMITTED", {
          providerOrderId: submitted.providerOrderId,
          submittedAt: submitted.submittedAt,
        }, submitted.transactionHash ? { transaction_hash: submitted.transactionHash } : {});
        reservationCreated = false;
        return { status: "SUBMITTED", attempt };
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 160) : "LIVE_EXECUTION_FAILED";
        if (attempt) {
          if (attempt.status === "PREPARED") {
            await abortAndRelease(attempt, "LIVE_PREPARATION_FAILED");
          } else if (attempt.status === "SIGNING_REQUESTED") {
            if (signerCallStarted) {
              await move(attempt, "SIGNER_UNKNOWN", "LIVE_SIGNER_OUTCOME_UNKNOWN", { reason }, {
                last_error_code: "SIGNER_OUTCOME_UNKNOWN",
              });
              reservationCreated = false;
            } else {
              const rejected = await move(attempt, "REJECTED", "LIVE_SIGNER_PRECHECK_REJECTED", { reason }, {
                last_error_code: "SIGNER_PRECHECK_REJECTED",
              });
              await dependencies.repository.releaseBudget(rejected.owner_id, rejected.id);
              reservationCreated = false;
            }
          } else if (attempt.status === "SIGNED") {
            await abortAndRelease(attempt, "LIVE_PRE_SUBMISSION_FAILED");
          } else if (attempt.status === "SUBMITTING") {
            await move(attempt, "SUBMISSION_UNKNOWN", "LIVE_RFQ_SUBMISSION_OUTCOME_UNKNOWN", { reason }, {
              last_error_code: "SUBMISSION_OUTCOME_UNKNOWN",
            });
            reservationCreated = false;
          } else if (attempt.status === "SIGNER_UNKNOWN" || attempt.status === "SUBMISSION_UNKNOWN" ||
                     attempt.status === "SUBMITTED" || attempt.status === "PROVIDER_PENDING" ||
                     attempt.status === "PROVIDER_FILLED" || attempt.status === "SETTLEMENT_PENDING" ||
                     attempt.status === "SECURITY_HOLD") {
            reservationCreated = false;
          }
        } else if (reservationCreated) {
          await dependencies.repository.releaseUnboundReservation(input.ownerId, input.intentId);
        }
        throw error;
      }
    },
  };
}
