import "server-only";
import { unstable_cache } from "next/cache";
import { isRwaAssetListResponse } from "./rwaAssetResponse";
import { makeBinanceAuthHeaders } from "./binanceAuth";

let lastCall = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();
async function rateLimit() {
  const scheduled = rateLimitQueue.then(async () => {
    const wait = Math.max(0, lastCall + 250 - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
  });
  rateLimitQueue = scheduled.catch(() => undefined);
  await scheduled;
}

const BASE_URL = "https://web3.binance.com/build";
const UPSTREAM_TIMEOUT_MS = 10_000;
const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const DECIMAL_INTEGER_PATTERN = /^\d{1,78}$/;
const DECIMAL_AMOUNT_PATTERN = /^\d{1,78}(?:\.\d{1,36})?$/;
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

export class BinanceApiError extends Error {
  readonly code: number | null;
  readonly httpStatus: number;

  constructor(
    message: string,
    code: number | null,
    httpStatus: number,
  ) {
    super(message);
    this.name = "BinanceApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type UnsignedEvmTransaction = {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string | null;
};

export type QuoteAndSwapTransaction = {
  executionMode: "SWAP";
  tx: UnsignedEvmTransaction;
  expectedOutputs: {
    fromTokenAmount: string;
    toTokenAmount: string;
    minimumReceivedAmount: string | null;
  };
};

export type UnsignedDefiCall = {
  callDataType: "APPROVE" | "DEPOSIT" | "REDEEM";
  from: string;
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  gasPrice: string | null;
  maxPriorityFeePerGas?: string | null;
  maxFeePerGas?: string | null;
};

export type DefiPreview = {
  success: boolean;
  balanceChange: Array<{
    tokenSymbol: string;
    tokenAddress: string;
    amount: string;
    valueUsd: string;
  }>;
  estimatedNetworkFee: {
    amount: string;
    tokenSymbol: string;
    valueUsd: string;
  } | null;
  interactWith: { address: string } | null;
  healthFactor: { before: string; after: string } | null;
  warnings: Array<{ code: string; level: string; message: string }>;
};

export type DefiBuildResult = {
  protocolId: string;
  investmentId: string;
  dataList: UnsignedDefiCall[];
  preview: DefiPreview;
};

export type DefiRedeemBuildResult = DefiBuildResult & {
  redeemDelayDays: [string, string] | [];
};

function makeHeaders(method: string, path: string, body = "") {
  return makeBinanceAuthHeaders(method, path, body);
}

async function get(path: string, params: Record<string, string> = {}, noStore = false): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;
  const headers = {
    ...makeHeaders("GET", fullPath),
    ...(noStore ? { "Cache-Control": "no-store" } : {}),
  };
  await rateLimit();
  const res = await fetch(`${BASE_URL}${fullPath}`, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ...(noStore ? { cache: "no-store" as const } : { next: { revalidate: 60 } }),
  });
  return readBinanceResponse(res);
}

async function post(path: string, payload: unknown): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const headers = {
    ...makeHeaders("POST", path, body),
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  await rateLimit();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    cache: "no-store",
  });
  return readBinanceResponse(res);
}

async function readBinanceResponse(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BinanceApiError("Binance Web3 API returned invalid JSON.", null, response.status);
  }
  if (!isRecord(body)) {
    throw new BinanceApiError("Binance Web3 API returned an invalid response envelope.", null, response.status);
  }
  const code = typeof body.code === "number" && Number.isInteger(body.code) ? body.code : null;
  if (!response.ok || (code !== null && code !== 0) ||
    (code === null && body.success !== true)) {
    const message = typeof body.msg === "string" && body.msg.length <= 1_000
      ? body.msg
      : response.statusText || "Request failed";
    throw new BinanceApiError(
      `API error ${code ?? response.status}: ${message}`,
      code,
      response.status,
    );
  }
  return body;
}

