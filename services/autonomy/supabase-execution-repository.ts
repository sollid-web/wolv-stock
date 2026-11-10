import type { ExecutionIntent } from "./execution-domain";

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and service-role key are required for execution persistence.");
  return { url, key };
}

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Execution persistence failed (${response.status}): ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function createExecutionIntentIfAbsent(intent: ExecutionIntent) {
  await request("wolv_execution_intents?on_conflict=owner_id,idempotency_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      id: intent.id, owner_id: intent.ownerId, idempotency_key: intent.idempotencyKey,
      state: intent.state, version: intent.version, intent,
      created_at: intent.createdAt, updated_at: intent.updatedAt,
    }),
  });
  const query = new URLSearchParams({
    select: "intent",
    owner_id: `eq.${intent.ownerId}`,
    idempotency_key: `eq.${intent.idempotencyKey}`,
    limit: "1",
  });
  const rows = await request(`wolv_execution_intents?${query}`) as Array<{ intent: ExecutionIntent }>;
  if (!rows[0]?.intent) throw new Error("Created execution intent could not be read back.");
  return { created: rows[0].intent.id === intent.id, intent: rows[0].intent };
}

export async function compareAndSwapExecutionIntent(next: ExecutionIntent, expectedVersion: number) {
  const result = await request("rpc/wolv_execution_intent_cas", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: next.ownerId, p_intent_id: next.id,
      p_expected_version: expectedVersion, p_intent: next,
    }),
  });
  return result === true;
}

export async function acquireExecutionLease(ownerId: string, intentId: string, leaseMs = 30_000): Promise<string | null> {
  const result = await request("rpc/wolv_acquire_execution_lease", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_intent_id: intentId, p_lease_ms: leaseMs }),
  });
  return typeof result === "string" ? result : null;
}

export async function releaseExecutionLease(ownerId: string, intentId: string, leaseToken: string) {
  await request("rpc/wolv_release_execution_lease", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_intent_id: intentId, p_lease_token: leaseToken }),
  });
}
