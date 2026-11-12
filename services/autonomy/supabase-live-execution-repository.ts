import { randomUUID } from "node:crypto";
import {
  assertLiveExecutionSettlementEvidence,
  assertLiveExecutionSignerEvidence,
  assertProviderFillEvidence,
  assertSafeLiveExecutionDetail,
  canRetryUnknownSubmission,
  isAllowedLiveExecutionTransition,
  type LiveExecutionAttempt,
  type LiveExecutionEvidence,
  type LiveExecutionStatus,
} from "./live-execution-domain";

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and service-role key are required for live execution persistence.");
  return { url, key };
}

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const body = response.status === 204 ? null : await response.text();
  if (!response.ok) {
    throw new Error(`Live execution persistence failed (${response.status}): ${(body ?? "").slice(0, 300)}`);
  }
  return body ? JSON.parse(body) as unknown : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ACTIVE_STATUS_FILTER = "not.in.(SETTLED,FAILED,REJECTED,ABORTED)";

function parseAttempt(value: unknown): LiveExecutionAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supabase returned a malformed live execution attempt.");
  }
  const row = value as Record<string, unknown>;
  const requiredStrings = [
    "id", "owner_id", "intent_id", "request_id", "provider", "chain_id",
    "wallet_address", "status", "execution_side", "policy_version", "created_at", "updated_at",
  ];
  for (const key of requiredStrings) {
    if (typeof row[key] !== "string" || !row[key]) throw new Error(`Live execution attempt has invalid ${key}.`);
  }
  if (!UUID.test(String(row.request_id)) || row.chain_id !== "56" ||
      !ADDRESS.test(String(row.wallet_address))) {
    throw new Error("Live execution attempt has invalid request, chain or wallet binding.");
  }
  const nullableStrings = [
    "provider_quote_id", "provider_order_id", "prepared_payload_hash",
    "signer_operation_id", "signer_address", "transaction_hash",
    "amount_in", "amount_out", "fee_amount", "settlement_block", "last_error_code",
    "submission_started_at", "retry_not_after", "quote_expires_at", "simulation_fingerprint", "simulated_at", "native_gas_preflight_at",
  ] as const;
  for (const key of nullableStrings) {
    if (row[key] !== null && typeof row[key] !== "string") {
      throw new Error(`Live execution attempt has invalid ${key}.`);
    }
  }
  if (!["BUY", "SELL"].includes(String(row.execution_side)) ||
      typeof row.policy_version !== "string" || !row.policy_version ||
      !/^[0-9]+$/.test(String(row.native_gas_balance_wei))) {
    throw new Error("Live execution attempt has invalid policy, side or gas-preflight evidence.");
  }
  if (!Number.isSafeInteger(row.attempt_number) || Number(row.attempt_number) < 1 ||
      !Number.isSafeInteger(row.version) || Number(row.version) < 0 ||
      !Number.isSafeInteger(row.provider_idempotency_window_seconds) ||
      Number(row.provider_idempotency_window_seconds) < 0 || Number(row.provider_idempotency_window_seconds) > 86400) {
    throw new Error("Live execution attempt has invalid version or attempt number.");
  }
  return row as unknown as LiveExecutionAttempt;
}

async function findActiveAttempt(ownerId: string, intentId: string): Promise<LiveExecutionAttempt | null> {
  const query = new URLSearchParams({
    select: "*",
    owner_id: `eq.${ownerId}`,
    intent_id: `eq.${intentId}`,
    status: ACTIVE_STATUS_FILTER,
    order: "attempt_number.desc",
    limit: "1",
  });
  const rows = await request(`wolv_live_execution_attempts?${query}`) as unknown[];
  return rows.length ? parseAttempt(rows[0]) : null;
}