export async function simulateBscTransaction(
  from: string,
  to: string,
  data: string,
  value: string
) {
  return post("/api/v1/dex/pre-transaction/simulate", {
    binanceChainId: "56",
    evmTx: { from, to, value, data },
  });
}

export async function broadcastBscTransaction(address: string, signedTransaction: string) {
  return post("/api/v1/dex/pre-transaction/broadcast-transaction", {
    binanceChainId: "56",
    address,
    signedTransaction,
  });
}

export async function getTransactionDetailByTxHash(binanceChainId: string, txHash: string) {
  return get("/api/v1/dex/post-transaction/transaction-detail-by-txhash", {
    binanceChainId,
    txHash,
  }, true);
}

// Read-only wallet holdings, paginated by chain. The documented endpoint
// returns one chain entry containing tokenAssets for each requested chain.
export async function getAllTokenBalancesByAddress(
  address: string,
  chains = "56",
  pageSize = "100"
) {
  return get("/api/v1/dex/balance/all-token-balances-by-address", {
    address,
    chains,
    excludeRiskToken: "true",
    page: "1",
    pageSize,
  }, true);
}

// Read-only address portfolio statistics. Per the Binance schema, timeFrame
// 2 means 7D for this endpoint (it is not shared with leaderboard semantics).
export async function getPortfolioOverview(address: string, timeFrame = "2") {
  return get("/api/v1/dex/market/portfolio/overview", {
    binanceChainId: "56",
    walletAddress: address,
    timeFrame,
  }, true);
}

// RWA — list all tokenized stocks
// Optional filters per Binance RWA Data docs: platformId (ondo | bstock) and tabId (sector tab, integer).
// With no arguments the request is unchanged (complete list).
const getCachedRWATokenList = unstable_cache(
  async (platform: string | null, tabId: number | null) => {
    const params: Record<string, string> = {};
    if (platform) params.platformId = platform;
    if (tabId != null) params.tabId = String(tabId);
    return get("/api/v1/dex/market/rwa/tokens", params, true);
  },
  ["binance-rwa-token-list"],
  { revalidate: 60 }
);

export function getRWATokenList(platform?: string, tabId?: number) {
  return getCachedRWATokenList(platform ?? null, tabId ?? null).then((response: unknown) => {
    const allowEmpty = platform != null || tabId != null;
    if (!isRwaAssetListResponse(response, { allowEmpty })) {
      throw new Error("RWA token-list response had an unexpected shape");
    }
    return response;
  });
}

// RWA — price for specific tokens
export async function getRWAPrice(contractAddresses: string[], chainId = "56") {
  return get("/api/v1/dex/market/rwa/price", {
    binanceChainId: chainId,
    tokenContractAddresses: contractAddresses.join(","),
  });
}

// RWA — search by keyword
export async function searchRWA(keyword: string) {
  return get("/api/v1/dex/market/rwa/search", { keyword });
}

// RWA — underlying company info
export async function getRWAProfile(contractAddress: string, chainId = "56") {
  return get("/api/v1/dex/market/rwa/underlying-profile", {
    binanceChainId: chainId,
    tokenContractAddress: contractAddress,
  });
}

// RWA — underlying market data (real stock price, P/E, 52w range)
export async function getRWAMarketData(contractAddress: string, chainId = "56") {
  return get("/api/v1/dex/market/rwa/underlying-market", {
    binanceChainId: chainId,
    tokenContractAddress: contractAddress,
  });
}

// RWA — issuance platforms (Ondo etc.)
const getCachedRWAPlatforms = unstable_cache(
  () => get("/api/v1/dex/market/rwa/platforms", {}, true),
  ["binance-rwa-platforms"],
  { revalidate: 3600 }
);

export function getRWAPlatforms() {
  return getCachedRWAPlatforms();
}

// Candlestick chart data
export async function getCandles(
  contractAddress: string,
  chainId = "56",
  bar = "1h",
  limit = "48"
) {
  return get("/api/v1/dex/market/candles", {
    binanceChainId: chainId,
    tokenContractAddress: contractAddress,
    bar,
    limit,
  });
}

