import { createHash } from "node:crypto";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUOTE_MAX_AGE_MS = 10_000;

export type OneInchQuoteRequest = {
  chainId: string;
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  now?: number;
};

export type OneInchClassicQuote = {
  provider: "1inch-classic";
  chainId: "56";
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  gasEstimate: string;
  observedAt: string;
  expiresAt: string;
  routeFingerprint: string;
  rawEvidenceRef: string;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
};

export type OneInchClassicTransaction = {
  provider: "1inch-classic";
  chainId: "56";
  walletAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
  transactionFingerprint: string;
  preparedAt: string;
  quoteExpiresAt: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function address(value: unknown, field: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error("1inch response has invalid " + field);
  return value.toLowerCase();
}
function uint(value: unknown, field: string): string {
  const result = value;
  if (typeof result !== "string" || !UINT.test(result) || BigInt(result) <= BigInt(0)) {
    throw new Error("1inch response has invalid " + field);
  }
  return result;
}
function decimals(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 36) {
    throw new Error("1inch response has invalid " + field);
  }
  return value as number;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseOneInchClassicQuote(
  response: unknown,
  request: OneInchQuoteRequest,
): OneInchClassicQuote {
  if (request.chainId !== "56" || !ADDRESS.test(request.walletAddress) ||
      !ADDRESS.test(request.inputTokenAddress) || !ADDRESS.test(request.outputTokenAddress) ||
      request.inputTokenAddress.toLowerCase() === request.outputTokenAddress.toLowerCase() ||
      !UINT.test(request.amountIn) || BigInt(request.amountIn) <= BigInt(0)) {
    throw new Error("Invalid 1inch quote request");
  }
  if (!record(response) || !record(response.srcToken) || !record(response.dstToken)) {
    throw new Error("1inch quote response is malformed");
  }
  const src = address(response.srcToken.address, "srcToken.address");
  const dst = address(response.dstToken.address, "dstToken.address");
  if (src !== request.inputTokenAddress.toLowerCase() || dst !== request.outputTokenAddress.toLowerCase()) {
    throw new Error("1inch quote token direction does not match request");
  }
  const amountIn = uint(response.srcAmount, "srcAmount");
  if (amountIn !== request.amountIn) throw new Error("1inch quote input amount does not match request");
  const expectedAmountOut = uint(response.dstAmount, "dstAmount");
  const gasEstimate = uint(response.gas, "gas");
  const now = request.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTE_MAX_AGE_MS).toISOString();
  return {
    provider: "1inch-classic",
    chainId: "56",
    walletAddress: request.walletAddress.toLowerCase(),
    inputTokenAddress: src,
    outputTokenAddress: dst,
    amountIn,
    expectedAmountOut,
    gasEstimate,
    observedAt,
    expiresAt,
    sourceTokenDecimals: decimals(response.srcToken.decimals, "srcToken.decimals"),
    destinationTokenDecimals: decimals(response.dstToken.decimals, "dstToken.decimals"),
    routeFingerprint: digest(response.protocols ?? response),
    rawEvidenceRef: digest(response),
  };
}

export function parseOneInchClassicTransaction(
  response: unknown,
  quote: OneInchClassicQuote,
  slippageBps: number,
  now = Date.now(),
): OneInchClassicTransaction {
  if (Date.parse(quote.expiresAt) <= now) throw new Error("1inch quote expired before transaction construction");
  if (!record(response) || !record(response.tx)) throw new Error("1inch swap response is missing transaction data");
  const tx = response.tx;
  const returnedInput = uint(response.srcAmount, "srcAmount");
  const returnedOutput = uint(response.dstAmount, "dstAmount");
  if (returnedInput !== quote.amountIn) throw new Error("1inch swap transaction input amount differs from quote");
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000) throw new Error("Invalid slippage for 1inch transaction validation");
  const minimumOutput = BigInt(quote.expectedAmountOut) * BigInt(10_000 - slippageBps) / BigInt(10_000);
  if (BigInt(returnedOutput) < minimumOutput) throw new Error("1inch swap transaction output is below the quote minimum");
  const to = address(tx.to, "tx.to");
  const data = tx.data;
  if (typeof data !== "string" || !HEX.test(data) || data.length < 10) {
    throw new Error("1inch transaction calldata is malformed");
  }
  const value = typeof tx.value === "string" && UINT.test(tx.value) ? tx.value : null;
  if (value === null) throw new Error("1inch transaction has invalid native value");
  const gas = uint(tx.gas, "tx.gas");
  const gasPrice = uint(tx.gasPrice, "tx.gasPrice");
  const transaction = {
    provider: "1inch-classic" as const,
    chainId: "56" as const,
    walletAddress: quote.walletAddress,
    inputTokenAddress: quote.inputTokenAddress,
    outputTokenAddress: quote.outputTokenAddress,
    amountIn: quote.amountIn,
    expectedAmountOut: quote.expectedAmountOut,
    to, data, value, gas, gasPrice,
    preparedAt: new Date(now).toISOString(),
    quoteExpiresAt: quote.expiresAt,
  };
  return { ...transaction, transactionFingerprint: digest(transaction) };
}

export function createOneInchClassicClient(input: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? "https://api.1inch.dev/swap/v6.1").replace(/\/$/, "");
  const apiKey = input.apiKey ?? process.env.ONEINCH_API_KEY ?? "";
  async function apiRequest(path: string, params: Record<string, string>) {
    if (!apiKey.trim()) throw new Error("ONEINCH_API_KEY is not configured");
    const url = new URL(baseUrl + "/56/" + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("1inch API returned HTTP " + response.status);
    return response.json() as Promise<unknown>;
  }
  return {
    async getQuote(quoteRequest: OneInchQuoteRequest): Promise<OneInchClassicQuote> {
      const response = await apiRequest("quote", {
        src: quoteRequest.inputTokenAddress, dst: quoteRequest.outputTokenAddress,
        amount: quoteRequest.amountIn, includeTokensInfo: "true", includeProtocols: "true",
      });
      return parseOneInchClassicQuote(response, quoteRequest);
    },
    async buildTransaction(quote: OneInchClassicQuote, slippageBps: number): Promise<OneInchClassicTransaction> {
      if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000) {
        throw new Error("1inch slippage must be between 1 and 5000 bps");
      }
      const response = await apiRequest("swap", {
        src: quote.inputTokenAddress, dst: quote.outputTokenAddress,
        amount: quote.amountIn, from: quote.walletAddress,
        slippage: String(slippageBps / 100),
        disableEstimate: "false", allowPartialFill: "false",
      });
      return parseOneInchClassicTransaction(response, quote, slippageBps, input.now?.() ?? Date.now());
    },
  };
}
