import "server-only";
import {
  classifyRpcFailure,
  sanitizeProviderMessage,
} from "./bscRpcReliability.ts";

type JsonRpcRequest = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type RpcWireRecord = {
  method: string | null;
  parameterCount: number | null;
  targetAddress: string | null;
  blockParameterType: "hex-quantity" | "block-tag" | "object" | "other" | null;
  serializedBlockParameter: string | Record<string, unknown> | null;
  inputBlockNumberType: string | null;
  attempt: number;
  responseDurationMs: number;
  httpStatus: number | null;
  jsonRpcErrorCode: number | string | null;
  providerMessage: string | null;
  validJsonRpcResponse: boolean;
  errorClass: string;
  retryable: boolean;
};

class InvalidRpcResponseError extends Error {
  constructor() {
    super("Invalid JSON-RPC response received.");
    this.name = "InvalidRpcResponseError";
  }
}

export function createRpcWireRecorder(fetchImplementation: typeof fetch = fetch) {
  const records: RpcWireRecord[] = [];
  const attempts = new Map<string, number>();
  const inputBlockTypes = new Map<string, string[]>();

  const fetchFn: typeof fetch = async (input, init) => {
    const requestBody = readRequestBody(init?.body);
    const method = typeof requestBody?.method === "string" ? requestBody.method : null;
    const params = Array.isArray(requestBody?.params) ? requestBody.params : null;
    const targetAddress = readTargetAddress(method, params);
    const serializedBlockParameter = readBlockParameter(method, params);
    const key = requestKey(method, targetAddress, serializedBlockParameter);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const record: RpcWireRecord = {
      method,
      parameterCount: params?.length ??
        (requestBody && !Object.hasOwn(requestBody, "params") ? 0 : null),
      targetAddress,
      blockParameterType: classifyBlockParameter(serializedBlockParameter),
      serializedBlockParameter,
      inputBlockNumberType: takeInputBlockType(inputBlockTypes, key),
      attempt,
      responseDurationMs: 0,
      httpStatus: null,
      jsonRpcErrorCode: null,
      providerMessage: null,
      validJsonRpcResponse: false,
      errorClass: "INVALID_RPC_RESPONSE",
      retryable: false,
    };
    records.push(record);
    const startedAt = performance.now();
    try {
      const response = await fetchImplementation(input, init);
      record.httpStatus = response.status;
      const responseBody = await readResponseBody(response);
      if (responseBody) {
        record.validJsonRpcResponse = isJsonRpcResponse(responseBody, requestBody?.id);
        const rpcError = readRpcError(responseBody);
        if (rpcError) {
          record.jsonRpcErrorCode = rpcError.code;
          record.providerMessage = rpcError.message === null
            ? null
            : sanitizeProviderMessage(rpcError.message);
        }
      }
      record.responseDurationMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (response.status < 200 || response.status >= 300) {
        applyFailureClassification(record, {
          status: response.status,
          message: record.providerMessage ?? `HTTP ${response.status}`,
        }, method);
      } else if (record.validJsonRpcResponse && record.jsonRpcErrorCode !== null) {
        applyFailureClassification(record, {
          code: record.jsonRpcErrorCode,
          message: record.providerMessage ?? "JSON-RPC error response",
        }, method);
      } else if (record.validJsonRpcResponse) {
        record.errorClass = "NONE";
      } else {
        record.errorClass = "INVALID_RPC_RESPONSE";
        if (response.status >= 200 && response.status < 300) {
          throw new InvalidRpcResponseError();
        }
      }
      return response;
    } catch (error) {
      record.responseDurationMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (error instanceof InvalidRpcResponseError) {
        record.errorClass = "INVALID_RPC_RESPONSE";
        record.retryable = false;
      } else {
        applyFailureClassification(record, error, method);
      }
      throw error;
    }
  };

  return {
    fetchFn,
    snapshot: () => records.map((record) => ({ ...record })),
    noteBlockInput(method: string, targetAddress: unknown, blockInput: unknown) {
      const serialized = serializeInputBlock(blockInput);
      const key = requestKey(method, normalizeAddress(targetAddress), serialized.value);
      const inputTypes = inputBlockTypes.get(key) ?? [];
      inputTypes.push(serialized.inputType);
      inputBlockTypes.set(key, inputTypes);
    },
  };
}