// Aggregated quote (read-only): price to buy `toToken` with USDT on BSC
export async function getRWAQuote(
  toToken: string,
  amount = "100000000000000000000",
  wallet = "0x000000000000000000000000000000000000dEaD"
) {
  return get("/api/v1/dex/aggregator/quote", {
    binanceChainId: "56",
    fromTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    toTokenAddress: toToken,
    amount,
    userWalletAddress: wallet,
  }, true);
}

// ===== VERIFIED RWA TRADING ENDPOINTS (Phase 2) =====

// Aggregated quote (trading): price to buy `toToken` with USDT on BSC
// Requires userWalletAddress for RWA/RFQ quotes
export async function getAggregatorQuote(
  toToken: string,
  amount: string,
  userWalletAddress: string
) {
  return get("/api/v1/dex/aggregator/quote", {
    binanceChainId: "56",
    fromTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    toTokenAddress: toToken,
    amount,
    userWalletAddress, // Required for RWA/RFQ
  }, true);
}

// Get swap details for a quote
// WOLV referral fee: 0.10% of input USDT credited to the operator wallet on every swap
const WOLV_REFERRER = process.env.NEXT_PUBLIC_WOLV_REFERRER ?? "";
const WOLV_FEE_PERCENT = "0.10";

export async function getAggregatorSwap(
  toToken: string,
  amount: string,
  userWalletAddress: string,
  quoteId: string,
  slippagePercent: string = "0.5"
) {
  const params: Record<string, string> = {
    binanceChainId: "56",
    fromTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    toTokenAddress: toToken,
    amount,
    userWalletAddress,
    quoteId,
    slippagePercent,
  };
  if (WOLV_REFERRER) {
    params.feePercent = WOLV_FEE_PERCENT;
    params.fromTokenReferrerWalletAddress = WOLV_REFERRER;
  }
  return get("/api/v1/dex/aggregator/swap", params, true);
}

// Get approval transaction calldata
export async function getApproveTransaction(
  tokenContractAddress: string,
  approveAmount: string,
  userWalletAddress: string,
  vendor?: string // Optional vendor parameter for RFQ routes
) {
  const params: Record<string, string> = {
    binanceChainId: "56",
    tokenContractAddress,
    approveAmount,
  };

  if (vendor) {
    params.vendor = vendor;
  }

  return get("/api/v1/dex/aggregator/approve-transaction", params, true);
}

// Submit a signed order
export async function submitOrder(
  requestId: string, // UUID v4 idempotency key
  userSignature: string, // EIP-712 signature of rfq.typedDataToSign
  vendor: string, // Must match rfq.vendor from swap response
  quoteId: string // rfq.orderId from /swap response
) {
  return post("/api/v1/dex/aggregator/order/submit", {
    requestId,
    userSignature,
    vendor,
    quoteId,
  });
}

// Get order status by orderId
export async function getOrderStatus(orderId: string) {
  return get(`/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`, {}, true);
}

