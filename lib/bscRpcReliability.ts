export type RpcErrorClass =
  | "NONE"
  | "HTTP_RATE_LIMIT"
  | "HTTP_SERVER_ERROR"
  | "HTTP_ERROR"
  | "TRANSPORT_TIMEOUT"
  | "DNS_FAILURE"
  | "CONNECTION_RESET"
  | "CONNECTION_REFUSED"
  | "TRANSPORT_ERROR"
  | "RPC_INVALID_PARAMETERS"
  | "RPC_HEADER_NOT_FOUND"
  | "RPC_HISTORICAL_STATE_UNAVAILABLE"
  | "RPC_PROVIDER_ERROR"
  | "JSON_RPC_ERROR"
  | "INVALID_RPC_RESPONSE";

export type RpcReadStage = "BLOCK" | "BYTECODE" | "DECIMALS";

export type RpcRequestDiagnostic = {
  method: string;
  stage: RpcReadStage;
  errorClass: RpcErrorClass;
  providerErrorCode: number | string | null;
  httpStatus: number | null;
  attempt: number;
  requestDurationMs: number;
  validRpcResponse: boolean;
  retryable: boolean;
  retryAfterMs: number | null;
  providerMessage: string | null;
  succeeded: boolean;
  causeChain: Array<{ name: string; code: number | string | null }>;
};

type RetryDependencies = {
  maxRetries?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type RpcReadSuccess<T> = { ok: true; value: T; diagnostics: RpcRequestDiagnostic[] };
type RpcReadFailure = { ok: false; diagnostic: RpcRequestDiagnostic; diagnostics: RpcRequestDiagnostic[] };

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
export const MAX_AUDIT_CONCURRENCY = 4;
const SAFE_TRANSPORT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ECONNRESET",
  "UND_ERR_SOCKET",
  "EPIPE",
  "ECONNREFUSED",
]);
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "TimeoutError",
  "HttpRequestError",
  "RpcRequestError",
  "BaseError",
  "SocketError",
]);

export function markInvalidRpcResponse(
  diagnostics: RpcRequestDiagnostic[],
): RpcRequestDiagnostic[] {
  const updated = [...diagnostics];
  const last = updated.at(-1);
  if (last?.succeeded) {
    updated[updated.length - 1] = {
      ...last,
      errorClass: "INVALID_RPC_RESPONSE",
      validRpcResponse: false,
      retryable: false,
      succeeded: false,
    };
  }
  return updated;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_AUDIT_CONCURRENCY) {
    throw new RangeError(`concurrency must be an integer between 1 and ${MAX_AUDIT_CONCURRENCY}.`);
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runRpcRead<T>(
  input: {
    method: string;
    stage: RpcReadStage;
    operation: () => Promise<T>;
  } & RetryDependencies,
): Promise<RpcReadSuccess<T> | RpcReadFailure> {
  const maxRetries = input.maxRetries ?? MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES) {
    throw new RangeError(`maxRetries must be an integer between 0 and ${MAX_RETRIES}.`);
  }
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const diagnostics: RpcRequestDiagnostic[] = [];

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const startedAt = now();
    try {
      const value = await input.operation();
      const duration = Math.max(0, now() - startedAt);
      return {
        ok: true,
        value,
        diagnostics: [...diagnostics, {
          method: input.method,
          stage: input.stage,
          errorClass: "NONE",
          providerErrorCode: null,
          httpStatus: null,
          attempt,
          requestDurationMs: duration,
          validRpcResponse: true,
          retryable: false,
          retryAfterMs: null,
          providerMessage: null,
          succeeded: true,
          causeChain: [],
        }],
      };
    } catch (error) {
      const diagnostic = classifyRpcFailure(error, {
        method: input.method,
        stage: input.stage,
        attempt,
        requestDurationMs: Math.max(0, now() - startedAt),
      });
      diagnostics.push(diagnostic);
      if (!diagnostic.retryable || attempt > maxRetries) {
        return { ok: false, diagnostic, diagnostics };
      }

      const backoffBase = Math.min(250 * 2 ** (attempt - 1), 5_000);
      const jitter = Math.floor(Math.max(0, Math.min(1, random())) * backoffBase * 0.25);
      const delay = Math.max(backoffBase + jitter, diagnostic.retryAfterMs ?? 0);
      if (delay > MAX_RETRY_DELAY_MS) {
        return { ok: false, diagnostic, diagnostics };
      }
      await sleep(delay);
    }
  }

  throw new Error("Unreachable RPC retry state.");
}

