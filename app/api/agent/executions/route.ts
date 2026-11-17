import { authorizeBawWalletRequest, getBawWalletSession } from "@/services/bawWalletAuth";
import { AgentMemoryStore } from "@/services/agentMemoryStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

/** Autonomous execution history (claims + verified on-chain evidence) for the signed-in owner only. */
export async function GET(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const auth = await authorizeBawWalletRequest(request, token);
  if (auth === "not_configured") return Response.json({ error: "Operator wallet access is not configured." }, { status: 503, headers: HEADERS });
  if (auth !== "authorized") return Response.json({ error: "A valid operator authorization is required." }, { status: 401, headers: HEADERS });
  const session = await getBawWalletSession(request, token);
  if (!session) return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  const requested = Number(new URL(request.url).searchParams.get("limit") ?? 25);
  const limit = Number.isFinite(requested) ? requested : 25;
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const executions = await store.listExecutionHistory(session.address, limit);
    return Response.json({ executions }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "Execution history is unavailable." }, { status: 503, headers: HEADERS });
  } finally {
    await store.close();
  }
}