export async function buildQuoteAndSwapTransaction(
  binanceChainId: string,
  amount: string,
  fromTokenAddress: string,
  toTokenAddress: string,
  userWalletAddress: string,
  vendor: string,
): Promise<QuoteAndSwapTransaction> {
  if (!/^\d{1,8}$/.test(binanceChainId) ||
    !isPositiveIntegerString(amount) ||
    !isEvmAddress(fromTokenAddress) ||
    !isEvmAddress(toTokenAddress) ||
    fromTokenAddress.toLowerCase() === toTokenAddress.toLowerCase() ||
    !isEvmAddress(userWalletAddress)) {
    throw new TypeError("Flash swap parameters are invalid.");
  }
  if (vendor !== "LiquidMesh") {
    throw new TypeError("The quote-and-swap Flash API currently supports only the LiquidMesh vendor.");
  }

  const response = await get("/api/v1/dex/aggregator/quote-and-swap", {
    binanceChainId,
    amount,
    fromTokenAddress,
    toTokenAddress,
    userWalletAddress,
    vendor,
  }, true);
  const data = requireBusinessData(response, "quote-and-swap");
  if (data.executionMode !== "SWAP") {
    throw new Error("Binance quote-and-swap returned an unsupported execution mode.");
  }
  const tx = parseUnsignedSwapTransaction(data.tx, userWalletAddress);
  const fromTokenAmount = parseUnsignedInteger(data.fromTokenAmount, "fromTokenAmount");
  const toTokenAmount = parseUnsignedInteger(data.toTokenAmount, "toTokenAmount");
  const minimumReceivedAmount = data.minReceiveAmount === undefined && data.minimumReceivedAmount === undefined
    ? null
    : parseUnsignedInteger(data.minReceiveAmount ?? data.minimumReceivedAmount, "minimum received amount");

  return {
    executionMode: "SWAP",
    tx,
    expectedOutputs: { fromTokenAmount, toTokenAmount, minimumReceivedAmount },
  };
}

export async function buildDeFiDepositTransaction(
  protocolId: string,
  investmentId: string,
  amount: string,
  userWalletAddress: string,
): Promise<DefiBuildResult> {
  validateDefiBuildInput(protocolId, investmentId, amount, userWalletAddress);
  const response = await post("/api/v1/defi/transaction/deposit", {
    address: userWalletAddress,
    investmentId,
    token: { tokenAddress: BSC_USDT_ADDRESS, amount },
    simulate: true,
  });
  const data = requireBusinessData(response, "DeFi deposit");
  const preview = parseDefiPreview(data.preview);
  if (!preview.success) throw new Error("Binance DeFi deposit simulation did not succeed; unsigned calls were withheld.");
  return {
    protocolId,
    investmentId,
    dataList: parseDefiCallDataList(data.dataList, "DEPOSIT", userWalletAddress),
    preview,
  };
}

export async function buildDeFiRedeemTransaction(
  protocolId: string,
  investmentId: string,
  amount: string,
  userWalletAddress: string,
): Promise<DefiRedeemBuildResult> {
  validateDefiBuildInput(protocolId, investmentId, amount, userWalletAddress);
  const response = await post("/api/v1/defi/transaction/redeem", {
    address: userWalletAddress,
    investmentId,
    token: { tokenAddress: BSC_USDT_ADDRESS, amount },
    simulate: true,
  });
  const data = requireBusinessData(response, "DeFi redeem");
  const preview = parseDefiPreview(data.preview);
  if (!preview.success) throw new Error("Binance DeFi redeem simulation did not succeed; unsigned calls were withheld.");
  const redeemDelayDays = parseRedeemDelayDays(data.redeemDelayDays);
  return {
    protocolId,
    investmentId,
    dataList: parseDefiCallDataList(data.dataList, "REDEEM", userWalletAddress),
    preview,
    redeemDelayDays,
  };
}

function validateDefiBuildInput(
  protocolId: string,
  investmentId: string,
  amount: string,
  userWalletAddress: string,
): void {
  if (typeof protocolId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(protocolId) ||
    typeof investmentId !== "string" || !/^[a-fA-F0-9]{64}$/.test(investmentId) ||
    !isValidUsdtAmount(amount) ||
    !isEvmAddress(userWalletAddress)) {
    throw new TypeError("DeFi transaction parameters are invalid.");
  }
}

function requireBusinessData(response: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(response) || response.code !== 0) {
    const code = isRecord(response) ? response.code : undefined;
    const message = isRecord(response) && typeof response.msg === "string" ? response.msg : "Invalid response envelope";
    throw new Error(`Binance ${operation} failed with business code ${String(code)}: ${message}`);
  }
  if (!isRecord(response.data)) {
    throw new Error(`Binance ${operation} response is missing its data object.`);
  }
  return response.data;
}

