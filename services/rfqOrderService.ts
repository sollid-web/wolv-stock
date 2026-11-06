import "server-only";
import postgres, { type Sql } from "postgres";
import { EVM_ADDRESS_PATTERN, isValidBinanceQuoteId } from "../lib/apiValidation.ts";
import { validateBinanceRfqTypedData } from "../lib/binanceExecutionValidation.ts";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,35})(?:\.\d{1,18})?$/;
const MAX_POLL_ATTEMPTS = 6;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

export type RfqOrderBinding = {
  requestId: string;
  executionId: string;
  quoteId: string;
  vendor: string;
  userWalletAddress: string;
  chainId: 56;
  targetTokenAddress: string;
  amount: string;
  targetPriceLowerBound: string;
  targetPriceUpperBound: string;
  quoteFetchedAt: number;
  expiresAt: number;
};

export type RfqProviderOrderState = "PENDING" | "FILLED" | "FAILED" | "UNKNOWN";

export type RfqOrderLedgerPort = {
  recordIntent(input: RfqOrderBinding): Promise<void>;
  markSubmitted(requestId: string, orderId: string, at: number): Promise<void>;
  recordPoll(input: {
    requestId: string;
    orderId: string;
    attempt: number;
    providerState: RfqProviderOrderState;
    observedAt: number;
    detail?: string;
  }): Promise<void>;
  markReconciliationRequired(input: {
    requestId: string;
    orderId: string;
    attempts: number;
    at: number;
    detail: string;
  }): Promise<void>;
};

export type RfqOrderStatusResult =
  | { status: "FILLED" | "FAILED"; attempts: number; orderId: string }
  | { status: "RECONCILIATION_REQUIRED"; attempts: number; orderId: string };

export class RfqOrderServiceError extends Error {
  readonly code:
    | "INVALID_RFQ_BINDING"
    | "IDEMPOTENCY_CONFLICT"
    | "RFQ_SCHEMA_UNVERIFIED"
    | "AUTONOMOUS_RFQ_UNAVAILABLE"
    | "INVALID_RFQ_STATUS";

  constructor(
    code: RfqOrderServiceError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RfqOrderServiceError";
    this.code = code;
  }
}

export class RfqOrderLedgerError extends Error {
  readonly code: "NOT_CONFIGURED" | "INVALID_DATABASE_URL";

  constructor(code: RfqOrderLedgerError["code"]) {
    super(`RFQ order ledger unavailable: ${code}`);
    this.name = "RfqOrderLedgerError";
    this.code = code;
  }
}

export class PostgresRfqOrderLedger implements RfqOrderLedgerPort {
  private readonly sql: Sql;
  private readonly ready: Promise<void>;