export async function createLiveExecutionAttempt(input: {
  ownerId: string;
  intentId: string;
  provider: string;
  chainId: "56";
  walletAddress: string;
  providerIdempotencyWindowSeconds?: number;
  policyVersion: string;
  quoteExpiresAt: string;
  providerQuoteId: string;
  preparedPayloadHash: string;
  executionSide?: "BUY";
}): Promise<LiveExecutionAttempt> {
  if (!UUID.test(input.ownerId) || !UUID.test(input.intentId)) {
    throw new Error("Live execution requires valid owner and intent UUIDs.");
  }
  const idempotencyWindow = input.providerIdempotencyWindowSeconds ?? 0;
  const quoteExpiry = Date.parse(input.quoteExpiresAt);
  if (!input.policyVersion.trim() || !/^[a-fA-F0-9]{32,128}$/.test(input.providerQuoteId) ||
      !/^[a-f0-9]{64}$/i.test(input.preparedPayloadHash) || !Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now() ||
      (input.executionSide ?? "BUY") !== "BUY" ||
      input.chainId !== "56" || !ADDRESS.test(input.walletAddress) ||
      !/^[a-z0-9-]{2,64}$/i.test(input.provider) ||
      !Number.isSafeInteger(idempotencyWindow) || idempotencyWindow < 0 || idempotencyWindow > 86400) {
    throw new Error("Live execution provider, BSC chain or wallet binding is invalid.");
  }

  // A retry after a process crash must recover the existing request ID, never mint a new one.
  const active = await findActiveAttempt(input.ownerId, input.intentId);
  if (active) {
    if (active.provider !== input.provider ||
        active.chain_id !== input.chainId ||
        active.wallet_address.toLowerCase() !== input.walletAddress.toLowerCase() ||
        active.provider_idempotency_window_seconds !== idempotencyWindow ||
        active.policy_version !== input.policyVersion ||
        active.provider_quote_id !== input.providerQuoteId ||
        active.prepared_payload_hash !== input.preparedPayloadHash ||
        active.execution_side !== (input.executionSide ?? "BUY")) {
      throw new Error("An active live attempt exists with a different provider or wallet binding.");
    }
    return active;
  }

  const intentQuery = new URLSearchParams({
    select: "id,state",
    id: `eq.${input.intentId}`,
    owner_id: `eq.${input.ownerId}`,
    limit: "1",
  });
  const intents = await request(`wolv_execution_intents?${intentQuery}`) as Array<Record<string, unknown>>;
  if (intents.length !== 1 || intents[0].state !== "RISK_APPROVED") {
    throw new Error("A live attempt can only be created from an owner-scoped RISK_APPROVED intent.");
  }

  const latestQuery = new URLSearchParams({
    select: "attempt_number",
    owner_id: `eq.${input.ownerId}`,
    intent_id: `eq.${input.intentId}`,
    order: "attempt_number.desc",
    limit: "1",
  });
  const latest = await request(`wolv_live_execution_attempts?${latestQuery}`) as Array<Record<string, unknown>>;
  const attemptNumber = latest.length ? Number(latest[0].attempt_number) + 1 : 1;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Unable to allocate a valid live execution attempt number.");
  }

  const payload = {
    owner_id: input.ownerId,
    intent_id: input.intentId,
    attempt_number: attemptNumber,
    request_id: randomUUID(),
    provider: input.provider,
    chain_id: input.chainId,
    wallet_address: input.walletAddress.toLowerCase(),
    provider_idempotency_window_seconds: idempotencyWindow,
    execution_side: input.executionSide ?? "BUY",
    policy_version: input.policyVersion,
    quote_expires_at: input.quoteExpiresAt,
    provider_quote_id: input.providerQuoteId,
    prepared_payload_hash: input.preparedPayloadHash,
    status: "PREPARED",
  };
  try {
    const rows = await request("wolv_live_execution_attempts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    }) as unknown[];
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error("Supabase did not return the created live execution attempt.");
    }
    return parseAttempt(rows[0]);
  } catch (error) {
    // A concurrent creator may have won the partial unique index. Recover its stable request ID.
    const raced = await findActiveAttempt(input.ownerId, input.intentId);
    if (raced && raced.provider === input.provider &&
        raced.wallet_address.toLowerCase() === input.walletAddress.toLowerCase() &&
    raced.provider_idempotency_window_seconds === idempotencyWindow &&
        raced.policy_version === input.policyVersion &&
        raced.provider_quote_id === input.providerQuoteId &&
        raced.prepared_payload_hash === input.preparedPayloadHash &&
        raced.execution_side === (input.executionSide ?? "BUY")) return raced;
    throw error;
  }
}

export async function getLiveExecutionAttempt(
  ownerId: string,
  attemptId: string,
): Promise<LiveExecutionAttempt | null> {
  if (!UUID.test(ownerId) || !UUID.test(attemptId)) throw new Error("Invalid live execution lookup identifiers.");
  const query = new URLSearchParams({
    select: "*", owner_id: `eq.${ownerId}`, id: `eq.${attemptId}`, limit: "1",
  });
  const rows = await request(`wolv_live_execution_attempts?${query}`) as unknown[];
  return rows.length ? parseAttempt(rows[0]) : null;
}

export async function listRecoverableLiveExecutionAttempts(
  ownerId: string,
  limit = 50,
): Promise<LiveExecutionAttempt[]> {
  if (!UUID.test(ownerId)) throw new Error("Invalid live execution owner UUID.");
  const query = new URLSearchParams({
    select: "*",
    owner_id: `eq.${ownerId}`,
    status: "not.in.(SETTLED,FAILED,REJECTED,ABORTED,SECURITY_HOLD)",
    order: "updated_at.asc",
    limit: String(Math.max(1, Math.min(200, Math.floor(limit)))),
  });
  const rows = await request(`wolv_live_execution_attempts?${query}`) as unknown[];
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid live recovery queue.");
  return rows.map(parseAttempt);
}