function parseUnsignedSwapTransaction(value: unknown, expectedFrom: string): UnsignedEvmTransaction {
  if (!isRecord(value) ||
    !isEvmAddress(value.from) || value.from.toLowerCase() !== expectedFrom.toLowerCase() ||
    !isEvmAddress(value.to) || typeof value.data !== "string" ||
    !/^0x[a-fA-F0-9]{8,}$/.test(value.data) || value.data.length % 2 !== 0 ||
    typeof value.value !== "string" || !isUnsignedNumber(value.value, true) ||
    !isUnsignedNumber(value.gas, false) ||
    !(value.gasPrice === null || isUnsignedNumber(value.gasPrice, false))) {
    throw new Error("Binance quote-and-swap returned a malformed EVM transaction.");
  }
  return {
    from: value.from,
    to: value.to,
    data: value.data,
    value: value.value,
    gas: value.gas,
    gasPrice: value.gasPrice,
  };
}

function parseDefiCallDataList(value: unknown, action: "DEPOSIT" | "REDEEM", expectedFrom: string): UnsignedDefiCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new Error("Binance DeFi response contains an invalid dataList.");
  }
  const calls = value.map((item) => parseDefiCall(item, expectedFrom));
  const expectedTypes = calls.length === 1 ? [action] : ["APPROVE", action];
  if (!calls.every((call, index) => call.callDataType === expectedTypes[index])) {
    throw new Error(`Binance DeFi ${action.toLowerCase()} dataList is not in the required approval/action order.`);
  }
  return calls;
}

function parseDefiCall(value: unknown, expectedFrom: string): UnsignedDefiCall {
  if (!isRecord(value) ||
    !["APPROVE", "DEPOSIT", "REDEEM"].includes(String(value.callDataType)) ||
    !isEvmAddress(value.from) || value.from.toLowerCase() !== expectedFrom.toLowerCase() ||
    !isEvmAddress(value.to) || typeof value.data !== "string" ||
    !/^0x[a-fA-F0-9]{8,}$/.test(value.data) || value.data.length % 2 !== 0 ||
    typeof value.value !== "string" || !isUnsignedNumber(value.value, true) ||
    !isUnsignedNumber(value.gasLimit, false) ||
    !(value.gasPrice === null || isUnsignedNumber(value.gasPrice, false)) ||
    !isOptionalUnsignedNumber(value.maxPriorityFeePerGas) ||
    !isOptionalUnsignedNumber(value.maxFeePerGas)) {
    throw new Error("Binance DeFi response contains malformed unsigned transaction data.");
  }
  return {
    callDataType: value.callDataType as UnsignedDefiCall["callDataType"],
    from: value.from,
    to: value.to,
    data: value.data,
    value: value.value,
    gasLimit: value.gasLimit,
    gasPrice: value.gasPrice,
    ...(value.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: value.maxPriorityFeePerGas }),
    ...(value.maxFeePerGas === undefined ? {} : { maxFeePerGas: value.maxFeePerGas }),
  };
}

function parseDefiPreview(value: unknown): DefiPreview {
  if (!isRecord(value) || typeof value.success !== "boolean" ||
    !Array.isArray(value.balanceChange) || !Array.isArray(value.warnings)) {
    throw new Error("Binance DeFi response is missing a valid simulated preview.");
  }
  const balanceChange = value.balanceChange.map((item) => {
    if (!isRecord(item) || typeof item.tokenSymbol !== "string" ||
      !isEvmAddress(item.tokenAddress) || typeof item.amount !== "string" ||
      !DECIMAL_AMOUNT_PATTERN.test(item.amount.replace(/^-/, "")) ||
      typeof item.valueUsd !== "string" || !DECIMAL_AMOUNT_PATTERN.test(item.valueUsd)) {
      throw new Error("Binance DeFi preview contains malformed balance changes.");
    }
    return {
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      amount: item.amount,
      valueUsd: item.valueUsd,
    };
  });
  const feeAndContract = value.feeAndContract;
  const estimatedNetworkFee = isRecord(feeAndContract) && isRecord(feeAndContract.estimatedNetworkFee)
    ? parseEstimatedNetworkFee(feeAndContract.estimatedNetworkFee)
    : null;
  const interactWith = isRecord(feeAndContract) && isRecord(feeAndContract.interactWith)
    ? parseInteractWith(feeAndContract.interactWith)
    : null;
  const healthFactor = value.healthFactor === null
    ? null
    : parseHealthFactor(value.healthFactor);
  const warnings = value.warnings.map(parsePreviewWarning);
  return { success: value.success, balanceChange, estimatedNetworkFee, interactWith, healthFactor, warnings };
}

