import { createHash, randomUUID } from "node:crypto";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import {
  authorizeWeekendDefiRequest,
  fetchWeekendDefiCalendarTransition,
  jsonError,
  loadWeekendDefiSchedule,
  readMarketPulseGuard,
  readWeekendDefiRequestBody,
} from "@/services/weekendDefiRoutes";
import {
  evaluateWeekendDefiPlan,
  parseWeekendDefiConfig,
  type WeekendDefiAction,
} from "@/services/weekendDefiRebalancer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeWeekendDefiRequest(request);
  if (authorization.error) return authorization.error;
  const { session } = authorization;
  if (!session) return jsonError("A connected wallet session is required.", 401);

  let store: AgentMemoryStore | undefined;
  try {
    store = new AgentMemoryStore();
    await store.initialize();
    const schedules = await store.listSchedules(session.address, 100);
    return Response.json({
      schedules: schedules.filter((schedule) => schedule.strategyType === "WEEKEND_DEFI"),
      execution: "MANUAL_UNSIGNED_ONLY",
      autonomousMainnet: "BLOCKED",
      chainId: 56,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Weekend DeFi strategy listing failed:", error);
    return jsonError("Weekend DeFi strategy storage is unavailable.", 503);
  } finally {
    if (store) await store.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeWeekendDefiRequest(request);
  if (authorization.error) return authorization.error;
  const { session } = authorization;
  if (!session) return jsonError("A connected wallet session is required.", 401);

  const parsed = await readWeekendDefiRequestBody(request);
  if (parsed.error) return parsed.error;
  const { action } = parsed.body;
  if (action !== "CONFIGURE" && action !== "PREVIEW") {
    return jsonError("Action must be CONFIGURE or PREVIEW.", 422);
  }

  let store: AgentMemoryStore | undefined;
  try {
    store = new AgentMemoryStore();
    await store.initialize();

    if (action === "CONFIGURE") {
      return await configureStrategy(parsed.body, session.address, store);
    }

    const allowedKeys = ["action", "scheduleId", "operation"];
    if (Object.keys(parsed.body).length !== allowedKeys.length ||
      allowedKeys.some((key) => !Object.hasOwn(parsed.body, key)) ||
      (parsed.body.operation !== "DEPOSIT" && parsed.body.operation !== "REDEEM")) {
      return jsonError("Weekend DeFi preview parameters are invalid.", 422);
    }
    const schedule = await loadWeekendDefiSchedule({
      store,
      ownerAddress: session.address,
      scheduleId: parsed.body.scheduleId,
    });
    if (!schedule) return jsonError("An owner-scoped Weekend DeFi strategy was not found.", 404);
    const now = Date.now();
    const { current, previous } = await fetchWeekendDefiCalendarTransition(now);
    const guard = await readMarketPulseGuard(schedule.strategyConfig.guardTicker);
    const decision = evaluateWeekendDefiPlan({
      config: schedule.strategyConfig,
      action: parsed.body.operation as WeekendDefiAction,
      currentCalendar: current,
      previousCalendar: previous,
      now,
      sessionMismatch: guard.sessionMismatch,
    });
    if (guard.stale) {
      decision.warnings.push("The configured market-pulse row is stale; its status was not used as market-closure evidence.");
    }
    if (guard.sessionMismatch) {
      await store.recordAlert({
        ownerAddress: session.address,
        severity: "WARNING",
        kind: "WEEKEND_DEFI_SESSION_MISMATCH",
        message: "Market-pulse session mismatch observed; no capital deployment was triggered.",
        createdAt: now,
      });
    }
    return Response.json({
      previewOnly: true,
      transactionBuilt: false,
      transactionSubmitted: false,
      decision,
      redemptionNote: parsed.body.operation === "REDEEM"
        ? "Redemption remains an asynchronous request and is not guaranteed to settle by traditional market open."
        : null,
    }, { status: decision.allowed ? 200 : 409, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TypeError) return jsonError(error.message, 422);
    console.error("Weekend DeFi strategy request failed:", error);
    return jsonError("Weekend DeFi strategy processing is temporarily unavailable.", 503);
  } finally {
    if (store) await store.close();
  }
}

async function configureStrategy(
  body: Record<string, unknown>,
  ownerAddress: string,
  store: AgentMemoryStore,
): Promise<Response> {
  const allowedKeys = ["action", "scheduleId", "name", "intervalSeconds", "strategyConfig", "executionMode"];
  if (Object.keys(body).some((key) => !allowedKeys.includes(key)) ||
    !Object.hasOwn(body, "strategyConfig") ||
    (body.executionMode !== undefined && body.executionMode !== "MANUAL")) {
    return jsonError("Weekend DeFi configuration must use a valid manual-only strategy policy.", 422, {
      execution: "MANUAL_UNSIGNED_ONLY",
      chainId: 56,
    });
  }
  const strategyConfig = parseWeekendDefiConfig(body.strategyConfig);
  const schedules = await store.listSchedules(ownerAddress, 100);
  const existing = body.scheduleId === undefined
    ? undefined
    : schedules.find((schedule) =>
      schedule.scheduleId === body.scheduleId && schedule.strategyType === "WEEKEND_DEFI");
  if (body.scheduleId !== undefined && !existing) {
    return jsonError("The owner-scoped Weekend DeFi strategy was not found.", 404);
  }

  const name = body.name === undefined ? existing?.name : body.name;
  const intervalSeconds = body.intervalSeconds === undefined
    ? existing?.intervalSeconds
    : body.intervalSeconds;
  if (typeof name !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(name) ||
    typeof intervalSeconds !== "number" || !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 60 || intervalSeconds > 86_400) {
    return jsonError("A valid strategy name and intervalSeconds between 60 and 86400 are required.", 422);
  }
  const nameCollision = schedules.find((schedule) =>
    schedule.name === name && schedule.scheduleId !== existing?.scheduleId);
  if (nameCollision) {
    return jsonError("That schedule name is already used by another owner-scoped strategy.", 409);
  }

  const now = Date.now();
  const policyHash = createHash("sha256").update(JSON.stringify({
    strategyType: "WEEKEND_DEFI",
    executionMode: "MANUAL",
    strategyConfig,
  })).digest("hex");
  const result = await store.saveSchedule({
    ownerAddress,
    scheduleId: typeof existing?.scheduleId === "string" ? existing.scheduleId : randomUUID(),
    name,
    intervalSeconds,
    policyVersion: "weekend-defi-v1",
    policyHash,
    nextRunAt: now + intervalSeconds * 1000,
    strategyType: "WEEKEND_DEFI",
    executionMode: "MANUAL",
    strategyConfig,
    enabled: true,
    createdAt: typeof existing?.createdAt === "number" ? existing.createdAt : now,
    updatedAt: now,
  });
  return Response.json({
    scheduleId: result.scheduleId,
    strategyType: "WEEKEND_DEFI",
    executionMode: "MANUAL",
    execution: "MANUAL_UNSIGNED_ONLY",
    autonomousMainnet: "BLOCKED",
    policyHash,
  }, { status: existing ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