export async function transitionLiveExecutionAttempt(input: {
  ownerId: string;
  attemptId: string;
  expectedVersion: number;
  nextStatus: LiveExecutionStatus;
  eventType: string;
  actor: string;
  detail?: Record<string, unknown>;
  evidence?: LiveExecutionEvidence;
}): Promise<LiveExecutionAttempt | null> {
  const current = await getLiveExecutionAttempt(input.ownerId, input.attemptId);
  if (!current) return null;
  if (current.version !== input.expectedVersion) return null;
  if (!isAllowedLiveExecutionTransition(current.status, input.nextStatus)) {
    throw new Error(`Invalid live execution transition ${current.status} -> ${input.nextStatus}.`);
  }
  if (current.status === "SUBMISSION_UNKNOWN" && input.nextStatus === "SUBMITTING" &&
      !canRetryUnknownSubmission(current.status, current.retry_not_after)) {
    throw new Error("The provider idempotency window has expired. Reconcile or place the attempt on security hold; do not resubmit.");
  }
  const detail = input.detail ?? {};
  const evidence = input.evidence ?? {};
  assertSafeLiveExecutionDetail(detail);

  if (["SIGNING_REQUESTED", "SIGNED", "SUBMITTING"].includes(input.nextStatus)) {
    assertLiveExecutionSignerEvidence({
      walletAddress: current.wallet_address,
      signerAddress: evidence.signer_address ?? current.signer_address,
      signerOperationId: evidence.signer_operation_id ?? current.signer_operation_id,
      preparedPayloadHash: evidence.prepared_payload_hash ?? current.prepared_payload_hash,
    });
  }
  if (input.nextStatus === "PROVIDER_FILLED") {
    assertProviderFillEvidence({
      providerOrderId: evidence.provider_order_id ?? current.provider_order_id,
      transactionHash: evidence.transaction_hash ?? current.transaction_hash,
      amountIn: evidence.amount_in ?? current.amount_in,
      amountOut: evidence.amount_out ?? current.amount_out,
    });
  }
  if (input.nextStatus === "SETTLED") {
    assertLiveExecutionSettlementEvidence({
      transaction_hash: evidence.transaction_hash ?? current.transaction_hash ?? undefined,
      amount_in: evidence.amount_in ?? current.amount_in ?? undefined,
      amount_out: evidence.amount_out ?? current.amount_out ?? undefined,
      fee_amount: evidence.fee_amount ?? current.fee_amount ?? undefined,
      settlement_block: evidence.settlement_block ?? current.settlement_block ?? undefined,
    });
  }

  const result = await request("rpc/wolv_live_execution_attempt_transition", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_attempt_id: input.attemptId,
      p_expected_version: input.expectedVersion,
      p_next_status: input.nextStatus,
      p_event_type: input.eventType,
      p_actor: input.actor,
      p_detail: detail,
      p_evidence: evidence,
    }),
  });
  if (result !== true) return null;
  return getLiveExecutionAttempt(input.ownerId, input.attemptId);
}


export async function reserveLiveExecutionBudget(input: {
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
}): Promise<boolean> {
  if (!UUID.test(input.ownerId) || !UUID.test(input.intentId) ||
      !ADDRESS.test(input.walletAddress) || !ADDRESS.test(input.tokenAddress) ||
      !ADDRESS.test(input.inputTokenAddress) || input.chainId !== "56") {
    throw new Error("Live budget reservation has invalid owner, wallet, chain or token identifiers.");
  }
  const numeric = (value: string, field: string, positive = false): string => {
    if (!/^(0|[1-9][0-9]*)$/.test(value) || (positive && BigInt(value) <= 0n)) {
      throw new Error("Live budget reservation has invalid " + field);
    }
    return value;
  };
  const gas = input.gasCostUsd;
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(gas)) {
    throw new Error("Live budget reservation has invalid gasCostUsd");
  }
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 5000 ||
      !Number.isSafeInteger(input.priceImpactBps) || input.priceImpactBps < 0 || input.priceImpactBps > 10000 ||
      !Number.isSafeInteger(input.expectedEdgeBps)) {
    throw new Error("Live budget reservation has invalid slippage, impact or edge evidence");
  }
  const observed = Date.parse(input.quoteObservedAt);
  const expires = Date.parse(input.quoteExpiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= Date.now() || observed > Date.now() + 5_000) {
    throw new Error("Live budget reservation has an invalid or expired quote");
  }

  const result = await request("rpc/wolv_reserve_live_execution_budget", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_intent_id: input.intentId,
      p_wallet_address: input.walletAddress.toLowerCase(),
      p_chain_id: input.chainId,
      p_token_address: input.tokenAddress.toLowerCase(),
      p_input_token_address: input.inputTokenAddress.toLowerCase(),
      p_amount_in: numeric(input.amountIn, "amountIn", true),
      p_policy_version: input.policyVersion,
      p_quote_observed_at: input.quoteObservedAt,
      p_quote_expires_at: input.quoteExpiresAt,
      p_slippage_bps: input.slippageBps,
      p_price_impact_bps: input.priceImpactBps,
      p_gas_cost_usd: gas,
      p_expected_edge_bps: input.expectedEdgeBps,
      p_native_gas_balance_wei: numeric(input.nativeGasBalanceWei, "nativeGasBalanceWei"),
    }),
  });
  return result === true;
}