function parseEstimatedNetworkFee(value: Record<string, unknown>): NonNullable<DefiPreview["estimatedNetworkFee"]> {
  if (typeof value.amount !== "string" || !DECIMAL_AMOUNT_PATTERN.test(value.amount) ||
    typeof value.tokenSymbol !== "string" || typeof value.valueUsd !== "string" ||
    !DECIMAL_AMOUNT_PATTERN.test(value.valueUsd)) {
    throw new Error("Binance DeFi preview contains malformed estimated network fees.");
  }
  return { amount: value.amount, tokenSymbol: value.tokenSymbol, valueUsd: value.valueUsd };
}

function parseInteractWith(value: Record<string, unknown>): { address: string } {
  if (!isEvmAddress(value.address)) throw new Error("Binance DeFi preview contains an invalid contract address.");
  return { address: value.address };
}

function parseHealthFactor(value: unknown): { before: string; after: string } | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.before !== "string" || typeof value.after !== "string" ||
    !DECIMAL_AMOUNT_PATTERN.test(value.before) || !DECIMAL_AMOUNT_PATTERN.test(value.after)) {
    throw new Error("Binance DeFi preview contains malformed health-factor data.");
  }
  return { before: value.before, after: value.after };
}

function parsePreviewWarning(value: unknown): DefiPreview["warnings"][number] {
  if (!isRecord(value) || typeof value.code !== "string" ||
    value.code.length > 128 || typeof value.level !== "string" || value.level.length > 32 ||
    typeof value.message !== "string" || value.message.length > 1_000) {
    throw new Error("Binance DeFi preview contains a malformed warning.");
  }
  return { code: value.code, level: value.level, message: value.message };
}

function parseRedeemDelayDays(value: unknown): [string, string] | [] {
  if (!Array.isArray(value) || (value.length !== 0 && value.length !== 2) ||
    !value.every((day) => typeof day === "string" && /^\d{1,4}$/.test(day))) {
    throw new Error("Binance DeFi redeem response contains invalid redeemDelayDays.");
  }
  return value.length === 0 ? [] : [value[0] as string, value[1] as string];
}

function parseUnsignedInteger(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL_INTEGER_PATTERN.test(value) ||
    BigInt(value) <= BigInt(0) || BigInt(value) > UINT256_MAX) {
    throw new Error(`Binance response contains an invalid ${field}.`);
  }
  return value;
}

function isPositiveIntegerString(value: string): boolean {
  if (typeof value !== "string" || !DECIMAL_INTEGER_PATTERN.test(value)) return false;
  const amount = BigInt(value);
  return amount > BigInt(0) && amount <= UINT256_MAX;
}

function isValidUsdtAmount(value: string): boolean {
  if (typeof value !== "string" || !DECIMAL_AMOUNT_PATTERN.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 18) return false;
  const baseUnits = BigInt(`${whole}${fraction.padEnd(18, "0")}`);
  return baseUnits > BigInt(0) && baseUnits <= UINT256_MAX;
}

function isUnsignedNumber(value: unknown, allowHex: boolean): value is string {
  return typeof value === "string" &&
    (DECIMAL_INTEGER_PATTERN.test(value) || (allowHex && /^0x[0-9a-fA-F]+$/.test(value)));
}

function isOptionalUnsignedNumber(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isUnsignedNumber(value, false);
}

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