export function classifyRpcFailure(
  error: unknown,
  request: {
    method: string;
    stage: RpcReadStage;
    attempt: number;
    requestDurationMs: number;
  },
): RpcRequestDiagnostic {
  const causes = collectCauses(error);
  const messages = causes.map((cause) => readStringProperty(cause, "shortMessage") ??
    readStringProperty(cause, "message") ?? "").join(" ").toLowerCase();
  const providerMessage = findSafeProviderMessage(causes);
  const httpStatus = findHttpStatus(causes);
  const providerErrorCode = findProviderErrorCode(causes);
  const codeNames = causes.map((cause) => readStringProperty(cause, "code") ?? "");

  let errorClass: RpcErrorClass;
  let validRpcResponse = false;
  let retryable = false;
  if (httpStatus === 429) {
    errorClass = "HTTP_RATE_LIMIT";
    retryable = true;
  } else if (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) {
    errorClass = "HTTP_SERVER_ERROR";
    retryable = true;
  } else if (httpStatus !== null) {
    errorClass = "HTTP_ERROR";
  } else if (codeNames.includes("ETIMEDOUT") || codeNames.includes("UND_ERR_CONNECT_TIMEOUT") ||
    causes.some((cause) => readStringProperty(cause, "name") === "TimeoutError" ||
      readStringProperty(cause, "name") === "AbortError") ||
    /timed?\s*out|timeout/.test(messages)) {
    errorClass = "TRANSPORT_TIMEOUT";
    retryable = true;
  } else if (codeNames.includes("EAI_AGAIN") || codeNames.includes("ENOTFOUND") ||
    codeNames.includes("EAI_FAIL")) {
    errorClass = "DNS_FAILURE";
    retryable = codeNames.includes("EAI_AGAIN");
  } else if (codeNames.includes("ECONNRESET") || codeNames.includes("UND_ERR_SOCKET") ||
    codeNames.includes("EPIPE")) {
    errorClass = "CONNECTION_RESET";
    retryable = true;
  } else if (codeNames.includes("ECONNREFUSED")) {
    errorClass = "CONNECTION_REFUSED";
    retryable = true;
  } else if (typeof providerErrorCode === "number") {
    validRpcResponse = true;
    const rpcMessage = providerMessage?.toLowerCase() ?? "";
    if (/missing or invalid parameters|invalid params|invalid parameter|invalid argument/.test(rpcMessage)) {
      errorClass = "RPC_INVALID_PARAMETERS";
    } else if (/header not found|unknown header|header .*not found/.test(rpcMessage)) {
      errorClass = "RPC_HEADER_NOT_FOUND";
    } else if (/historical|archive|missing trie|pruned|state unavailable|unknown block|block not found/.test(rpcMessage)) {
      errorClass = "RPC_HISTORICAL_STATE_UNAVAILABLE";
    } else if (providerErrorCode === -32000) {
      errorClass = "RPC_PROVIDER_ERROR";
    } else {
      errorClass = "JSON_RPC_ERROR";
    }
    retryable = (errorClass === "RPC_HISTORICAL_STATE_UNAVAILABLE" ||
      errorClass === "RPC_PROVIDER_ERROR") &&
      /temporar|unavailable|timeout|busy/.test(rpcMessage);
  } else if (causes.some((cause) => readStringProperty(cause, "name") === "HttpRequestError" ||
    readStringProperty(cause, "name") === "RpcRequestError")) {
    validRpcResponse = causes.some((cause) => readStringProperty(cause, "name") === "RpcRequestError");
    errorClass = validRpcResponse ? "JSON_RPC_ERROR" : "TRANSPORT_ERROR";
  } else {
    errorClass = "TRANSPORT_ERROR";
  }

  return {
    method: request.method,
    stage: request.stage,
    errorClass,
    providerErrorCode,
    httpStatus,
    attempt: request.attempt,
    requestDurationMs: request.requestDurationMs,
    validRpcResponse,
    retryable,
    retryAfterMs: findRetryAfterMs(causes),
    providerMessage,
    succeeded: false,
    causeChain: causes.slice(0, 6).map((cause) => ({
      name: safeName(readStringProperty(cause, "name")),
      code: safeCode(readProperty(cause, "code")),
    })),
  };
}

export function sanitizeProviderMessage(message: string): string | null {
  const sanitized = message
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || null;
}

function findSafeProviderMessage(causes: Record<string, unknown>[]): string | null {
  for (const cause of causes) {
    const message = readStringProperty(cause, "shortMessage") ??
      readStringProperty(cause, "message");
    if (!message) continue;
    const sanitized = sanitizeProviderMessage(message);
    if (sanitized) return sanitized;
  }
  return null;
}

function collectCauses(error: unknown): Record<string, unknown>[] {
  const causes: Record<string, unknown>[] = [];
  let current: unknown = error;
  const seen = new Set<object>();
  while (isRecord(current) && causes.length < 6 && !seen.has(current)) {
    seen.add(current);
    causes.push(current);
    current = current.cause;
  }
  return causes;
}

function findHttpStatus(causes: Record<string, unknown>[]): number | null {
  for (const cause of causes) {
    for (const key of ["status", "statusCode"]) {
      const value = cause[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        return value;
      }
    }
  }
  return null;
}

function findProviderErrorCode(causes: Record<string, unknown>[]): number | string | null {
  for (const cause of causes) {
    const code = cause.code;
    if (typeof code === "number" && Number.isInteger(code) && code < 0) return code;
    if (typeof code === "string" && SAFE_TRANSPORT_CODES.has(code)) return code;
    const nestedError = cause.error;
    if (isRecord(nestedError) && typeof nestedError.code === "number" &&
      Number.isInteger(nestedError.code) && nestedError.code < 0) return nestedError.code;
  }
  return null;
}

function findRetryAfterMs(causes: Record<string, unknown>[]): number | null {
  for (const cause of causes) {
    const headers = cause.headers;
    let value: string | null = null;
    if (headers instanceof Headers) {
      value = headers.get("retry-after");
    } else if (isRecord(headers) && typeof headers["retry-after"] === "string") {
      value = headers["retry-after"];
    }
    if (!value) continue;
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
      const milliseconds = Number(value.trim()) * 1_000;
      if (Number.isFinite(milliseconds)) return milliseconds;
      continue;
    }
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  return null;
}

function readProperty(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function readStringProperty(value: Record<string, unknown>, key: string): string | null {
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function safeName(value: string | null): string {
  return value && SAFE_ERROR_NAMES.has(value) ? value : "Error";
}

function safeCode(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isInteger(value) && value < 0) return value;
  return typeof value === "string" && SAFE_TRANSPORT_CODES.has(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
