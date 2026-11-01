import "server-only";
import { authorizeBawWalletRequest, getBawWalletSession } from "./bawWalletAuth.ts";
import { randomUUID } from "node:crypto";
import {
  AgentControlPlaneError,
  validateRiskPolicy,
  type RiskPolicy,
} from "../lib/agentControlPlane.ts";
import { AgentMemoryStore, AgentMemoryStoreError, type AgentMemoryStorePort } from "./agentMemoryStore.ts";
import { ConfiguredAgentAnalysisProvider } from "./agentAnalysis.ts";
import { AgentOrchestrator, type AgentRunRequest } from "./agentOrchestrator.ts";
import { MarketCollectorError, MarketDataCollector } from "./marketDataCollector.ts";

const HEADERS = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 8_192;
const MAX_PERMISSION_TTL_MS = 30 * 60_000;

export type AgentControlHttpDependencies = {
  authorize?: (request: Request) => Promise<"authorized" | "unauthorized" | "not_configured" | "storage_unavailable">;
  getOwnerAddress?: (request: Request) => Promise<string | null>;
  createStore?: () => AgentMemoryStorePort;
  createOrchestrator?: (store: AgentMemoryStorePort) => AgentOrchestrator;
  now?: () => number;
};

export async function handleAgentControlGet(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  const filters = parseActivityFilters(new URL(request.url).searchParams, authorization.ownerAddress);
  if (!filters.ok) return json({ error: filters.error }, 400);
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    const now = (dependencies.now ?? Date.now)();
    await store.expirePendingProposals(now, authorization.ownerAddress);
    await store.expireOpportunities(now, authorization.ownerAddress);
    const [control, activity, proposals, policyRefusals, observations, activePolicy, opportunities, analyses, evaluations] = await Promise.all([
      store.getControlState(now),
      store.listActivity(filters.value),
      store.listProposals(authorization.ownerAddress, 20),
      store.getPolicyRefusals(authorization.ownerAddress, 20),
      store.getRecentObservations({ ownerAddress: authorization.ownerAddress, limit: 20 }),
      store.getActivePolicy(authorization.ownerAddress, "default"),
      store.listOpportunities({ ownerAddress: authorization.ownerAddress, limit: 20 }),
      store.listAnalyses(authorization.ownerAddress, 20),
      store.getStrategyEvaluations({ ownerAddress: authorization.ownerAddress, limit: 20 }),
    ]);
    return json({
      control,
      activity: activity.items,
      nextCursor: activity.nextCursor,
      proposals,
      policyRefusals,
      observations,
      activePolicy,
      opportunities,
      analyses,
      strategyEvaluations: evaluations,
      execution: { enabled: false, status: "EXECUTION_BLOCKED" },
      configuration: {
        orchestrationEnabled: process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED === "true",
        collectorEnabled: process.env.WOLV_MARKET_COLLECTOR_ENABLED === "true",
        databaseConfigured: Boolean(process.env.WOLV_AGENT_DATABASE_URL ?? process.env.WOLV_TRADING_DATABASE_URL),
      },
    });
  } catch (error) {
    return storeErrorResponse(error, "Agent activity could not be loaded.");
  } finally {
    if (store) await store.close();
  }
}

