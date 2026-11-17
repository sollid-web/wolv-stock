import { AgentMemoryStore } from "@/services/agentMemoryStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };
const MAX_HEARTBEAT_AGE_MS = 60_000;

/**
 * Public liveness probe for uptime monitors: 200 while a worker heartbeat for the configured
 * chain is newer than 60 s, 503 otherwise. Exposes no owner, account, or configuration data.
 */
export async function GET() {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.CHAIN_ID);
  if (chainId !== 56 && chainId !== 97) {
    return Response.json({ status: "unconfigured" }, { status: 503, headers: HEADERS });
  }
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const heartbeat = await store.getLatestWorkerHeartbeat(Date.now(), MAX_HEARTBEAT_AGE_MS, chainId);
    return heartbeat
      ? Response.json({ status: "ok", chainId }, { headers: HEADERS })
      : Response.json({ status: "worker_heartbeat_stale", chainId }, { status: 503, headers: HEADERS });
  } catch {
    return Response.json({ status: "storage_unavailable" }, { status: 503, headers: HEADERS });
  } finally {
    await store.close();
  }
}
