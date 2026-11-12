import { getOrderStatus, submitOrder } from "../../lib/binance";
import type { PreparedRfqOrder, RfqExecutionProvider } from "./execution-contracts";
import type { ReconciliationResult, SubmissionResult } from "./execution-contracts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveInteger(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Binance RFQ response has invalid " + field);
  }
  return value;
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Binance RFQ response has invalid " + field);
  return value.trim();
}
function envelope(value: unknown): RecordValue {
  if (!record(value) || value.code !== 0 || value.success !== true || !record(value.data)) {
    throw new Error("Binance RFQ response envelope is unsuccessful or malformed");
  }
  return value.data;
}
function uuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseBinanceRfqSubmitResponse(response: unknown, expectedOrderId: string, now = Date.now()): SubmissionResult {
  try {
    const data = envelope(response);
    const providerOrderId = nonEmpty(data.orderId, "data.orderId");
    if (providerOrderId !== expectedOrderId) {
      return { status: "UNKNOWN", observedAt: new Date(now).toISOString(), reason: "Submit response order ID does not match the prepared RFQ order" };
    }
    const status = nonEmpty(data.status, "data.status");
    const createdAt = Number(data.createdAt);
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > now + 5_000 || now - createdAt > 60_000) {
      return { status: "UNKNOWN", observedAt: new Date(now).toISOString(), reason: "Submit response timestamp is invalid or stale" };
    }
    if (!["PENDING_VENDOR", "PENDING_ONCHAIN", "FILLED"].includes(status)) {
      return { status: "UNKNOWN", observedAt: new Date(now).toISOString(), reason: "Unrecognized initial provider status: " + status };
    }
    return { status: "SUBMITTED", providerOrderId, submittedAt: new Date(createdAt).toISOString() };
  } catch (error) {
    return {
      status: "UNKNOWN", observedAt: new Date(now).toISOString(),
      reason: error instanceof Error ? error.message.slice(0, 200) : "Malformed submit response",
    };
  }
}

export function parseBinanceRfqStatusResponse(
  response: unknown, expectedOrderId: string, now = Date.now(),
): ReconciliationResult {
  try {
    const data = envelope(response);
    const responseTimestamp = record(response) ? Number(response.timestamp) : NaN;
    if (!Number.isSafeInteger(responseTimestamp) || responseTimestamp <= 0 || responseTimestamp > now + 5_000 || now - responseTimestamp > 30_000) {
      return { status: "UNKNOWN", checkedAt: new Date(now).toISOString(), reason: "Order status response timestamp is invalid or stale" };
    }
    const providerOrderId = nonEmpty(data.orderId, "data.orderId");
    if (providerOrderId !== expectedOrderId) {
      return { status: "UNKNOWN", checkedAt: new Date(now).toISOString(), reason: "Provider order ID mismatch" };
    }
    const status = nonEmpty(data.status, "data.status");
    const checkedAt = new Date(now).toISOString();
    if (status === "PENDING_VENDOR" || status === "PENDING_ONCHAIN") {
      return { status: "PENDING", checkedAt, providerOrderId };
    }
    if (status === "FAILED" || status === "EXPIRED" || status === "CANCELLED") {
      return { status: "FAILED", checkedAt, providerOrderId, reasonCode: "BINANCE_RFQ_" + status };
    }
    if (status === "FILLED") {
      const transactionHash = nonEmpty(data.txHash, "data.txHash");
      if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
        return { status: "UNKNOWN", checkedAt, reason: "Provider reported FILLED without a valid transaction hash" };
      }
      const amountIn = positiveInteger(data.fromAmount, "data.fromAmount");
      const amountOut = positiveInteger(data.toAmount, "data.toAmount");
      return { status: "PROVIDER_FILLED", checkedAt, providerOrderId, transactionHash, amountIn, amountOut };
    }
    return { status: "UNKNOWN", checkedAt, reason: "Unrecognized RFQ order status: " + status };
  } catch (error) {
    return {
      status: "UNKNOWN", checkedAt: new Date(now).toISOString(),
      reason: error instanceof Error ? error.message.slice(0, 200) : "Malformed status response",
    };
  }
}

/**
 * Binance's RFQ adapter. It never signs; callers must supply a signature from
 * an independently authorized TypedDataSigner. Provider FILLED is not chain
 * settlement until a separate receipt/balance verifier confirms it.
 */
export async function submitValidatedBinanceRfq(input: {
  requestId: string; order: PreparedRfqOrder; signerAddress: string; signature: string;
}): Promise<SubmissionResult> {
  if (!uuidV4(input.requestId)) throw new Error("RFQ requestId must be a stable UUID v4");
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error("RFQ signature must be a 65-byte hex signature");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.signerAddress) ||
      input.signerAddress.toLowerCase() !== input.order.walletAddress.toLowerCase()) {
    throw new Error("RFQ signer address does not match the wallet used for the quote");
  }
  if (input.order.signingScheme !== "EIP712" || input.order.chainId !== "56") {
    throw new Error("Unsupported RFQ signing scheme or chain");
  }
  const quoteExpiry = Date.parse(input.order.quoteExpiresAt);
  if (!Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now()) {
    return { status: "REJECTED", providerCode: "QUOTE_EXPIRED", rejectedAt: new Date().toISOString() };
  }
  try {
    const response = await submitOrder(input.requestId, input.signature, input.order.vendor, input.order.orderId);
    return parseBinanceRfqSubmitResponse(response, input.order.orderId);
  } catch (error) {
    // A timeout may happen after provider acceptance. Never blindly resubmit with a new requestId.
    return {
      status: "UNKNOWN", observedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message.slice(0, 200) : "Unknown submission outcome",
    };
  }
}

export async function reconcileValidatedBinanceRfq(input: {
  providerOrderId: string;
}): Promise<ReconciliationResult> {
  const providerOrderId = nonEmpty(input.providerOrderId, "providerOrderId");
  try {
    return parseBinanceRfqStatusResponse(await getOrderStatus(providerOrderId), providerOrderId);
  } catch (error) {
    return {
      status: "UNKNOWN", checkedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message.slice(0, 200) : "Unknown reconciliation outcome",
    };
  }
}

export const binanceRfqExecutionProvider: RfqExecutionProvider = {
  async submit(input) {
    return submitValidatedBinanceRfq({
      requestId: input.requestId, order: input.order,
      signerAddress: input.signerAddress, signature: input.signature,
    });
  },
  async reconcile(input) {
    if (!input.providerOrderId) {
      return { status: "UNKNOWN", checkedAt: new Date().toISOString(), reason: "Binance platform order ID is required for status polling" };
    }
    return reconcileValidatedBinanceRfq({ providerOrderId: input.providerOrderId });
  },
};
