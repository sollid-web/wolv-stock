import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAgentSessionPlan } from "@/lib/agentSessionPlan";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import {
  authorizeBawWalletRequest,
  getBawWalletSession,
} from "@/services/bawWalletAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4_096;

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeBawWalletRequest(
    request,
    process.env.BAW_WALLET_API_TOKEN,
  );
  const denied = authorizationError(authorization);
  if (denied) return denied;
  return withOwnerStore(request, async (store, ownerAddress) => {
    return NextResponse.json(
      { plans: await store.listAgentSessionPlans(ownerAddress, 20) },
      { headers },
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeBawWalletRequest(
    request,
    process.env.BAW_WALLET_API_TOKEN,
  );
  const denied = authorizationError(authorization);
  if (denied) return denied;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("Content-Type must be application/json.", 400);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return errorResponse("Session-plan request exceeds the 4 KB limit.", Number(contentLength) > MAX_BODY_BYTES ? 413 : 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Session-plan request must contain valid JSON.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("Session-plan request must be an object.", 422);
  }
  const record = body as Record<string, unknown>;
  return withOwnerStore(request, async (store, ownerAddress) => {
    if (!Object.hasOwn(record, "action") || typeof record.action !== "string") {
      return errorResponse("Session-plan request is invalid.", 422);
    }
    const action = record.action;
    if (action === "REVOKE") {
      if (
        Object.keys(record).length !== 3 ||
        !Object.hasOwn(record, "sessionId") ||
        !Object.hasOwn(record, "reason") ||
        typeof record.sessionId !== "string" ||
        typeof record.reason !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.sessionId) ||
        !record.reason.trim() ||
        record.reason.trim().length > 500
      ) {
        return errorResponse("Session-plan revoke request is invalid.", 422);
      }
      try {
        const result = await store.revokeAgentSessionPlan(
          record.sessionId,
          ownerAddress,
          Date.now(),
          record.reason.trim(),
        );
        return NextResponse.json({
          plan: result,
          execution: "BLOCKED",
          transactionSubmitted: false,
        }, { headers });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Session plan could not be revoked.";
        if (message.includes("NOT_FOUND")) return errorResponse("Session plan was not found.", 404);
        throw error;
      }
    }
    if (action !== "PREPARE") {
      return errorResponse("Session-plan action is invalid.", 422);
    }
    if (Object.keys(record).length !== 1) {
      return errorResponse("Session-plan preparation request is invalid.", 422);
    }
    const now = Date.now();
    const control = await store.getControlState(now);
    if (Boolean(control.emergency_stop)) {
      return errorResponse("Global emergency stop prevents session-plan preparation.", 423);
    }
    const plan = createAgentSessionPlan({ ownerAddress });
    const result = await store.prepareAgentSessionPlan({
      ownerAddress,
      sessionId: randomUUID(),
      plan: plan as unknown as Record<string, unknown>,
      createdAt: now,
    });
    return NextResponse.json({
      ...result,
      plan,
      execution: "BLOCKED",
      transactionSubmitted: false,
    }, { status: result.created ? 201 : 200, headers });
  });
}

function authorizationError(
  authorization: "authorized" | "unauthorized" | "not_configured" | "storage_unavailable",
): Response | null {
  if (authorization === "authorized") return null;
  if (authorization === "not_configured") return errorResponse("Agent session access is not configured.", 503);
  if (authorization === "storage_unavailable") return errorResponse("Operator authorization storage is unavailable.", 503);
  return errorResponse("A valid operator authorization is required.", 401);
}

async function withOwnerStore(
  request: Request,
  operation: (store: AgentMemoryStore, ownerAddress: string) => Promise<Response>,
): Promise<Response> {
  let session;
  try {
    session = await getBawWalletSession(
      request,
      process.env.BAW_WALLET_API_TOKEN,
    );
  } catch {
    return errorResponse("Browser-wallet authorization storage is unavailable.", 503);
  }
  if (!session?.address) return errorResponse("A valid operator authorization is required.", 401);
  if (!process.env.WOLV_AGENT_DATABASE_URL && !process.env.WOLV_TRADING_DATABASE_URL) {
    return errorResponse("Agent session-plan storage is not configured.", 503);
  }
  let store: AgentMemoryStore | null = null;
  try {
    store = new AgentMemoryStore();
    await store.initialize();
    return await operation(store, session.address.toLowerCase());
  } catch (error) {
    console.error("Agent session-plan operation failed:", error);
    return errorResponse("Agent session-plan storage operation failed.", 500);
  } finally {
    await store?.close();
  }
}

function errorResponse(message: string, status: number): Response {
  return NextResponse.json(
    { status: "REJECTED", error: message, execution: "BLOCKED" },
    { status, headers },
  );
}