export async function handleAgentControlPost(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "Request body must be an object." }, 422);

  const now = (dependencies.now ?? Date.now)();
  const body = parsed.value;
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    if (body.action === "STOP" && hasExactKeys(body, ["action", "reason"]) &&
      typeof body.reason === "string" && body.reason.trim().length > 0) {
      await store.setEmergencyStop({
        ownerAddress: authorization.ownerAddress,
        stopped: true,
        reason: body.reason.trim().slice(0, 500),
        permissionExpiresAt: null,
        updatedAt: now,
        correlationId: randomUUID(),
      });
    } else if (body.action === "ENABLE" && hasExactKeys(body, ["action", "reason", "permissionTtlMs"]) &&
      typeof body.reason === "string" && body.reason.trim().length > 0 &&
      Number.isSafeInteger(body.permissionTtlMs) &&
      Number(body.permissionTtlMs) >= 60_000 && Number(body.permissionTtlMs) <= MAX_PERMISSION_TTL_MS) {
      if (process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED !== "true") {
        return json({ error: "Agent orchestration is disabled by server configuration." }, 503);
      }
      await store.setEmergencyStop({
        ownerAddress: authorization.ownerAddress,
        stopped: false,
        reason: body.reason.trim().slice(0, 500),
        permissionExpiresAt: now + Number(body.permissionTtlMs),
        updatedAt: now,
        correlationId: randomUUID(),
      });
    } else {
      return json({ error: "Control request is invalid." }, 422);
    }
    return json({ control: await store.getControlState(now) });
  } catch (error) {
    return storeErrorResponse(error, "Agent control state could not be changed.");
  } finally {
    if (store) await store.close();
  }
}

export async function handleAgentProposalPost(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || !hasExactKeys(parsed.value, ["proposalId", "action"]) ||
    typeof parsed.value.proposalId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.value.proposalId) ||
    !["APPROVE", "REJECT", "REVOKE"].includes(String(parsed.value.action))) {
    return json({ error: "Proposal decision is invalid." }, 422);
  }
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    const result = await store.decideProposal(
      parsed.value.proposalId,
      authorization.ownerAddress,
      parsed.value.action as "APPROVE" | "REJECT" | "REVOKE",
      (dependencies.now ?? Date.now)(),
    );
    return json({ proposalId: parsed.value.proposalId, ...result, execution: "BLOCKED" });
  } catch (error) {
    return storeErrorResponse(error, "Proposal decision could not be recorded.");
  } finally {
    if (store) await store.close();
  }
}

export async function handleAgentPolicyGet(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  const name = new URL(request.url).searchParams.get("name") ?? "default";
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return json({ error: "Policy name is invalid." }, 400);
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    return json({ name, policy: await store.getActivePolicy(authorization.ownerAddress, name) });
  } catch (error) {
    return storeErrorResponse(error, "Active risk policy could not be loaded.");
  } finally {
    if (store) await store.close();
  }
}

export async function handleAgentPolicyPost(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || !hasExactKeys(parsed.value, ["name", "policy", "activate"]) ||
    typeof parsed.value.name !== "string" ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(parsed.value.name) ||
    typeof parsed.value.activate !== "boolean" ||
    !isRiskPolicy(parsed.value.policy)) {
    return json({ error: "Risk policy request is invalid." }, 422);
  }
  const errors = validateRiskPolicy(parsed.value.policy);
  const now = (dependencies.now ?? Date.now)();
  if (errors.length || parsed.value.policy.permissionExpiresAt <= now) {
    return json({ error: "Risk policy is invalid or its permission has expired.", reasons: errors }, 422);
  }
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    const policyId = await store.savePolicy(
      authorization.ownerAddress,
      parsed.value.name,
      parsed.value.policy,
      now,
      parsed.value.activate,
    );
    return json({ policyId, name: parsed.value.name, version: parsed.value.policy.version, active: parsed.value.activate }, 201);
  } catch (error) {
    if (error instanceof TypeError) return json({ error: error.message }, 422);
    return storeErrorResponse(error, "Risk policy could not be stored.");
  } finally {
    if (store) await store.close();
  }
}