export async function recordLiveExecutionGasPreflight(input: {
  ownerId: string;
  attemptId: string;
  nativeBalanceWei: string;
}): Promise<boolean> {
  if (!UUID.test(input.ownerId) || !UUID.test(input.attemptId) ||
      !/^(0|[1-9][0-9]*)$/.test(input.nativeBalanceWei)) {
    throw new Error("Invalid live gas preflight identifiers or balance");
  }
  const result = await request("rpc/wolv_record_live_execution_gas_preflight", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_attempt_id: input.attemptId,
      p_native_balance_wei: input.nativeBalanceWei,
    }),
  });
  return result === true;
}

export async function commitLiveExecutionFill(ownerId: string, attemptId: string): Promise<boolean> {
  if (!UUID.test(ownerId) || !UUID.test(attemptId)) throw new Error("Invalid live fill commit identifiers");
  const result = await request("rpc/wolv_commit_live_execution_fill", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_attempt_id: attemptId }),
  });
  return result === true;
}

export async function releaseLiveExecutionBudget(ownerId: string, attemptId: string): Promise<boolean> {
  if (!UUID.test(ownerId) || !UUID.test(attemptId)) throw new Error("Invalid live reservation release identifiers");
  const result = await request("rpc/wolv_release_live_execution_budget", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_attempt_id: attemptId }),
  });
  return result === true;
}


export async function recordLiveExecutionSimulation(input: {
  ownerId: string;
  attemptId: string;
  orderHash: string;
  simulationFingerprint: string;
  simulatedAt: string;
}): Promise<boolean> {
  if (!UUID.test(input.ownerId) || !UUID.test(input.attemptId) ||
      !/^[a-f0-9]{64}$/i.test(input.orderHash) ||
      !/^[a-f0-9]{64}$/i.test(input.simulationFingerprint)) {
    throw new Error("Invalid live order simulation evidence");
  }
  const simulatedAt = Date.parse(input.simulatedAt);
  if (!Number.isFinite(simulatedAt) || simulatedAt > Date.now() + 5_000 || Date.now() - simulatedAt > 15_000) {
    throw new Error("Live order simulation evidence is stale or future-dated");
  }
  const result = await request("rpc/wolv_record_live_execution_simulation", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_attempt_id: input.attemptId,
      p_order_hash: input.orderHash,
      p_simulation_fingerprint: input.simulationFingerprint,
      p_simulated_at: input.simulatedAt,
    }),
  });
  return result === true;
}

export async function listSettledLiveExecutionAttempts(
  ownerId: string,
  limit = 100,
): Promise<LiveExecutionAttempt[]> {
  if (!UUID.test(ownerId)) throw new Error("Invalid live execution owner UUID");
  const query = new URLSearchParams({
    select: "*",
    owner_id: "eq." + ownerId,
    status: "eq.SETTLED",
    order: "updated_at.asc",
    limit: String(Math.max(1, Math.min(200, Math.floor(limit)))),
  });
  const rows = await request("wolv_live_execution_attempts?" + query) as unknown[];
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid settled live-attempt queue");
  return rows.map(parseAttempt);
}


export async function recordLiveExecutionSimulation(input: {
  ownerId: string;
  attemptId: string;
  orderHash: string;
  simulationFingerprint: string;
  simulatedAt: string;
}): Promise<boolean> {
  if (!UUID.test(input.ownerId) || !UUID.test(input.attemptId) ||
      !/^[a-f0-9]{64}$/i.test(input.orderHash) ||
      !/^[a-f0-9]{64}$/i.test(input.simulationFingerprint)) {
    throw new Error("Invalid live order simulation evidence");
  }
  const simulatedAt = Date.parse(input.simulatedAt);
  if (!Number.isFinite(simulatedAt) || simulatedAt > Date.now() + 5_000 || Date.now() - simulatedAt > 15_000) {
    throw new Error("Live order simulation evidence is stale or future-dated");
  }
  const result = await request("rpc/wolv_record_live_execution_simulation", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_attempt_id: input.attemptId,
      p_order_hash: input.orderHash,
      p_simulation_fingerprint: input.simulationFingerprint,
      p_simulated_at: input.simulatedAt,
    }),
  });
  return result === true;
}