export function requireRpcBlockNumber(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < BigInt(0)) {
    throw new TypeError("RPC block number must be a non-negative bigint.");
  }
}

function readRequestBody(body: BodyInit | null | undefined): JsonRpcRequest | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function readTargetAddress(method: string | null, params: unknown[] | null): string | null {
  if (method === "eth_getCode" && typeof params?.[0] === "string") {
    return normalizeAddress(params[0]);
  }
  if (method === "eth_call" && isRecord(params?.[0]) && typeof params[0].to === "string") {
    return normalizeAddress(params[0].to);
  }
  return null;
}

function readBlockParameter(
  method: string | null,
  params: unknown[] | null,
): string | Record<string, unknown> | null {
  if (!params) return null;
  const position = method === "eth_getCode" ? 1
    : method === "eth_getBlockByNumber" ? 0
      : method === "eth_call" ? 1
        : null;
  if (position === null) return null;
  const value = params[position];
  if (typeof value === "string") return value;
  if (isRecord(value)) return value;
  return null;
}

function classifyBlockParameter(
  value: string | Record<string, unknown> | null,
): RpcWireRecord["blockParameterType"] {
  if (value === null) return null;
  if (typeof value === "object") return "object";
  if (/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return "hex-quantity";
  if (value === "latest" || value === "earliest" || value === "pending" ||
    value === "safe" || value === "finalized") return "block-tag";
  return "other";
}

function readRpcError(
  response: Record<string, unknown>,
): { code: number | null; message: string | null } | null {
  if (!isRecord(response.error)) return null;
  const code = typeof response.error.code === "number" && Number.isInteger(response.error.code)
    ? response.error.code
    : null;
  const message = typeof response.error.message === "string" ? response.error.message : null;
  return { code, message };
}

function isJsonRpcResponse(value: unknown, requestId: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== "2.0" ||
    requestId === undefined || !Object.hasOwn(value, "id") || value.id !== requestId) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  return isRecord(value.error) &&
    typeof value.error.code === "number" &&
    Number.isInteger(value.error.code) &&
    typeof value.error.message === "string";
}

async function readResponseBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function serializeKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function requestKey(
  method: string | null,
  targetAddress: string | null,
  blockParameter: unknown,
): string {
  return `${method ?? "unknown"}:${targetAddress ?? ""}:${serializeKey(blockParameter)}`;
}

function serializeInputBlock(value: unknown): { inputType: string; value: unknown } {
  if (typeof value === "bigint") return { inputType: "bigint", value: `0x${value.toString(16)}` };
  if (typeof value === "string") return { inputType: "string", value };
  if (isRecord(value)) return { inputType: "object", value };
  if (value === undefined) return { inputType: "undefined", value: "latest" };
  return { inputType: typeof value, value };
}

function takeInputBlockType(inputTypes: Map<string, string[]>, key: string): string | null {
  const queue = inputTypes.get(key);
  if (!queue?.length) return null;
  const inputType = queue.shift() ?? null;
  if (!queue.length) inputTypes.delete(key);
  return inputType;
}

function applyFailureClassification(
  record: RpcWireRecord,
  error: unknown,
  method: string | null,
): void {
  const diagnostic = classifyRpcFailure(error, {
    method: method ?? "unknown",
    stage: method === "eth_getBlockByNumber" || method === "eth_blockNumber" ||
      method === "eth_chainId"
      ? "BLOCK"
      : method === "eth_call"
        ? "DECIMALS"
        : "BYTECODE",
    attempt: record.attempt,
    requestDurationMs: record.responseDurationMs,
  });
  record.errorClass = diagnostic.errorClass;
  record.retryable = diagnostic.retryable;
  record.jsonRpcErrorCode = diagnostic.providerErrorCode ?? record.jsonRpcErrorCode;
  record.providerMessage = diagnostic.providerMessage ?? record.providerMessage;
}

function normalizeAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
