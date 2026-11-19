import { deriveAgentPublicStatus } from "@/lib/agentPublicStatus";
import { AgentMemoryStore } from "@/services/agentMemoryStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "public, max-age=5, s-maxage=5, stale-while-revalidate=10" };

/**
 * Public, read-only autonomous agent status derived from persisted records (heartbeats, control,
 * schedules, execution claims, alerts). Contains no owner or account addresses and no secrets.
 */
export async function GET() {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.CHAIN_ID);
  if (chainId !== 56 && chainId !== 97) {
    return Response.json({ error: "Agent network is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const snapshot = await store.getPublicAgentStatus(chainId);
    return Response.json({ chainId, ...deriveAgentPublicStatus(snapshot, Date.now()) }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "Agent status is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  } finally {
    await store.close();
  }
}
