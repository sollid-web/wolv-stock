import {
  BSC_USDT_ADDRESS,
  EVM_ADDRESS_PATTERN,
  usdtAmountToWei,
} from "@/lib/apiValidation";
import {
  buildQuoteAndSwapTransaction,
  BinanceApiError,
  getRWATokenList,
  simulateBscTransaction,
} from "@/lib/binance";
import { isSpotEligibleAsset } from "@/lib/compliance";
import { isRwaAssetListResponse, parseRwaAssetRecords } from "@/lib/rwaAssetResponse";
import {
  authorizeBawWalletRequest,
  getBawWalletSession,
} from "@/services/bawWalletAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4_096;
const LOCAL_QUOTE_TTL_MS = 15_000;

type SimulationEnvelope = {
  data?: {
    status?: unknown;
    failReason?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ error: message, ...extra }, { status, headers: HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeBawWalletRequest(
    request,
    process.env.BAW_WALLET_API_TOKEN,
  );
  if (authorization !== "authorized") {
    return errorResponse(
      authorization === "not_configured"
        ? "Wallet session access is not configured."
        : "A valid wallet session authorization is required.",
      authorization === "not_configured" ? 503 : 401,
    );
  }

  let session;
  try {
    session = await getBawWalletSession(request, process.env.BAW_WALLET_API_TOKEN);
  } catch {
    return errorResponse("Wallet session verification is temporarily unavailable.", 503);
  }
  if (!session) return errorResponse("A connected wallet session is required.", 401);

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("Content-Type must be application/json.", 400);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return errorResponse("Flash request exceeds the 4 KB limit.", 413);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return errorResponse("Flash request exceeds the 4 KB limit.", 413);
    }
    body = JSON.parse(text) as unknown;
  } catch {
    return errorResponse("Flash request must contain valid JSON.", 400);
  }
  if (!isRecord(body) ||
    Object.keys(body).length !== 5 ||
    !["walletAddress", "tokenContract", "chainId", "amount", "vendor"].every((key) => Object.hasOwn(body, key))) {
    return errorResponse("Flash request parameters are invalid.", 422);
  }

  const walletAddress = body.walletAddress;
  const tokenContract = body.tokenContract;
  const chainId = body.chainId;
  const amount = body.amount;
  const vendor = body.vendor;
  if (typeof walletAddress !== "string" || !EVM_ADDRESS_PATTERN.test(walletAddress) ||
    walletAddress.toLowerCase() !== session.address.toLowerCase()) {
    return errorResponse("The requested wallet must match the authenticated wallet session.", 403);
  }
  if (typeof tokenContract !== "string" || !EVM_ADDRESS_PATTERN.test(tokenContract) ||
    (chainId !== 56 && chainId !== "56") || vendor !== "LiquidMesh" || typeof amount !== "string") {
    return errorResponse("A valid BSC token, chainId 56, amount, and LiquidMesh vendor are required.", 422);
  }

  let amountBaseUnits: string;
  try {
    amountBaseUnits = usdtAmountToWei(amount);
  } catch {
    return errorResponse("Amount must be a positive USDT value with at most 18 decimal places.", 422);
  }

  try {
    const registryResponse: unknown = await getRWATokenList();
    if (!isRwaAssetListResponse(registryResponse)) {
      return errorResponse("The verified RWA registry is unavailable or malformed.", 503);
    }
    const target = parseRwaAssetRecords(registryResponse).find((asset) =>
      asset.tokenContractAddress.toLowerCase() === tokenContract.toLowerCase() &&
      isSpotEligibleAsset(asset),
    );
    if (!target) {
      return errorResponse("Target token is not in the verified spot-eligible RWA registry.", 422);
    }

    const transaction = await buildQuoteAndSwapTransaction(
      "56",
      amountBaseUnits,
      BSC_USDT_ADDRESS,
      target.tokenContractAddress,
      session.address,
      "LiquidMesh",
    );
    const issuedAt = Date.now();
    if (transaction.executionMode !== "SWAP") {
      return errorResponse(
        "This quote requires RFQ execution and cannot use the Flash swap builder.",
        409,
        { directive: "Use the authenticated RFQ quote/signature pipeline instead." },
      );
    }

    const simulation = await simulateBscTransaction(
      transaction.tx.from,
      transaction.tx.to,
      transaction.tx.data,
      transaction.tx.value,
    ) as SimulationEnvelope;
    const simulationStatus = typeof simulation.data?.status === "string"
      ? simulation.data.status.toUpperCase()
      : "";
    if (simulationStatus !== "SUCCESS") {
      const failReason = typeof simulation.data?.failReason === "string"
        ? simulation.data.failReason.slice(0, 500)
        : "Simulation did not return a successful status.";
      return errorResponse("Transaction simulation rejected the quote.", 422, {
        simulation: { status: simulationStatus || "INVALID", failReason },
      });
    }

    if (Date.now() - issuedAt > LOCAL_QUOTE_TTL_MS) {
      return errorResponse("The Flash quote expired during simulation; request a fresh quote.", 409);
    }
    return Response.json({
      transaction: transaction.tx,
      expectedOutputs: transaction.expectedOutputs,
      issuedAt,
      expiresAt: issuedAt + LOCAL_QUOTE_TTL_MS,
    }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof Error &&
      error.message === "Binance quote-and-swap returned an unsupported execution mode.") {
      return errorResponse(
        "This quote requires RFQ execution and cannot use the Flash swap builder.",
        409,
        { directive: "Use the authenticated RFQ quote/signature pipeline instead." },
      );
    }
    if (error instanceof BinanceApiError) {
      console.error("Flash transaction build failed:", error.message);
      return errorResponse("The Binance Flash quote could not be built.", error.httpStatus >= 400 && error.httpStatus < 500 ? 422 : 502);
    }
    console.error("Flash transaction build failed:", error);
    return errorResponse("Flash transaction building is temporarily unavailable.", 502);
  }
}