export async function handleAgentRunPost(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  if (process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED !== "true" ||
    process.env.WOLV_MARKET_COLLECTOR_ENABLED !== "true") {
    return json({ error: "Agent orchestration and market collection must be explicitly enabled by the operator." }, 503);
  }
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isAgentRunRequest(parsed.value)) return json({ error: "Agent run request is invalid." }, 422);
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    const orchestrator = dependencies.createOrchestrator
      ? dependencies.createOrchestrator(store)
      : await createConfiguredOrchestrator(store);
    const result = await orchestrator.run({ ...parsed.value, ownerAddress: authorization.ownerAddress });
    return json(result, 200);
  } catch (error) {
    if (error instanceof AgentControlPlaneError) {
      const status = error.code === "INVALID_INPUT" ? 422
        : error.code === "EMERGENCY_STOP" ? 423
          : error.code === "UNAVAILABLE" ? 503 : 409;
      return json({ error: error.message, code: error.code }, status);
    }
    if (error instanceof MarketCollectorError) {
      return json({ error: error.message, code: error.code }, error.code === "DISABLED" ? 503 : 502);
    }
    return storeErrorResponse(error, "Agent run did not complete.");
  } finally {
    if (store) await store.close();
  }
}

export async function handleAgentRunGet(
  request: Request,
  dependencies: AgentControlHttpDependencies = {},
): Promise<Response> {
  const authorization = await authorize(request, dependencies);
  if (authorization.status !== "authorized") return authResponse(authorization.status);
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    return json({ error: "A valid runId is required." }, 400);
  }
  let store: AgentMemoryStorePort | undefined;
  try {
    store = createStore(dependencies);
    await store.initialize();
    const result = await store.reconstructRun(runId, authorization.ownerAddress);
    return result ? json(result) : json({ error: "Agent run was not found." }, 404);
  } catch (error) {
    return storeErrorResponse(error, "Agent run history could not be reconstructed.");
  } finally {
    if (store) await store.close();
  }
}

async function createConfiguredOrchestrator(store: AgentMemoryStorePort): Promise<AgentOrchestrator> {
  const { BinanceAgentMarketAdapter } = await import("./binanceAgentMarketAdapter.ts");
  const collector = new MarketDataCollector(store, new BinanceAgentMarketAdapter());
  return new AgentOrchestrator(store, collector, new ConfiguredAgentAnalysisProvider());
}

function createStore(dependencies: AgentControlHttpDependencies): AgentMemoryStorePort {
  return dependencies.createStore?.() ?? new AgentMemoryStore();
}

async function authorize(
  request: Request,
  dependencies: AgentControlHttpDependencies,
): Promise<{ status: "authorized"; ownerAddress: string } | { status: "unauthorized" | "not_configured" | "storage_unavailable" }> {
  const status = await (dependencies.authorize ?? ((incoming) =>
    authorizeBawWalletRequest(incoming, process.env.BAW_WALLET_API_TOKEN)))(request);
  if (status !== "authorized") return { status };
  try {
    const address = dependencies.getOwnerAddress
      ? await dependencies.getOwnerAddress(request)
      : (await getBawWalletSession(request, process.env.BAW_WALLET_API_TOKEN))?.address ?? null;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return { status: "unauthorized" };
    return { status: "authorized", ownerAddress: address.toLowerCase() };
  } catch (error) {
    console.error("Agent owner session could not be verified.", error instanceof Error ? error.name : "UnknownError");
    return { status: "storage_unavailable" };
  }
}

function authResponse(status: "authorized" | "unauthorized" | "not_configured" | "storage_unavailable"): Response {
  if (status === "not_configured") return json({ error: "Operator authorization is not configured." }, 503);
  if (status === "storage_unavailable") return json({ error: "Operator authorization storage is unavailable." }, 503);
  return json({ error: "A valid operator authorization is required." }, 401);
}

