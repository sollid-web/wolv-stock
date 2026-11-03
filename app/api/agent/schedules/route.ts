import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { authorizeBawWalletRequest, getBawWalletSession } from "@/services/bawWalletAuth";
import { AgentMemoryStore } from "@/services/agentMemoryStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const auth = await authorizeBawWalletRequest(request, token);
  if (auth !== "authorized") return authError(auth);
  const session = await getBawWalletSession(request, token);
  if (!session) return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    return Response.json({ schedules: await store.listSchedules(session.address) }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "Schedule storage is unavailable." }, { status: 503, headers: HEADERS });
  } finally { await store.close(); }
}

export async function POST(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const auth = await authorizeBawWalletRequest(request, token);
  if (auth !== "authorized") return authError(auth);
  const session = await getBawWalletSession(request, token);
  if (!session) return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: HEADERS }); }
  if (!body || typeof body !== "object") return Response.json({ error: "Schedule request must be an object." }, { status: 422, headers: HEADERS });
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || typeof value.name !== "string" ||
    typeof value.intervalSeconds !== "number" || typeof value.policyVersion !== "string" ||
    typeof value.policy !== "object" || value.policy === null) {
    return Response.json({ error: "Schedule request is invalid." }, { status: 422, headers: HEADERS });
  }
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(value.name) || !Number.isSafeInteger(value.intervalSeconds) ||
    value.intervalSeconds < 60 || value.intervalSeconds > 86400) {
    return Response.json({ error: "Schedule name or interval is invalid." }, { status: 422, headers: HEADERS });
  }
  const policyHash = createHash("sha256").update(JSON.stringify(value.policy)).digest("hex");
  const now = Date.now();
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const result = await store.saveSchedule({
      ownerAddress: session.address,
      scheduleId: randomUUID(),
      name: value.name,
      intervalSeconds: value.intervalSeconds,
      policyVersion: value.policyVersion.slice(0, 64),
      policyHash,
      nextRunAt: now + Number(value.intervalSeconds) * 1000,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ scheduleId: result.scheduleId, execution: "BLOCKED", policyHash }, { status: 201, headers: HEADERS });
  } catch {
    return Response.json({ error: "Schedule could not be persisted." }, { status: 503, headers: HEADERS });
  } finally { await store.close(); }
}

function authError(status: string) {
  if (status === "not_configured") return Response.json({ error: "Operator wallet access is not configured." }, { status: 503, headers: HEADERS });
  return Response.json({ error: "A valid operator authorization is required." }, { status: 401, headers: HEADERS });
}