  constructor(databaseUrl = process.env.WOLV_TRADING_DATABASE_URL) {
    if (!databaseUrl) throw new RfqOrderLedgerError("NOT_CONFIGURED");
    if (!isSafePostgresUrl(databaseUrl)) throw new RfqOrderLedgerError("INVALID_DATABASE_URL");
    this.sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 5,
      max_lifetime: 300,
      prepare: false,
      ssl: isLocalDevelopmentUrl(databaseUrl) ? false : "verify-full",
    });
    this.ready = this.migrate();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async recordIntent(input: RfqOrderBinding): Promise<void> {
    validateRfqOrderBinding(input);
    await this.ready;
    const inserted = await this.sql`
      INSERT INTO wolv_rfq_order_ledger (
        request_id, execution_id, quote_id, vendor, user_wallet_address, chain_id,
        target_token_address, amount, target_price_lower_bound, target_price_upper_bound,
        quote_fetched_at, expires_at, status, created_at, updated_at
      ) VALUES (
        ${input.requestId}, ${input.executionId}, ${input.quoteId}, ${input.vendor},
        ${input.userWalletAddress.toLowerCase()}, ${input.chainId},
        ${input.targetTokenAddress.toLowerCase()}, ${input.amount},
        ${input.targetPriceLowerBound}, ${input.targetPriceUpperBound},
        ${input.quoteFetchedAt}, ${input.expiresAt}, 'PREPARED',
        ${input.quoteFetchedAt}, ${input.quoteFetchedAt}
      )
      ON CONFLICT (request_id) DO NOTHING
      RETURNING request_id
    `;
    if (inserted.length === 1) return;
    const rows = await this.sql`
      SELECT execution_id, quote_id, vendor, user_wallet_address, chain_id,
        target_token_address, amount, target_price_lower_bound, target_price_upper_bound,
        quote_fetched_at, expires_at
      FROM wolv_rfq_order_ledger
      WHERE request_id = ${input.requestId}
    `;
    if (!rows[0] || !sameBinding(rows[0], input)) {
      throw new RfqOrderServiceError(
        "IDEMPOTENCY_CONFLICT",
        "RFQ requestId is already bound to different quote parameters.",
      );
    }
  }

  async markSubmitted(requestId: string, orderId: string, at: number): Promise<void> {
    assertRequestId(requestId);
    assertOrderId(orderId);
    await this.ready;
    const rows = await this.sql`
      UPDATE wolv_rfq_order_ledger
      SET status = 'SUBMITTED', provider_order_id = ${orderId}, updated_at = ${at}
      WHERE request_id = ${requestId}
        AND status IN ('PREPARED', 'SUBMITTED', 'RECONCILIATION_REQUIRED')
        AND (provider_order_id IS NULL OR provider_order_id = ${orderId})
      RETURNING request_id
    `;
    if (rows.length !== 1) {
      throw new RfqOrderServiceError("IDEMPOTENCY_CONFLICT", "RFQ provider order does not match the stored request.");
    }
  }

  async recordPoll(input: {
    requestId: string;
    orderId: string;
    attempt: number;
    providerState: RfqProviderOrderState;
    observedAt: number;
    detail?: string;
  }): Promise<void> {
    assertRequestId(input.requestId);
    assertOrderId(input.orderId);
    if (!Number.isInteger(input.attempt) || input.attempt < 1 ||
      input.attempt > MAX_POLL_ATTEMPTS || !Number.isSafeInteger(input.observedAt) ||
      !["PENDING", "FILLED", "FAILED", "UNKNOWN"].includes(input.providerState)) {
      throw new RfqOrderServiceError("INVALID_RFQ_STATUS", "RFQ status observation is invalid.");
    }
    await this.ready;
    await this.sql.begin(async (transaction) => {
      const current = await transaction`
        SELECT status, provider_order_id FROM wolv_rfq_order_ledger
        WHERE request_id = ${input.requestId}
        FOR UPDATE
      `;
      if (!current[0] || current[0].provider_order_id !== input.orderId) {
        throw new RfqOrderServiceError("IDEMPOTENCY_CONFLICT", "RFQ status does not match the stored provider order.");
      }
      if (current[0].status === "FILLED" || current[0].status === "FAILED") return;
      await transaction`
        INSERT INTO wolv_rfq_reconciliation_events (
          request_id, attempt, provider_state, observed_at, detail
        ) VALUES (
          ${input.requestId}, ${input.attempt}, ${input.providerState},
          ${input.observedAt}, ${input.detail?.slice(0, 1_000) ?? null}
        )
        ON CONFLICT (request_id, attempt) DO NOTHING
      `;
      const nextState = input.providerState === "FILLED" || input.providerState === "FAILED"
        ? input.providerState
        : current[0].status;
      await transaction`
        UPDATE wolv_rfq_order_ledger
        SET status = ${nextState},
            poll_attempts = GREATEST(poll_attempts, ${input.attempt}),
            last_provider_state = ${input.providerState},
            last_polled_at = ${input.observedAt},
            updated_at = ${input.observedAt}
        WHERE request_id = ${input.requestId}
      `;
    });
  }

  async markReconciliationRequired(input: {
    requestId: string;
    orderId: string;
    attempts: number;
    at: number;
    detail: string;
  }): Promise<void> {
    assertRequestId(input.requestId);
    assertOrderId(input.orderId);
    if (!Number.isInteger(input.attempts) || input.attempts < 0 ||
      input.attempts > MAX_POLL_ATTEMPTS || !Number.isSafeInteger(input.at)) {
      throw new RfqOrderServiceError("INVALID_RFQ_STATUS", "RFQ reconciliation timeout is invalid.");
    }
    await this.ready;
    const rows = await this.sql`
      UPDATE wolv_rfq_order_ledger
      SET status = CASE WHEN status IN ('FILLED', 'FAILED') THEN status ELSE 'RECONCILIATION_REQUIRED' END,
          poll_attempts = GREATEST(poll_attempts, ${input.attempts}),
          last_error = ${input.detail.slice(0, 1_000)},
          updated_at = ${input.at}
      WHERE request_id = ${input.requestId} AND provider_order_id = ${input.orderId}
      RETURNING status
    `;
    if (rows.length !== 1) {
      throw new RfqOrderServiceError("IDEMPOTENCY_CONFLICT", "RFQ reconciliation does not match a submitted order.");
    }
  }

  private async migrate(): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(7_891_230_459)`;
      await transaction`
        CREATE TABLE IF NOT EXISTS wolv_rfq_order_ledger (
          request_id uuid PRIMARY KEY,
          execution_id uuid NOT NULL,
          quote_id text NOT NULL,
          vendor varchar(128) NOT NULL,
          user_wallet_address text NOT NULL,
          chain_id integer NOT NULL CHECK (chain_id = 56),
          target_token_address text NOT NULL,
          amount numeric NOT NULL CHECK (amount > 0),
          target_price_lower_bound numeric NOT NULL CHECK (target_price_lower_bound > 0),
          target_price_upper_bound numeric NOT NULL CHECK (target_price_upper_bound >= target_price_lower_bound),
          quote_fetched_at bigint NOT NULL,
          expires_at bigint NOT NULL CHECK (expires_at > quote_fetched_at),
          status text NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','FILLED','FAILED','RECONCILIATION_REQUIRED')),
          provider_order_id text UNIQUE,
          poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts BETWEEN 0 AND 6),
          last_provider_state text CHECK (last_provider_state IN ('PENDING','FILLED','FAILED','UNKNOWN')),
          last_polled_at bigint,
          last_error text,
          created_at bigint NOT NULL,
          updated_at bigint NOT NULL,
          UNIQUE (execution_id, quote_id)
        )
      `;
      await transaction`
        CREATE TABLE IF NOT EXISTS wolv_rfq_reconciliation_events (
          event_id bigserial PRIMARY KEY,
          request_id uuid NOT NULL REFERENCES wolv_rfq_order_ledger(request_id),
          attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 6),
          provider_state text NOT NULL CHECK (provider_state IN ('PENDING','FILLED','FAILED','UNKNOWN')),
          observed_at bigint NOT NULL,
          detail text,
          UNIQUE (request_id, attempt)
        )
      `;
      await transaction`
        CREATE INDEX IF NOT EXISTS wolv_rfq_order_ledger_status_updated
        ON wolv_rfq_order_ledger (status, updated_at DESC)
      `;
    });
  }
}

export function extractRfqTypedDataVerbatim(response: unknown): unknown {
  const data = isRecord(response) && isRecord(response.data) ? response.data : null;
  const rfq = data && isRecord(data.rfq) ? data.rfq : null;
  if (!rfq || !Object.hasOwn(rfq, "typedDataToSign")) {
    throw new RfqOrderServiceError("RFQ_SCHEMA_UNVERIFIED", "Binance RFQ response does not match the required verified typed-data fixture.");
  }
  const validation = validateBinanceRfqTypedData(rfq.typedDataToSign);
  if (!validation.ok) {
    throw new RfqOrderServiceError("RFQ_SCHEMA_UNVERIFIED", validation.reason);
  }
  return rfq.typedDataToSign;
}

export function assertAutonomousRfqUnavailable(): never {
  throw new RfqOrderServiceError(
    "AUTONOMOUS_RFQ_UNAVAILABLE",
    "Autonomous RFQ execution is unavailable until an owner-scoped delegated policy and vendor acceptance of its signer for the exact EIP-712 domain are verified.",
  );
}

export async function pollRfqOrderStatus(input: {
  requestId: string;
  orderId: string;
  ledger: RfqOrderLedgerPort;
  getStatus?: (orderId: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<RfqOrderStatusResult> {
  assertRequestId(input.requestId);
  assertOrderId(input.orderId);
  const getStatus = input.getStatus ?? (await import("../lib/binance.ts")).getOrderStatus;
  const sleep = input.sleep ?? delay;
  const now = input.now ?? Date.now;
  let latestState: RfqProviderOrderState = "UNKNOWN";

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    let detail: string | undefined;
    try {
      latestState = parseProviderStatus(await getStatus(input.orderId));
    } catch (error) {
      latestState = "UNKNOWN";
      detail = error instanceof Error ? error.message.slice(0, 1_000) : "Provider status request failed.";
    }
    const observedAt = now();
    await input.ledger.recordPoll({
      requestId: input.requestId,
      orderId: input.orderId,
      attempt,
      providerState: latestState,
      observedAt,
      ...(detail ? { detail } : {}),
    });
    if (latestState === "FILLED" || latestState === "FAILED") {
      return { status: latestState, attempts: attempt, orderId: input.orderId };
    }
    if (attempt < MAX_POLL_ATTEMPTS) {
      await sleep(Math.min(INITIAL_BACKOFF_MS * (2 ** (attempt - 1)), MAX_BACKOFF_MS));
    }
  }

  await input.ledger.markReconciliationRequired({
    requestId: input.requestId,
    orderId: input.orderId,
    attempts: MAX_POLL_ATTEMPTS,
    at: now(),
    detail: "RFQ order did not reach FILLED or FAILED within the bounded status polling window.",
  });
  return {
    status: "RECONCILIATION_REQUIRED",
    attempts: MAX_POLL_ATTEMPTS,
    orderId: input.orderId,
  };
}

export function validateRfqOrderBinding(input: RfqOrderBinding): void {
  if (!UUID_V4_PATTERN.test(input.requestId) ||
    !UUID_V4_PATTERN.test(input.executionId) ||
    !isValidBinanceQuoteId(input.quoteId) ||
    typeof input.vendor !== "string" || input.vendor.length < 1 ||
    input.vendor.length > 128 || /[\r\n]/.test(input.vendor) ||
    !EVM_ADDRESS_PATTERN.test(input.userWalletAddress) ||
    input.chainId !== 56 ||
    !EVM_ADDRESS_PATTERN.test(input.targetTokenAddress) ||
    !isPositiveDecimal(input.amount) ||
    !DECIMAL_PATTERN.test(input.targetPriceLowerBound) ||
    !DECIMAL_PATTERN.test(input.targetPriceUpperBound) ||
    !isPositiveDecimal(input.targetPriceLowerBound) ||
    !isPositiveDecimal(input.targetPriceUpperBound) ||
    decimalUnits(input.targetPriceUpperBound) < decimalUnits(input.targetPriceLowerBound) ||
    !Number.isSafeInteger(input.quoteFetchedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.quoteFetchedAt) {
    throw new RfqOrderServiceError("INVALID_RFQ_BINDING", "RFQ quote binding is invalid.");
  }
}

function parseProviderStatus(response: unknown): RfqProviderOrderState {
  if (!isRecord(response) || response.code !== 0 || !isRecord(response.data) ||
    typeof response.data.status !== "string") {
    throw new RfqOrderServiceError("INVALID_RFQ_STATUS", "Binance RFQ order status response is malformed.");
  }
  const status = response.data.status.toUpperCase();
  if (status === "FILLED") return "FILLED";
  if (status === "FAILED") return "FAILED";
  return "PENDING";
}

function sameBinding(row: Record<string, unknown>, input: RfqOrderBinding): boolean {
  return String(row.execution_id) === input.executionId &&
    String(row.quote_id) === input.quoteId &&
    String(row.vendor) === input.vendor &&
    String(row.user_wallet_address).toLowerCase() === input.userWalletAddress.toLowerCase() &&
    Number(row.chain_id) === input.chainId &&
    String(row.target_token_address).toLowerCase() === input.targetTokenAddress.toLowerCase() &&
    canonicalDecimal(String(row.amount)) === canonicalDecimal(input.amount) &&
    canonicalDecimal(String(row.target_price_lower_bound)) === canonicalDecimal(input.targetPriceLowerBound) &&
    canonicalDecimal(String(row.target_price_upper_bound)) === canonicalDecimal(input.targetPriceUpperBound) &&
    Number(row.quote_fetched_at) === input.quoteFetchedAt &&
    Number(row.expires_at) === input.expiresAt;
}

function assertRequestId(value: string): void {
  if (!UUID_V4_PATTERN.test(value)) throw new RfqOrderServiceError("INVALID_RFQ_BINDING", "RFQ requestId must be a UUID v4.");
}

function assertOrderId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new RfqOrderServiceError("INVALID_RFQ_BINDING", "RFQ provider order ID is invalid.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && decimalUnits(value) > BigInt(0);
}

function decimalUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * (BigInt(10) ** BigInt(18)) + BigInt(fraction.padEnd(18, "0"));
}

function canonicalDecimal(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function isSafePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname.length > 0 && !url.username.includes("@") && !url.password.includes("@");
  } catch {
    return false;
  }
}

function isLocalDevelopmentUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