function parseActivityFilters(params: URLSearchParams, ownerAddress: string):
  | { ok: true; value: Parameters<AgentMemoryStorePort["listActivity"]>[0] }
  | { ok: false; error: string } {
  const fields = ["limit", "cursor", "agentId", "strategyId", "eventType", "runStatus", "assetId", "since", "until"];
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!fields.includes(key) || seen.has(key)) return { ok: false, error: "Unsupported or repeated activity filter." };
    seen.add(key);
  }
  const limitValue = params.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    return { ok: false, error: "Activity limit must be between 1 and 100." };
  }
  const since = parseTimestampFilter(params.get("since"));
  const until = parseTimestampFilter(params.get("until"));
  const assetId = params.get("assetId") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  const textFilters = ["agentId", "strategyId", "eventType", "runStatus"]
    .map((key) => params.get(key))
    .filter((value): value is string => value !== null);
  if (since === false || until === false ||
    (since !== undefined && until !== undefined && since > until) ||
    (assetId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) ||
    (cursor !== undefined && !isValidCursor(cursor)) ||
    textFilters.some((value) => value.length > 64 || !/^[a-zA-Z0-9._:-]*$/.test(value))) {
    return { ok: false, error: "Activity time range or asset filter is invalid." };
  }
  const value: Parameters<AgentMemoryStorePort["listActivity"]>[0] = {
    ownerAddress,
    limit,
    cursor,
    agentId: params.get("agentId") ?? undefined,
    strategyId: params.get("strategyId") ?? undefined,
    eventType: params.get("eventType") ?? undefined,
    runStatus: params.get("runStatus") ?? undefined,
    assetId,
    since,
    until,
  };
  return { ok: true, value };
}

function isValidCursor(value: string): boolean {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const [timestamp, eventId, extra] = Buffer.from(value, "base64url").toString("utf8").split("\n");
    return extra === undefined &&
      Number.isFinite(Date.parse(timestamp)) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId);
  } catch {
    return false;
  }
}

function parseTimestampFilter(value: string | null): number | undefined | false {
  if (value === null) return undefined;
  if (!/^(?:\d{10}|\d{13})$/.test(value)) return false;
  const parsed = Number(value);
  const milliseconds = value.length === 10 ? parsed * 1000 : parsed;
  return Number.isSafeInteger(milliseconds) ? milliseconds : false;
}

function isAgentRunRequest(value: unknown): value is Omit<AgentRunRequest, "ownerAddress"> {
  if (!isRecord(value) || !hasExactKeys(value, ["agentId", "watchlist", "strategyConfiguration"]) ||
    typeof value.agentId !== "string" || !Array.isArray(value.watchlist) ||
    !isRecord(value.strategyConfiguration) ||
    !hasExactKeys(value.strategyConfiguration, [
      "minimumAbsoluteSpreadPercent",
      "intendedAmount",
      "notionalValue",
      "maximumSlippageBps",
    ])) return false;
  const configuration = value.strategyConfiguration;
  return typeof configuration.minimumAbsoluteSpreadPercent === "number" &&
    typeof configuration.intendedAmount === "string" &&
    typeof configuration.notionalValue === "string" &&
    typeof configuration.maximumSlippageBps === "number" &&
    value.watchlist.every((item) => typeof item === "string");
}

function isRiskPolicy(value: unknown): value is RiskPolicy {
  return isRecord(value) && hasExactKeys(value, [
    "version",
    "approvedAssets",
    "approvedDirections",
    "maxOrderValue",
    "maxDailyExposure",
    "maxSlippageBps",
    "maxReferenceDeviationPercent",
    "allowedSessions",
    "minimumBalance",
    "quoteTtlMs",
    "permissionExpiresAt",
    "emergencyStop",
  ]);
}

async function readBoundedJson(request: Request):
  Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 400, error: "Content-Type must be application/json." };
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return { ok: false, status: Number(contentLength) > MAX_BODY_BYTES ? 413 : 400, error: "Request body is invalid or too large." };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "Request body must contain valid JSON." };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
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
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid UTF-8 JSON." };
  }
}

function storeErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof AgentMemoryStoreError) {
    const status = error.code === "NOT_FOUND" ? 404
      : error.code === "INVALID_TRANSITION" || error.code === "DUPLICATE" ? 409
        : error.code === "EMERGENCY_STOP" ? 423 : 503;
    return json({ error: fallback, code: error.code }, status);
  }
  console.error("Agent control-plane request failed.", error instanceof Error ? error.name : "UnknownError");
  return json({ error: fallback, code: "AGENT_CONTROL_UNAVAILABLE" }, 503);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(record).length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}
