import { randomUUID } from "node:crypto";
import { evaluateMockTrigger, parseAgentStrategy } from "../../../../lib/agentStrategies.ts";
import { buildCapabilityTelemetry } from "../../../../lib/agentTelemetry.ts";
import { handleBawExecutionAction } from "../../../../services/bawExecutionHttp.ts"

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 8_192;
const responseHeaders = { "Cache-Control": "no-store" };

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(error: string, code: number) {
  return Response.json({ error, code }, { status: code, headers: responseHeaders });
}

async function readBoundedJson(request: Request): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return { ok: false, status: 400, error: "Content-Length must be a non-negative integer." };
    }
    if (Number(contentLength) > MAX_REQUEST_BYTES) {
      return { ok: false, status: 413, error: "Request body exceeds the 8 KB limit." };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, status: 400, error: "Request body must contain valid JSON." };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "Request body exceeds the 8 KB limit." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "Request body could not be read." };
  } finally {
    reader.releaseLock();
  }

  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid UTF-8 JSON." };
  }
}

export async function GET() {
  return Response.json(buildCapabilityTelemetry(), { headers: responseHeaders });
}

export async function POST(request: Request) {
  const parsedBody = await readBoundedJson(request);
  if (!parsedBody.ok) return errorResponse(parsedBody.error, parsedBody.status);
  const body = parsedBody.value;

  if (!isRecord(body)) {
    return errorResponse("Request body must be a JSON object.", 400);
  }

  if (body.action === "executeBaw") {
    const { resolveBawSpotAsset } = await import("../../../../services/bawAsset.ts")
    return handleBawExecutionAction(request, body, {
      configuredToken: process.env.BAW_WALLET_API_TOKEN,
      resolveAsset: resolveBawSpotAsset,
    })
  }

  const action = body.action ?? "preview";
  if (action !== "preview" && action !== "simulate") {
    return errorResponse("Action must be preview or simulate.", 422);
  }

  const strategyInput = body.strategy ?? body.naturalLanguage ?? body.request ??
    (body.ticker !== undefined || body.targetTicker !== undefined ? body : undefined);
  const parsed = parseAgentStrategy(strategyInput);
  if (!parsed.ok) {
    return errorResponse(parsed.error, 422);
  }

  const result: Record<string, unknown> = {
    requestId: randomUUID(),
    status: action === "simulate" ? "mock-evaluated" : "local-draft",
    strategy: parsed.strategy,
    execution: {
      mode: "wallet-confirmation",
      transactionBroadcast: false,
      automatedExecution: false,
    },
  };

  if (action === "simulate") {
    const evaluation = evaluateMockTrigger(parsed.strategy, body.referencePrice, body.currentPrice);
    if (!evaluation.ok) {
      return errorResponse(evaluation.error, 422);
    }
    result.mockTrigger = evaluation;
  }

  return Response.json(result, { headers: responseHeaders });
}
